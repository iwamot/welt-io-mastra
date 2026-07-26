import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  InterruptEvent,
  InterruptReason,
  RenderableEventsOptions,
} from "../src/index.ts";
import { renderableEvents } from "../src/index.ts";

async function* stream(
  chunks: readonly unknown[],
): AsyncGenerator<unknown, void, undefined> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function rendered(
  chunks: readonly unknown[],
  options?: RenderableEventsOptions,
) {
  return Array.fromAsync(renderableEvents(stream(chunks), options));
}

function mediaResult(parts: readonly unknown[]) {
  return { type: "content", value: parts };
}

function chunk(type: string, payload: unknown) {
  return { type, payload, runId: "run-1", from: "AGENT" };
}

function interruptOf(event: unknown): InterruptEvent["interrupt"] {
  return (event as InterruptEvent).interrupt;
}

describe("renderableEvents", () => {
  test("drops unrenderable chunks", async () => {
    const chunks = [
      null,
      "start",
      ["text-delta"],
      { type: "text-delta" },
      { type: "text-delta", payload: "hi" },
      chunk("start", {}),
      chunk("step-finish", { stepResult: { reason: "stop" } }),
      chunk("finish", { stepResult: { reason: "stop" } }),
      chunk("reasoning-delta", { text: "hmm" }),
      chunk("tool-output", {
        output: { file: { name: "a.txt", bytes: "aGk=" } },
        toolCallId: "t1",
        toolName: "my_tool",
      }),
    ];
    assert.deepEqual(await rendered(chunks, { filesFrom: ["my_tool"] }), []);
  });

  test("yields text chunks", async () => {
    const chunks = [chunk("text-delta", { id: "1", text: "Hello" })];
    assert.deepEqual(await rendered(chunks), [{ data: "Hello" }]);
  });

  test("drops empty or non-string text", async () => {
    const chunks = [
      chunk("text-delta", { text: "" }),
      chunk("text-delta", { text: 5 }),
    ];
    assert.deepEqual(await rendered(chunks), []);
  });

  test("slims tool calls to the tool-use indicator", async () => {
    const chunks = [
      chunk("tool-call", {
        toolCallId: "t1",
        toolName: "my_tool",
        args: { a: 1 },
      }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { current_tool_use: { toolUseId: "t1", name: "my_tool" } },
    ]);
  });

  test("nulls missing tool-call fields", async () => {
    const chunks = [chunk("tool-call", { toolCallId: 5 })];
    assert.deepEqual(await rendered(chunks), [
      { current_tool_use: { toolUseId: null, name: null } },
    ]);
  });

  test("slims tool results to the status", async () => {
    const chunks = [
      chunk("tool-result", {
        toolCallId: "t1",
        toolName: "my_tool",
        result: "big output",
      }),
      chunk("tool-result", { toolCallId: "t2", isError: true }),
      chunk("tool-result", { toolCallId: "t3", isError: "yes" }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { tool_result: { toolUseId: "t1", status: "success" } },
      { tool_result: { toolUseId: "t2", status: "error" } },
      { tool_result: { toolUseId: "t3", status: "success" } },
    ]);
  });

  test("maps tool errors to an error status", async () => {
    const chunks = [
      chunk("tool-error", { toolCallId: "t1", error: new Error("boom") }),
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
        result: mediaResult([
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
        result: mediaResult([
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
        result: mediaResult([
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

  test("drops tool results that carry no media parts", async () => {
    const chunks = [
      chunk("tool-result", { toolCallId: "t1", toolName: "t", result: "done" }),
      chunk("tool-result", {
        toolCallId: "t2",
        toolName: "t",
        result: { type: "json", value: { ok: true } },
      }),
      chunk("tool-result", {
        toolCallId: "t3",
        toolName: "t",
        result: { type: "content", value: "a media part" },
      }),
      chunk("tool-result", {
        toolCallId: "t4",
        toolName: "t",
        result: mediaResult([
          "media",
          { type: "text", text: "hi" },
          { type: "media", mediaType: "text/csv" },
          { type: "media", data: "", mediaType: "text/csv" },
          { type: "media", data: new Uint8Array([1]), mediaType: "text/csv" },
        ]),
      }),
    ];
    assert.deepEqual(await rendered(chunks, { filesFrom: ["t"] }), [
      { tool_result: { toolUseId: "t1", status: "success" } },
      { tool_result: { toolUseId: "t2", status: "success" } },
      { tool_result: { toolUseId: "t3", status: "success" } },
      { tool_result: { toolUseId: "t4", status: "success" } },
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

  const nameByMimeType: [string | undefined, string][] = [
    ["video/quicktime", "video.mov"],
    ["video/3gpp", "video.3gp"],
    ["audio/mpeg", "audio.mpeg"],
    ["text/plain", "file.txt"],
    ["text/markdown", "file.md"],
    ["application/pdf", "file.pdf"],
    ["image/svg+xml", "image.bin"],
    [undefined, "file.bin"],
  ];
  for (const [mimeType, name] of nameByMimeType) {
    test(`synthesizes a name from mime type ${mimeType}`, async () => {
      const chunks = [chunk("file", { data: "aGk=", mimeType })];
      assert.deepEqual(await rendered(chunks), [
        { file: { name, bytes: "aGk=" } },
      ]);
    });
  }

  test("drops empty or invalid file data", async () => {
    const chunks = [
      chunk("file", { data: "", mimeType: "image/png" }),
      chunk("file", { data: new Uint8Array(), mimeType: "image/png" }),
      chunk("file", { data: 5, mimeType: "image/png" }),
    ];
    assert.deepEqual(await rendered(chunks), []);
  });

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

  test("defaults a missing tool name to an empty string", async () => {
    const chunks = [chunk("tool-call-suspended", { toolCallId: "t1" })];
    assert.deepEqual(await rendered(chunks), [
      { interrupt: { id: "t1", name: "", reason: undefined } },
    ]);
  });

  test("drops interrupts without a tool call id", async () => {
    const chunks = [
      chunk("tool-call-suspended", { toolName: "deploy" }),
      chunk("tool-call-suspended", { toolCallId: "" }),
      chunk("tool-call-approval", { toolName: "deploy" }),
    ];
    assert.deepEqual(await rendered(chunks), []);
  });

  test("synthesizes an Approve/Deny reason for a tool-call approval", async () => {
    const chunks = [
      chunk("tool-call-approval", {
        toolCallId: "t1",
        toolName: "deploy",
        args: { env: "prod" },
      }),
    ];
    const events = await rendered(chunks);
    const interrupt = interruptOf(events[0]);
    assert.equal(interrupt.id, "t1");
    assert.equal(interrupt.name, "deploy");
    const reason = interrupt.reason as InterruptReason;
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
      }),
      chunk("tool-call-approval", {
        toolCallId: "t2",
        toolName: "deploy",
        args: "prod",
      }),
      chunk("tool-call-approval", {
        toolCallId: "t3",
        toolName: "deploy",
        args: { n: 1n },
      }),
      chunk("tool-call-approval", { toolCallId: "t4" }),
    ];
    const events = await rendered(chunks);
    assert.deepEqual(
      events.map(
        (event) => (interruptOf(event).reason as InterruptReason).message,
      ),
      [
        "May I run `deploy`?",
        "May I run `deploy`?",
        "May I run `deploy`?",
        "May I run this tool?",
      ],
    );
  });

  test("truncates an oversized args block", async () => {
    const chunks = [
      chunk("tool-call-approval", {
        toolCallId: "t1",
        toolName: "deploy",
        args: { text: "a".repeat(3000) },
      }),
    ];
    const events = await rendered(chunks);
    const message = (interruptOf(events[0]).reason as InterruptReason).message;
    assert.ok(message.endsWith("…\n```"));
    assert.ok(message.length < 1600);
  });

  test("builds a fresh approval reason per event", async () => {
    const chunks = [
      chunk("tool-call-approval", { toolCallId: "t1", toolName: "deploy" }),
      chunk("tool-call-approval", { toolCallId: "t2", toolName: "deploy" }),
    ];
    const events = await rendered(chunks);
    const first = interruptOf(events[0]).reason as InterruptReason;
    const second = interruptOf(events[1]).reason as InterruptReason;
    assert.notEqual(first.options, second.options);
    assert.notEqual(first.options?.[0], second.options?.[0]);
  });

  test("maps error chunks to error events", async () => {
    const chunks = [
      chunk("error", { error: "model exploded" }),
      chunk("error", { error: new Error("boom") }),
      chunk("error", { error: new Error("") }),
      chunk("error", { error: "" }),
      chunk("error", { error: 5 }),
      chunk("error", {}),
    ];
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
      chunk("tripwire", {}),
    ];
    assert.deepEqual(await rendered(chunks), [
      { error: "PII detected" },
      { error: "the reply was blocked by an output processor" },
    ]);
  });

  test("preserves stream order", async () => {
    const chunks = [
      chunk("text-delta", { text: "Let me check. " }),
      chunk("tool-call", { toolCallId: "t1", toolName: "current_time" }),
      chunk("tool-result", { toolCallId: "t1" }),
      chunk("text-delta", { text: "It is noon." }),
    ];
    assert.deepEqual(await rendered(chunks), [
      { data: "Let me check. " },
      { current_tool_use: { toolUseId: "t1", name: "current_time" } },
      { tool_result: { toolUseId: "t1", status: "success" } },
      { data: "It is noon." },
    ]);
  });
});
