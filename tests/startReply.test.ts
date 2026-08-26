import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AIV5Type } from "@mastra/core/agent/message-list";
import type { ChunkType } from "@mastra/core/stream";
import { ChunkFrom } from "@mastra/core/stream";
import type {
  AgentStream,
  JsonValue,
  RenderableEvent,
  StreamingAgent,
  WireMessage,
} from "../src/index.ts";
import { decodeMessages, renderableEvents, startReply } from "../src/index.ts";

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

/** Stream one reply and gather the events it renders. */
async function events(
  agent: StreamingAgent,
  payload: unknown,
  options?: { runId?: string; filesFrom?: Iterable<string> },
): Promise<RenderableEvent[]> {
  const collected: RenderableEvent[] = [];
  for await (const stream of startReply(agent, payload, {
    ...(options?.runId === undefined ? {} : { runId: options.runId }),
  })) {
    for await (const event of renderableEvents(stream.fullStream, {
      filesFrom: options?.filesFrom ?? [],
    })) {
      collected.push(event);
    }
  }
  return collected;
}

describe("startReply", () => {
  test("a turn streams the renderable events", async () => {
    const agent = new ReplayAgent(streamOf("r-1", [text("hi")]));

    assert.deepEqual(await events(agent, { messages: [] }), [{ data: "hi" }]);
  });

  test("a turn streams on the decoded messages", async () => {
    const agent = new ReplayAgent(streamOf("r-1", []));
    const messages: WireMessage[] = [
      { role: "user", content: [{ text: "hello" }] },
    ];

    await events(agent, { messages });

    assert.deepEqual(agent.streamed, [decodeMessages(messages)]);
  });

  test("a stop's questions end the reply", async () => {
    const agent = new ReplayAgent(streamOf("r-1", [suspended("t-1")]));

    const streamed = await events(agent, { messages: [] });

    const [only] = streamed;
    assert.ok(only !== undefined && "interrupt" in only);
    assert.equal(only.interrupt.id, "t-1");
  });

  test("a resume runs on the run id it was given", async () => {
    const agent = new ReplayAgent(streamOf("r-1", [text("resumed")]));

    const resumed = await events(
      agent,
      { interrupt_responses: { "t-1": { value: true, source: "option" } } },
      { runId: "r-1" },
    );

    assert.deepEqual(resumed, [{ data: "resumed" }]);
    assert.deepEqual(agent.resumed, [
      { answer: true, runId: "r-1", toolCallId: "t-1" },
    ]);
  });

  test("each answer of one resume payload resumes in payload order", async () => {
    const agent = new ReplayAgent(
      streamOf("r-1", []),
      streamOf("r-1", [text("done")]),
    );

    const replies = await events(
      agent,
      {
        interrupt_responses: {
          "t-1": { value: "Publish", source: "option" },
          "t-2": { value: false, source: "option" },
        },
      },
      { runId: "r-1" },
    );

    assert.deepEqual(replies, [{ data: "done" }]);
    assert.deepEqual(
      agent.resumed.map(({ toolCallId }) => toolCallId),
      ["t-1", "t-2"],
    );
  });

  test("a later answer's stream starts only once the last is drained", async () => {
    const agent = new ReplayAgent(
      streamOf("r-1", [text("first")]),
      streamOf("r-1", [text("second")]),
    );
    const seen: string[] = [];

    for await (const stream of startReply(
      agent,
      {
        interrupt_responses: {
          "t-1": { value: true, source: "option" },
          "t-2": { value: true, source: "option" },
        },
      },
      { runId: "r-1" },
    )) {
      seen.push(`started:${agent.resumed.length}`);
      await Array.fromAsync(
        renderableEvents(stream.fullStream, { filesFrom: [] }),
      );
    }

    assert.deepEqual(seen, ["started:1", "started:2"]);
  });

  test("answers without a run id to resume are refused", async () => {
    const agent = new ReplayAgent();

    await assert.rejects(
      events(agent, {
        interrupt_responses: { "t-1": { value: true, source: "option" } },
      }),
      /no runId to resume/,
    );
  });
});
