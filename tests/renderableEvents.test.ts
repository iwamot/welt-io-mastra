import { describe, expect, test } from "bun:test";
import type { InterruptEvent, InterruptReason } from "../src/index.ts";
import { fileEvent, renderableEvents } from "../src/index.ts";

async function* stream(
  chunks: readonly unknown[],
): AsyncGenerator<unknown, void, undefined> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function rendered(chunks: readonly unknown[]) {
  return Array.fromAsync(renderableEvents(stream(chunks)));
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
    ];
    expect(await rendered(chunks)).toEqual([]);
  });

  test("yields text chunks", async () => {
    const chunks = [chunk("text-delta", { id: "1", text: "Hello" })];
    expect(await rendered(chunks)).toEqual([{ data: "Hello" }]);
  });

  test("drops empty or non-string text", async () => {
    const chunks = [
      chunk("text-delta", { text: "" }),
      chunk("text-delta", { text: 5 }),
    ];
    expect(await rendered(chunks)).toEqual([]);
  });

  test("slims tool calls to the tool-use indicator", async () => {
    const chunks = [
      chunk("tool-call", {
        toolCallId: "t1",
        toolName: "my_tool",
        args: { a: 1 },
      }),
    ];
    expect(await rendered(chunks)).toEqual([
      { current_tool_use: { toolUseId: "t1", name: "my_tool" } },
    ]);
  });

  test("nulls missing tool-call fields", async () => {
    const chunks = [chunk("tool-call", { toolCallId: 5 })];
    expect(await rendered(chunks)).toEqual([
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
    expect(await rendered(chunks)).toEqual([
      { tool_result: { toolUseId: "t1", status: "success" } },
      { tool_result: { toolUseId: "t2", status: "error" } },
      { tool_result: { toolUseId: "t3", status: "success" } },
    ]);
  });

  test("maps tool errors to an error status", async () => {
    const chunks = [
      chunk("tool-error", { toolCallId: "t1", error: new Error("boom") }),
    ];
    expect(await rendered(chunks)).toEqual([
      { tool_result: { toolUseId: "t1", status: "error" } },
    ]);
  });

  test("passes through file events a tool writes to its stream", async () => {
    const written = fileEvent("report.csv", new TextEncoder().encode("a,b"));
    const chunks = [
      chunk("tool-output", { output: written, toolCallId: "t1" }),
    ];
    expect(await rendered(chunks)).toEqual([written]);
  });

  test("slims extra keys off a tool-written file event", async () => {
    const output = { file: { name: "a.txt", bytes: "aGk=", extra: 1 } };
    const chunks = [chunk("tool-output", { output, toolCallId: "t1" })];
    expect(await rendered(chunks)).toEqual([
      { file: { name: "a.txt", bytes: "aGk=" } },
    ]);
  });

  test("drops tool output that is not a file event", async () => {
    const chunks = [
      chunk("tool-output", { output: "progress: 50%", toolCallId: "t1" }),
      chunk("tool-output", { output: { file: "a.txt" }, toolCallId: "t1" }),
      chunk("tool-output", {
        output: { file: { name: "", bytes: "aGk=" } },
        toolCallId: "t1",
      }),
      chunk("tool-output", {
        output: { file: { name: "a.txt", bytes: 5 } },
        toolCallId: "t1",
      }),
      chunk("tool-output", {
        output: { file: { name: "a.txt" } },
        toolCallId: "t1",
      }),
    ];
    expect(await rendered(chunks)).toEqual([]);
  });

  test("yields a model-generated file with a synthesized name", async () => {
    const chunks = [
      chunk("file", { data: "aGk=", base64: "aGk=", mimeType: "image/png" }),
    ];
    expect(await rendered(chunks)).toEqual([
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
    expect(await rendered(chunks)).toEqual([
      { file: { name: "image.png", bytes: "aGk=" } },
    ]);
  });

  test.each([
    ["video/quicktime", "video.mov"],
    ["video/3gpp", "video.3gp"],
    ["audio/mpeg", "audio.mpeg"],
    ["text/plain", "file.txt"],
    ["text/markdown", "file.md"],
    ["application/pdf", "file.pdf"],
    ["image/svg+xml", "image.bin"],
    [undefined, "file.bin"],
  ])("synthesizes a name from mime type %p", async (mimeType, name) => {
    const chunks = [chunk("file", { data: "aGk=", mimeType })];
    expect(await rendered(chunks)).toEqual([{ file: { name, bytes: "aGk=" } }]);
  });

  test("drops empty or invalid file data", async () => {
    const chunks = [
      chunk("file", { data: "", mimeType: "image/png" }),
      chunk("file", { data: new Uint8Array(), mimeType: "image/png" }),
      chunk("file", { data: 5, mimeType: "image/png" }),
    ];
    expect(await rendered(chunks)).toEqual([]);
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
    expect(events).toEqual([
      { interrupt: { id: "t1", name: "deploy", reason } },
    ]);
    expect(interruptOf(events[0]).reason).toBe(reason);
  });

  test("defaults a missing tool name to an empty string", async () => {
    const chunks = [chunk("tool-call-suspended", { toolCallId: "t1" })];
    expect(await rendered(chunks)).toEqual([
      { interrupt: { id: "t1", name: "", reason: undefined } },
    ]);
  });

  test("drops interrupts without a tool call id", async () => {
    const chunks = [
      chunk("tool-call-suspended", { toolName: "deploy" }),
      chunk("tool-call-suspended", { toolCallId: "" }),
      chunk("tool-call-approval", { toolName: "deploy" }),
    ];
    expect(await rendered(chunks)).toEqual([]);
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
    expect(interrupt.id).toBe("t1");
    expect(interrupt.name).toBe("deploy");
    const reason = interrupt.reason as InterruptReason;
    expect(reason.message).toBe(
      'May I run `deploy`?\n```\n{\n  "env": "prod"\n}\n```',
    );
    expect(reason.options).toEqual([
      { value: "y", label: "Approve", style: "primary" },
      { value: "n", label: "Deny" },
    ]);
    expect(reason.input).toBeUndefined();
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
    expect(
      events.map(
        (event) => (interruptOf(event).reason as InterruptReason).message,
      ),
    ).toEqual([
      "May I run `deploy`?",
      "May I run `deploy`?",
      "May I run `deploy`?",
      "May I run this tool?",
    ]);
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
    expect(message).toEndWith("…\n```");
    expect(message.length).toBeLessThan(1600);
  });

  test("builds a fresh approval reason per event", async () => {
    const chunks = [
      chunk("tool-call-approval", { toolCallId: "t1", toolName: "deploy" }),
      chunk("tool-call-approval", { toolCallId: "t2", toolName: "deploy" }),
    ];
    const events = await rendered(chunks);
    const first = interruptOf(events[0]).reason as InterruptReason;
    const second = interruptOf(events[1]).reason as InterruptReason;
    expect(first.options).not.toBe(second.options);
    expect(first.options?.[0]).not.toBe(second.options?.[0]);
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
    expect(await rendered(chunks)).toEqual([
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
    expect(await rendered(chunks)).toEqual([
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
    expect(await rendered(chunks)).toEqual([
      { data: "Let me check. " },
      { current_tool_use: { toolUseId: "t1", name: "current_time" } },
      { tool_result: { toolUseId: "t1", status: "success" } },
      { data: "It is noon." },
    ]);
  });
});
