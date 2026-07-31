import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChunkType } from "@mastra/core/stream";
import { ChunkFrom } from "@mastra/core/stream";
import type {
  InterruptEvent,
  RenderableEventsOptions,
  ToolResultContent,
} from "../src/index.ts";
import { type interruptReason, renderableEvents } from "../src/index.ts";

/** The reason shape an interrupt event carries, which is what it builds. */
type InterruptReason = ReturnType<typeof interruptReason>;

type PayloadChunk = Extract<ChunkType, { payload: unknown }>;

/**
 * Build one stream chunk.
 *
 * The only cast in this file: the payload is checked against the union
 * member its `type` names, so what these tests feed the reduction is what
 * Mastra declares it yields — `ChunkFrom` is Mastra's own enum, so the
 * envelope is real too.
 */
function chunk<T extends PayloadChunk["type"]>(
  type: T,
  payload: Extract<PayloadChunk, { type: T }>["payload"],
): ChunkType {
  return { type, payload, runId: "run-1", from: ChunkFrom.AGENT } as ChunkType;
}

async function* stream(
  chunks: readonly ChunkType[],
): AsyncGenerator<ChunkType, void, undefined> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function rendered(
  chunks: readonly ChunkType[],
  options?: RenderableEventsOptions,
) {
  return Array.fromAsync(renderableEvents(stream(chunks), options));
}

function content(parts: ToolResultContent["value"]): ToolResultContent {
  return { type: "content", value: parts };
}

function interruptOf(event: unknown): InterruptEvent["interrupt"] {
  return (event as InterruptEvent).interrupt;
}

function reasonOf(event: unknown): InterruptReason {
  return interruptOf(event).reason as InterruptReason;
}

/**
 * Collect the process warnings this package emits while `run` runs.
 *
 * `process.emitWarning` is how a Node package says something the caller
 * should know without failing the run, and a listener is how a test reads
 * it back — the emission lands on the next tick, so the wait is what makes
 * it observable.
 */
async function warningsOf(run: () => Promise<void>): Promise<string[]> {
  const collected: string[] = [];
  const capture = (warning: Error) => {
    if (warning.name === "WeltWarning") {
      collected.push(warning.message);
    }
  };
  process.on("warning", capture);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", capture);
  }
  return collected;
}

describe("renderableEvents", () => {
  test("drops the chunks Welt does not render", async () => {
    const chunks = [
      chunk("start", {}),
      chunk("text-start", { id: "1" }),
      chunk("text-end", { id: "1" }),
      chunk("reasoning-delta", { id: "1", text: "hmm" }),
      chunk("raw", { value: 1 }),
      chunk("abort", {}),
    ];
    assert.deepEqual(await rendered(chunks), []);
  });

  test("yields text chunks", async () => {
    const chunks = [chunk("text-delta", { id: "1", text: "Hello" })];
    assert.deepEqual(await rendered(chunks), [{ data: "Hello" }]);
  });

  test("drops an empty text delta, which Welt cannot render", async () => {
    const chunks = [chunk("text-delta", { id: "1", text: "" })];
    assert.deepEqual(await rendered(chunks), []);
  });

  test("slims tool calls to the tool-use indicator", async () => {
    const chunks = [
      chunk("tool-call", { toolCallId: "t1", toolName: "my_tool" }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { current_tool_use: { toolUseId: "t1", name: "my_tool" } },
    ]);
  });

  test("slims tool results to the status", async () => {
    const chunks = [
      chunk("tool-result", {
        toolCallId: "t1",
        toolName: "my_tool",
        result: "big output",
      }),
      chunk("tool-result", {
        toolCallId: "t2",
        toolName: "my_tool",
        result: "boom",
        isError: true,
      }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { tool_result: { toolUseId: "t1", status: "success" } },
      { tool_result: { toolUseId: "t2", status: "error" } },
    ]);
  });

  test("maps tool errors to an error status", async () => {
    const chunks = [
      chunk("tool-error", {
        toolCallId: "t1",
        toolName: "my_tool",
        error: new Error("boom"),
      }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { tool_result: { toolUseId: "t1", status: "error" } },
    ]);
  });

  test("yields the files of a tool named in filesFrom", async () => {
    const chunks = [
      chunk("tool-result", {
        toolCallId: "t1",
        toolName: "create_sample_file",
        result: content([
          { type: "text", text: "Created sample.csv." },
          {
            type: "media",
            data: "YSxi",
            mediaType: "text/csv",
            filename: "sample.csv",
          },
        ]),
      }),
    ];
    assert.deepEqual(
      await rendered(chunks, { filesFrom: ["create_sample_file"] }),
      [
        { tool_result: { toolUseId: "t1", status: "success" } },
        { file: { name: "sample.csv", bytes: "YSxi" } },
      ],
    );
  });

  test("keeps the files of a tool left out of filesFrom off the wire", async () => {
    const chunks = [
      chunk("tool-result", {
        toolCallId: "t1",
        toolName: "file_read",
        result: content([
          { type: "media", data: "YSxi", mediaType: "application/pdf" },
        ]),
      }),
    ];
    const only = {
      tool_result: { toolUseId: "t1", status: "success" },
    } as const;
    assert.deepEqual(
      await rendered(chunks, { filesFrom: ["create_sample_file"] }),
      [only],
    );
    assert.deepEqual(await rendered(chunks, { filesFrom: new Set<string>() }), [
      only,
    ]);
    assert.deepEqual(await rendered(chunks), [only]);
  });

  test("names a file from its media type when the tool leaves it off", async () => {
    const chunks = [
      chunk("tool-result", {
        toolCallId: "t1",
        toolName: "draft",
        result: content([
          { type: "media", data: "IyBoaQ==", mediaType: "text/markdown" },
          { type: "media", data: "aGk=", mediaType: "image/png", filename: "" },
        ]),
      }),
    ];
    assert.deepEqual(
      await rendered(chunks, { filesFrom: new Set(["draft"]) }),
      [
        { tool_result: { toolUseId: "t1", status: "success" } },
        { file: { name: "file.md", bytes: "IyBoaQ==" } },
        { file: { name: "image.png", bytes: "aGk=" } },
      ],
    );
  });

  test("takes no file from a result that is not tool-result content", async () => {
    // A tool returns whatever it likes, so this is the one reply shape that
    // has to be recognized rather than read.
    const results: unknown[] = [
      "done",
      null,
      ["a media part"],
      { type: "json", value: { ok: true } },
      { type: "content", value: "a media part" },
      content([{ type: "text", text: "hi" }]),
      { type: "content", value: ["media", { type: "media" }] },
      { type: "content", value: [{ type: "media", data: 5 }] },
    ];
    const chunks = results.map((result, index) =>
      chunk("tool-result", { toolCallId: `t${index}`, toolName: "t", result }),
    );
    assert.deepEqual(
      await rendered(chunks, { filesFrom: ["t"] }),
      results.map((_, index) => ({
        tool_result: { toolUseId: `t${index}`, status: "success" },
      })),
    );
  });

  test("names a media part with no media type at all", async () => {
    const chunks = [
      chunk("tool-result", {
        toolCallId: "t1",
        toolName: "t",
        result: { type: "content", value: [{ type: "media", data: "aGk=" }] },
      }),
    ];
    assert.deepEqual(await rendered(chunks, { filesFrom: ["t"] }), [
      { tool_result: { toolUseId: "t1", status: "success" } },
      { file: { name: "file.bin", bytes: "aGk=" } },
    ]);
  });

  test("keeps a file with no bytes off the wire", async () => {
    const chunks = [
      chunk("tool-result", {
        toolCallId: "t1",
        toolName: "create_sample_file",
        result: content([
          {
            type: "media",
            data: "",
            mediaType: "text/csv",
            filename: "sample.csv",
          },
        ]),
      }),
    ];
    let events: unknown;
    const warnings = await warningsOf(async () => {
      events = await rendered(chunks, { filesFrom: ["create_sample_file"] });
    });
    assert.deepEqual(events, [
      { tool_result: { toolUseId: "t1", status: "success" } },
    ]);
    // Slack refuses a zero-byte upload and fails the whole reply with it,
    // so the warning names the tool that returned the file — which the
    // filename alone would not say.
    assert.deepEqual(warnings, [
      "Skipped an empty file from create_sample_file: sample.csv",
    ]);
  });

  test("takes no file from one that points at its bytes by URL", async () => {
    // Mastra leaves `base64` unset for a URL string, which is how a
    // pointer is told from bytes. There is nothing to upload from one,
    // and nothing worth saying about it either.
    const chunks = [
      chunk("file", {
        data: "https://example.com/generated.png",
        mimeType: "image/png",
      }),
    ];
    let events: unknown;
    const warnings = await warningsOf(async () => {
      events = await rendered(chunks);
    });
    assert.deepEqual(events, []);
    assert.deepEqual(warnings, []);
  });

  test("warns against the model for an empty file the model returned", async () => {
    const chunks = [
      chunk("file", { data: new Uint8Array(), mimeType: "image/png" }),
    ];
    let events: unknown;
    const warnings = await warningsOf(async () => {
      events = await rendered(chunks);
    });
    assert.deepEqual(events, []);
    assert.deepEqual(warnings, [
      "Skipped an empty file from the model: image.png",
    ]);
  });

  test("yields a model-generated file with a synthesized name", async () => {
    const chunks = [
      chunk("file", { data: "aGk=", base64: "aGk=", mimeType: "image/png" }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { file: { name: "image.png", bytes: "aGk=" } },
    ]);
  });

  test("base64-encodes binary file data", async () => {
    const chunks = [
      chunk("file", {
        data: new TextEncoder().encode("hi"),
        mimeType: "image/png",
      }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { file: { name: "image.png", bytes: "aGk=" } },
    ]);
  });

  const nameByMimeType: [string, string][] = [
    ["video/quicktime", "video.mov"],
    ["video/3gpp", "video.3gp"],
    ["audio/mpeg", "audio.mpeg"],
    ["text/plain", "file.txt"],
    ["text/markdown", "file.md"],
    ["application/pdf", "file.pdf"],
    ["image/svg+xml", "image.bin"],
    ["", "file.bin"],
  ];
  for (const [mimeType, name] of nameByMimeType) {
    test(`synthesizes the name ${name} from the media type ${mimeType}`, async () => {
      const chunks = [
        chunk("file", { data: "aGk=", base64: "aGk=", mimeType }),
      ];
      assert.deepEqual(await rendered(chunks), [
        { file: { name, bytes: "aGk=" } },
      ]);
    });
  }

  test("maps a suspended tool call to an interrupt, reason passed through", async () => {
    const reason = { message: "Deploy?", options: [{ value: "y" }] };
    const chunks = [
      chunk("tool-call-suspended", {
        toolCallId: "t1",
        toolName: "deploy",
        suspendPayload: reason,
        args: {},
        resumeSchema: "{}",
      }),
    ];
    const events = await rendered(chunks);
    assert.deepEqual(events, [
      { interrupt: { id: "t1", name: "deploy", reason } },
    ]);
    assert.equal(interruptOf(events[0]).reason, reason);
  });

  test("synthesizes an Approve/Deny reason for a tool-call approval", async () => {
    const chunks = [
      chunk("tool-call-approval", {
        toolCallId: "t1",
        toolName: "deploy",
        args: { env: "prod" },
        resumeSchema: "{}",
      }),
    ];
    const events = await rendered(chunks);
    assert.equal(interruptOf(events[0]).id, "t1");
    assert.equal(interruptOf(events[0]).name, "deploy");
    const reason = reasonOf(events[0]);
    assert.equal(
      reason.message,
      'May I run `deploy`?\n```\n{\n  "env": "prod"\n}\n```',
    );
    assert.deepEqual(reason.options, [
      { value: "y", label: "Approve", style: "primary" },
      { value: "n", label: "Deny" },
    ]);
    assert.equal(reason.input, undefined);
  });

  test("omits the args block when there is nothing to render", async () => {
    const chunks = [
      chunk("tool-call-approval", {
        toolCallId: "t1",
        toolName: "deploy",
        args: {},
        resumeSchema: "{}",
      }),
      chunk("tool-call-approval", {
        toolCallId: "t2",
        toolName: "deploy",
        args: { n: 1n },
        resumeSchema: "{}",
      }),
      chunk("tool-call-approval", {
        toolCallId: "t3",
        toolName: "",
        args: {},
        resumeSchema: "{}",
      }),
    ];
    const events = await rendered(chunks);
    assert.deepEqual(
      events.map((event) => reasonOf(event).message),
      ["May I run `deploy`?", "May I run `deploy`?", "May I run this tool?"],
    );
  });

  test("truncates an oversized args block", async () => {
    const chunks = [
      chunk("tool-call-approval", {
        toolCallId: "t1",
        toolName: "deploy",
        args: { text: "a".repeat(3000) },
        resumeSchema: "{}",
      }),
    ];
    const message = reasonOf((await rendered(chunks))[0]).message;
    assert.ok(message.endsWith("…\n```"));
    assert.ok(message.length < 1600);
  });

  test("builds a fresh approval reason per event", async () => {
    const approval = (toolCallId: string) =>
      chunk("tool-call-approval", {
        toolCallId,
        toolName: "deploy",
        args: {},
        resumeSchema: "{}",
      });
    const events = await rendered([approval("t1"), approval("t2")]);
    const first = reasonOf(events[0]);
    const second = reasonOf(events[1]);
    assert.notEqual(first.options, second.options);
    assert.notEqual(first.options?.[0], second.options?.[0]);
  });

  test("maps error chunks to error events", async () => {
    const errors: unknown[] = [
      "model exploded",
      new Error("boom"),
      new Error(""),
      "",
      5,
      undefined,
    ];
    const chunks = errors.map((error) => chunk("error", { error }));
    assert.deepEqual(await rendered(chunks), [
      { error: "model exploded" },
      { error: "boom" },
      { error: "unknown error" },
      { error: "unknown error" },
      { error: "unknown error" },
      { error: "unknown error" },
    ]);
  });

  test("maps tripwire chunks to error events", async () => {
    const chunks = [
      chunk("tripwire", { reason: "PII detected" }),
      chunk("tripwire", { reason: "" }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { error: "PII detected" },
      { error: "the reply was blocked by an output processor" },
    ]);
  });

  test("preserves stream order", async () => {
    const chunks = [
      chunk("text-delta", { id: "1", text: "Let me check. " }),
      chunk("tool-call", { toolCallId: "t1", toolName: "current_time" }),
      chunk("tool-result", {
        toolCallId: "t1",
        toolName: "current_time",
        result: "noon",
      }),
      chunk("text-delta", { id: "2", text: "It is noon." }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { data: "Let me check. " },
      { current_tool_use: { toolUseId: "t1", name: "current_time" } },
      { tool_result: { toolUseId: "t1", status: "success" } },
      { data: "It is noon." },
    ]);
  });
});
