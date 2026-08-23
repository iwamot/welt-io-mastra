import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test } from "node:test";
import type { AIV5Type } from "@mastra/core/agent/message-list";
import type { ChunkType } from "@mastra/core/stream";
import { ChunkFrom } from "@mastra/core/stream";
import type { AgentStream, StreamingAgent } from "../src/agentcore.ts";
import { sendFile, weltAgent } from "../src/agentcore.ts";
import type { JsonValue, WireMessage } from "../src/index.ts";
import { decodeMessages } from "../src/index.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

type PayloadChunk = Extract<ChunkType, { payload: unknown }>;

/**
 * Build one stream chunk.
 *
 * The only cast in this file: the payload is checked against the union
 * member its `type` names, so what these tests feed the handler is what
 * Mastra declares it yields — `ChunkFrom` is Mastra's own enum, so the
 * envelope is real too.
 */
function chunk<T extends PayloadChunk["type"]>(
  type: T,
  payload: Extract<PayloadChunk, { type: T }>["payload"],
): ChunkType<unknown> {
  return {
    type,
    payload,
    runId: "run-1",
    from: ChunkFrom.AGENT,
  } as ChunkType<unknown>;
}

function text(t: string): ChunkType<unknown> {
  return chunk("text-delta", { id: "1", text: t });
}

function suspended(toolCallId: string): ChunkType<unknown> {
  return chunk("tool-call-suspended", {
    toolCallId,
    toolName: "approval",
    suspendPayload: { message: "Go?" },
    args: {},
    resumeSchema: "{}",
  });
}

/** Build one agent stream that replays scripted chunks. */
function streamOf(
  runId: string,
  chunks: readonly ChunkType<unknown>[],
): AgentStream {
  return {
    runId,
    fullStream: (async function* () {
      for (const one of chunks) {
        yield one;
      }
    })(),
  };
}

/**
 * A Mastra-shaped agent that replays scripted streams, one per call.
 *
 * Constructed input data, not a mock: it holds the streams to hand out
 * and the inputs it was driven with, and verifies nothing itself.
 */
class ReplayAgent implements StreamingAgent {
  readonly streamed: AIV5Type.ModelMessage[][] = [];
  readonly resumed: { answer: JsonValue; runId: string; toolCallId: string }[] =
    [];
  private readonly scripts: AgentStream[];

  constructor(...scripts: AgentStream[]) {
    this.scripts = scripts;
  }

  async stream(messages: AIV5Type.ModelMessage[]): Promise<AgentStream> {
    this.streamed.push(messages);
    return this.next();
  }

  async resumeStream(
    answer: JsonValue,
    options: { runId: string; toolCallId: string },
  ): Promise<AgentStream> {
    this.resumed.push({ answer, ...options });
    return this.next();
  }

  private next(): AgentStream {
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error("no scripted stream left");
    }
    return script;
  }
}

function frames(handler: ReturnType<typeof weltAgent>, payload: unknown) {
  return Array.fromAsync(handler.process(payload));
}

describe("weltAgent", () => {
  test("a turn streams the renderable events as SSE frames", async () => {
    const agent = new ReplayAgent(streamOf("r-1", [text("hi")]));

    const handler = weltAgent(agent);

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "hi" } },
    ]);
  });

  test("a turn runs on the decoded messages", async () => {
    const agent = new ReplayAgent(streamOf("r-1", []));
    const messages: WireMessage[] = [
      { role: "user", content: [{ text: "hello" }] },
    ];

    await frames(weltAgent(agent), { messages });

    assert.deepEqual(agent.streamed, [decodeMessages(messages)]);
  });

  test("each turn streams fresh", async () => {
    const agent = new ReplayAgent(
      streamOf("r-1", [text("one")]),
      streamOf("r-2", [text("two")]),
    );

    const handler = weltAgent(agent);
    await frames(handler, { messages: [] });
    await frames(handler, { messages: [] });

    assert.equal(agent.streamed.length, 2);
    assert.equal(agent.resumed.length, 0);
  });

  test("a file a tool queued rides beside the reply", async () => {
    const agent = new ReplayAgent({
      runId: "r-1",
      fullStream: (async function* () {
        yield text("before");
        sendFile("chart.png", PNG_BYTES);
        yield text("after");
      })(),
    });

    const handler = weltAgent(agent, { filesFrom: ["some_tool"] });

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "before" } },
      { data: { data: "after" } },
      { data: { file: { name: "chart.png", bytes: PNG_BASE64 } } },
    ]);
  });

  test("a file queued after the last event still rides the reply", async () => {
    const agent = new ReplayAgent({
      runId: "r-1",
      fullStream: (async function* () {
        yield text("before");
        sendFile("chart.png", PNG_BYTES);
      })(),
    });

    assert.deepEqual(await frames(weltAgent(agent), { messages: [] }), [
      { data: { data: "before" } },
      { data: { file: { name: "chart.png", bytes: PNG_BASE64 } } },
    ]);
  });

  test("a failed turn's leftover files stay off the next reply", async () => {
    sendFile("stale.txt", new Uint8Array([1]));
    const agent = new ReplayAgent(streamOf("r-1", [text("fresh")]));

    assert.deepEqual(await frames(weltAgent(agent), { messages: [] }), [
      { data: { data: "fresh" } },
    ]);
  });

  test("resume without an interrupted run is refused", async () => {
    const handler = weltAgent(new ReplayAgent());

    await assert.rejects(
      frames(handler, { interrupt_responses: {} }),
      /No interrupted run to resume/,
    );
  });

  test("an interrupted run resumes by its run id and tool call", async () => {
    const agent = new ReplayAgent(
      streamOf("r-1", [suspended("t-1")]),
      streamOf("r-1", [text("resumed")]),
    );

    const handler = weltAgent(agent);
    const first = await frames(handler, { messages: [] });
    const second = await frames(handler, {
      interrupt_responses: { "t-1": { value: true, source: "option" } },
    });

    assert.deepEqual(first, [
      {
        data: {
          interrupt: {
            id: "t-1",
            name: "approval",
            reason: { message: "Go?" },
          },
        },
      },
    ]);
    assert.deepEqual(second, [{ data: { data: "resumed" } }]);
    assert.deepEqual(agent.resumed, [
      { answer: true, runId: "r-1", toolCallId: "t-1" },
    ]);
    // The resume ran on the stashed run, not a fresh turn.
    assert.equal(agent.streamed.length, 1);
  });

  test("each answer of one resume payload resumes in payload order", async () => {
    const agent = new ReplayAgent(
      streamOf("r-1", [suspended("t-1"), suspended("t-2")]),
      streamOf("r-1", []),
      streamOf("r-1", [text("done")]),
    );

    const handler = weltAgent(agent);
    await frames(handler, { messages: [] });
    const replies = await frames(handler, {
      interrupt_responses: {
        "t-1": { value: "Publish", source: "option" },
        "t-2": { value: false, source: "option" },
      },
    });

    assert.deepEqual(replies, [{ data: { data: "done" } }]);
    assert.deepEqual(
      agent.resumed.map(({ toolCallId }) => toolCallId),
      ["t-1", "t-2"],
    );
  });

  test("the slot empties once resumed", async () => {
    const agent = new ReplayAgent(
      streamOf("r-1", [suspended("t-1")]),
      streamOf("r-1", [text("resumed")]),
    );

    const handler = weltAgent(agent);
    await frames(handler, { messages: [] });
    await frames(handler, {
      interrupt_responses: { "t-1": { value: true, source: "option" } },
    });

    await assert.rejects(
      frames(handler, {
        interrupt_responses: { "t-1": { value: true, source: "option" } },
      }),
      /No interrupted run to resume/,
    );
  });

  test("a resume that interrupts again can resume again", async () => {
    const agent = new ReplayAgent(
      streamOf("r-1", [suspended("t-1")]),
      streamOf("r-2", [suspended("t-2")]),
      streamOf("r-2", [text("done")]),
    );

    const handler = weltAgent(agent);
    await frames(handler, { messages: [] });
    await frames(handler, {
      interrupt_responses: { "t-1": { value: true, source: "option" } },
    });
    const third = await frames(handler, {
      interrupt_responses: { "t-2": { value: true, source: "option" } },
    });

    assert.deepEqual(third, [{ data: { data: "done" } }]);
    // The re-stash keeps the resumed stream's own run id.
    assert.deepEqual(
      agent.resumed.map(({ runId }) => runId),
      ["r-1", "r-2"],
    );
  });
});

describe("sendFile", () => {
  test("a name that is not a string is refused", () => {
    assert.throws(
      () => sendFile(1 as unknown as string, PNG_BYTES),
      /name must be a string, not number/,
    );
  });

  test("an empty name is refused", () => {
    assert.throws(() => sendFile("", PNG_BYTES), /name must not be empty/);
  });

  test("data that is not a Uint8Array is refused", () => {
    assert.throws(
      () => sendFile("chart.png", "bytes" as unknown as Uint8Array),
      /data must be a Uint8Array/,
    );
  });

  test("empty data is refused", () => {
    assert.throws(
      () => sendFile("chart.png", new Uint8Array()),
      /data must not be empty/,
    );
  });

  test("a refused file is not queued", async () => {
    assert.throws(() => sendFile("chart.png", new Uint8Array()));
    const agent = new ReplayAgent(streamOf("r-1", [text("clean")]));

    assert.deepEqual(await frames(weltAgent(agent), { messages: [] }), [
      { data: { data: "clean" } },
    ]);
  });
});
