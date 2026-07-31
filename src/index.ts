/**
 * The Mastra (TypeScript) adapter for Welt's wire contract.
 *
 * Welt (https://github.com/iwamot/welt) drives an agent over plain JSON:
 * Converse-shaped `messages` (or `interrupt_responses` answering an
 * interrupted run) in, a stream of renderable events out. Plain Mastra
 * values fit that wire in neither direction: a Mastra agent consumes AI
 * SDK model messages rather than Converse content blocks, and its stream
 * chunks carry shapes Welt does not render. Each function here adapts one
 * piece, keeping the host app a thin loop around `Agent.stream()` and
 * `Agent.resumeStream()`.
 *
 * What Welt sends is taken as correct. Welt builds the payload and checks
 * its own output against the wire contract before releasing it, so a
 * payload that departs from the contract is a bug on the sending side, not
 * an input to guard against — the inbound parameter types say what
 * arrives, and a value that is not it surfaces as an ordinary error from
 * whatever touches it first. What this adapter checks is the other thing:
 * the values its own caller passes to `interruptReason`, since Welt
 * renders a reason it cannot match as its default buttons, silently.
 *
 * The reply stream is read as what Mastra's types say it is: `fullStream`
 * yields a closed union of chunks, so each one is read for what it is
 * rather than guarded against shapes Mastra does not produce. Only what
 * Welt reads goes on the wire — an event carrying more than that costs
 * bandwidth for something the renderer discards, and an event with nothing
 * to render is not sent at all.
 */

import { Buffer } from "node:buffer";
import type { AIV5Type } from "@mastra/core/agent/message-list";
import type { ChunkType } from "@mastra/core/stream";

// The `type` of the warnings this package emits, which a
// `process.on("warning", ...)` listener reads as the warning's `name`.
const WARNING_TYPE = "WeltWarning";

// The inbound shapes, as far as the decoding below reads them. The format
// tokens are Converse's, which is what the wire carries; each maps to the
// media type an AI SDK part takes instead.
type WireImageFormat = "gif" | "jpeg" | "png" | "webp";
type WireDocumentFormat =
  | "csv"
  | "doc"
  | "docx"
  | "html"
  | "md"
  | "pdf"
  | "txt"
  | "xls"
  | "xlsx";
type WireVideoFormat =
  | "flv"
  | "mkv"
  | "mov"
  | "mp4"
  | "mpeg"
  | "mpg"
  | "three_gp"
  | "webm"
  | "wmv";

interface WireSource {
  bytes: string;
}

interface WireTextBlock {
  text: string;
}

type WireUserBlock =
  | WireTextBlock
  | { image: { format: WireImageFormat; source: WireSource } }
  | {
      document: {
        name: string;
        format: WireDocumentFormat;
        source: WireSource;
      };
    }
  | { video: { format: WireVideoFormat; source: WireSource } };

/** One Converse-shaped message of Welt's payload. */
export type WireMessage =
  | { role: "user"; content: WireUserBlock[] }
  | { role: "assistant"; content: WireTextBlock[] };

// Total maps: the wire carries these format tokens and no others.
const IMAGE_MEDIA_TYPES: Readonly<Record<WireImageFormat, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const DOCUMENT_MEDIA_TYPES: Readonly<Record<WireDocumentFormat, string>> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  md: "text/markdown",
  pdf: "application/pdf",
  txt: "text/plain",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const VIDEO_MEDIA_TYPES: Readonly<Record<WireVideoFormat, string>> = {
  flv: "video/x-flv",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  three_gp: "video/3gpp",
  webm: "video/webm",
  wmv: "video/x-ms-wmv",
};

type UserPart = Exclude<
  Extract<AIV5Type.ModelMessage, { role: "user" }>["content"],
  string
>[number];

/**
 * Decode Welt's Converse-shaped messages into AI SDK model messages.
 *
 * Strands consumes Welt's messages as-is, but Mastra does not: its agents
 * take AI SDK model messages, whose file parts carry a media type instead
 * of a Converse format token, and whose base64 data needs no decoding.
 * Each message is rebuilt — text blocks become text parts, image blocks
 * image parts, and document and video blocks file parts. The result feeds
 * `Agent.stream()`.
 *
 * @param messages - The `messages` value of Welt's payload.
 * @returns Model messages for `Agent.stream()`.
 */
export function decodeMessages(
  messages: readonly WireMessage[],
): AIV5Type.ModelMessage[] {
  return messages.map(decodedMessage);
}

function decodedMessage(message: WireMessage): AIV5Type.ModelMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map(({ text }) => ({ type: "text", text })),
    };
  }
  return { role: "user", content: message.content.map(userPart) };
}

// The base64 travels on as it arrived: an AI SDK part takes the string
// itself, so nothing here decodes it, and nothing here has to judge it —
// whatever refuses invalid base64 downstream is the one that decodes.
function userPart(block: WireUserBlock): UserPart {
  if ("text" in block) {
    return { type: "text", text: block.text };
  }
  if ("image" in block) {
    const { format, source } = block.image;
    return {
      type: "image",
      image: source.bytes,
      mediaType: IMAGE_MEDIA_TYPES[format],
    };
  }
  if ("document" in block) {
    const { name, format, source } = block.document;
    return {
      type: "file",
      data: source.bytes,
      mediaType: DOCUMENT_MEDIA_TYPES[format],
      // The document's handle for the model, which is what Welt sends it
      // under; a video block carries no name to pass on.
      filename: name,
    };
  }
  const { format, source } = block.video;
  return {
    type: "file",
    data: source.bytes,
    mediaType: VIDEO_MEDIA_TYPES[format],
  };
}

/** One decoded interrupt answer: the suspended tool call and the human's answer. */
export interface InterruptResponse {
  toolCallId: string;
  answer: string;
}

/**
 * Decode Welt's interrupt answers into Mastra resume inputs.
 *
 * Welt resumes an interrupted run with a payload mapping each interrupt
 * id to the answer a human chose in the thread. `renderableEvents` uses
 * the suspended tool call's id as the interrupt id, so each entry here
 * feeds one `Agent.resumeStream(answer, { runId, toolCallId })` call.
 *
 * @param responses - The `interrupt_responses` value of Welt's payload.
 * @returns One entry per answered interrupt, in payload order.
 */
export function decodeInterruptResponses(
  responses: Readonly<Record<string, string>>,
): InterruptResponse[] {
  return Object.entries(responses).map(([toolCallId, answer]) => ({
    toolCallId,
    answer,
  }));
}

/** A `file` wire event: a filename plus base64 bytes Welt uploads to Slack. */
export interface FileEvent {
  file: { name: string; bytes: string };
}

// Type aliases, not interfaces: an alias gets an implicit index signature,
// so a reason fits a suspend payload as-is.

/** One button of a structured interrupt reason. */
export type OptionSpec = {
  value: string;
  label?: string;
  style?: "primary" | "danger";
};

/** The free-text field of a structured interrupt reason. */
export type InputSpec = {
  label?: string;
  multiline?: boolean;
};

/** The structured interrupt reason shape Welt renders as widgets. */
type InterruptReason = {
  message: string;
  options?: OptionSpec[];
  input?: InputSpec;
};

const OPTION_KEYS = ["value", "label", "style"];
const INPUT_KEYS = ["label", "multiline"];

/**
 * Build an interrupt reason that Welt renders as the specified widgets.
 *
 * Welt renders this shape as `message` followed by one button per option
 * (`options`), a free-text field whose submitted text becomes the
 * interrupt's response (`input`), or both — whichever answer comes
 * first, a pressed button or the submitted text, settles the question.
 *
 * Building the reason through this helper is what makes a typo an error.
 * A tool that declares no `suspendSchema` takes its suspend payload as
 * `unknown`, so an object literal handed to `suspend` directly is checked
 * by nothing, and Welt's reaction to a reason it cannot match is its
 * default Approve / Deny buttons — no error, no log, just widgets the
 * author did not ask for. The typed parameters here catch a misspelled key
 * before the run, and the checks below catch it in the runs the types
 * miss: TypeScript's excess-property check fires on an object literal
 * written at the call site, and not on one that reached it through a
 * variable.
 *
 * What is checked is the shape, not the size: Welt's own rendering caps
 * (how many buttons one Slack block holds, how long a button value may
 * be) are Welt's to enforce, and a copy of them here would be four copies
 * to keep in step with a number only Welt knows.
 *
 * @param message - The text Welt shows above the widgets.
 * @param options - One entry per button: a required `value` (what the
 *   suspended tool receives as the answer when the button is pressed), an
 *   optional `label` (the button text; omitted, Welt shows the value), and
 *   an optional `style` ("primary" or "danger").
 * @param input - The free-text field: an optional `label` (the field's
 *   label) and an optional `multiline` (whether the field accepts multiple
 *   lines) — `{}` takes Welt's defaults for both. Omitted, no field
 *   renders.
 * @returns The reason to pass to the tool execution context's `suspend`.
 * @throws {TypeError} If a value is of the wrong type.
 * @throws {Error} If a key is unknown, a required string is empty, or the
 *   reason specifies no widget at all.
 */
export function interruptReason(
  message: string,
  options?: readonly OptionSpec[],
  input?: InputSpec,
): InterruptReason {
  if (options === undefined && input === undefined) {
    throw new Error("a reason needs options, input, or both");
  }
  const reason: InterruptReason = { message: checkedMessage(message) };
  if (options !== undefined) {
    reason.options = checkedOptions(options);
  }
  if (input !== undefined) {
    reason.input = checkedInput(input);
  }
  return reason;
}

/** Check a reason's message. */
function checkedMessage(message: unknown): string {
  if (typeof message !== "string") {
    throw new TypeError(`message must be a string, not ${typeName(message)}`);
  }
  if (message.length === 0) {
    throw new Error("message must not be empty");
  }
  return message;
}

/** Check a reason's options. */
function checkedOptions(options: unknown): OptionSpec[] {
  if (!Array.isArray(options)) {
    throw new TypeError(`options must be an array, not ${typeName(options)}`);
  }
  if (options.length === 0) {
    throw new Error("options must not be empty; omit it to show no buttons");
  }
  return options.map(checkedOption);
}

/** Check one option of a reason. */
function checkedOption(option: unknown): OptionSpec {
  if (!isRecord(option)) {
    throw new TypeError(`an option must be an object, not ${typeName(option)}`);
  }
  refuseUnknownKeys(option, OPTION_KEYS, "an option");
  const { value, label, style } = option;
  if (value === undefined) {
    throw new Error("an option needs a value");
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `an option's value must be a string, not ${typeName(value)}`,
    );
  }
  if (value.length === 0) {
    throw new Error("an option's value must not be empty");
  }
  const checked: OptionSpec = { value };
  if (label !== undefined) {
    checked.label = checkedLabel(label, "an option's label");
  }
  if (style !== undefined) {
    if (style !== "primary" && style !== "danger") {
      throw new Error(`an option's style must be "primary" or "danger"`);
    }
    checked.style = style;
  }
  return checked;
}

/** Check a reason's free-text field. */
function checkedInput(input: unknown): InputSpec {
  if (!isRecord(input)) {
    throw new TypeError(`input must be an object, not ${typeName(input)}`);
  }
  refuseUnknownKeys(input, INPUT_KEYS, "input");
  const { label, multiline } = input;
  const checked: InputSpec = {};
  if (label !== undefined) {
    checked.label = checkedLabel(label, "input's label");
  }
  if (multiline !== undefined) {
    if (typeof multiline !== "boolean") {
      throw new TypeError(
        `input's multiline must be a boolean, not ${typeName(multiline)}`,
      );
    }
    checked.multiline = multiline;
  }
  return checked;
}

/** Check a widget label, which Welt shows in place of nothing. */
function checkedLabel(label: unknown, subject: string): string {
  if (typeof label !== "string") {
    throw new TypeError(`${subject} must be a string, not ${typeName(label)}`);
  }
  if (label.length === 0) {
    throw new Error(`${subject} must not be empty`);
  }
  return label;
}

/**
 * Refuse keys the wire contract does not name.
 *
 * A misspelled key is the mistake worth catching: Welt drops the whole
 * reason to its default rendering rather than ignoring the stray key.
 */
function refuseUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const unknownKeys = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknownKeys.length > 0) {
    throw new Error(
      `${subject} carries unknown key(s): ${unknownKeys.join(", ")}` +
        ` (known: ${allowed.join(", ")})`,
    );
  }
}

/** Name a value's type, for the error that refuses it. */
function typeName(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  const type = typeof value;
  return type === "object" ? "an object" : `a ${type}`;
}

/** A `data` wire event: one text chunk of the reply. */
export interface TextEvent {
  data: string;
}

/** A `current_tool_use` wire event: a tool call started. */
export interface ToolUseEvent {
  current_tool_use: { toolUseId: string; name: string };
}

/** A `tool_result` wire event: a tool call finished. */
export interface ToolResultEvent {
  tool_result: { toolUseId: string; status: "success" | "error" };
}

/** An `interrupt` wire event: the run paused for a human answer. */
export interface InterruptEvent {
  interrupt: { id: string; name: string; reason: unknown };
}

/** An `error` wire event: the run failed mid-stream. */
export interface ErrorEvent {
  error: string;
}

/** An event of the wire's renderable subset. */
export type RenderableEvent =
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | FileEvent
  | InterruptEvent
  | ErrorEvent;

const EXTENSION_BY_SUBTYPE: Readonly<Record<string, string>> = {
  "3gpp": "3gp",
  markdown: "md",
  plain: "txt",
  quicktime: "mov",
  "x-matroska": "mkv",
};

const MAX_APPROVAL_ARGS_CHARS = 1500;

/** A text part of the content a tool returns. */
export interface ToolResultTextPart {
  type: "text";
  text: string;
}

/**
 * A file part of the content a tool returns; `data` is the base64 bytes.
 *
 * `filename` is the name Welt uploads the file under — the media type names
 * it when left off. The model does not see it: the provider names the file
 * it builds for the model itself.
 */
export interface ToolResultMediaPart {
  type: "media";
  data: string;
  mediaType: string;
  filename?: string;
}

/**
 * The tool-result content a tool returns, which `renderableEvents` reads
 * files from — annotate a tool's output with this and a typo becomes a
 * compile error rather than a file that never reaches the thread.
 */
export interface ToolResultContent {
  type: "content";
  value: (ToolResultTextPart | ToolResultMediaPart)[];
}

/** Options for `renderableEvents`. */
export interface RenderableEventsOptions {
  /**
   * The names of the tools whose files become `file` events. Omitted, no
   * tool's files reach the thread.
   */
  filesFrom?: Iterable<string>;
}

/**
 * Reduce a Mastra agent stream to the events Welt renders.
 *
 * Iterates the chunks of `Agent.stream()`'s (or `Agent.resumeStream()`'s)
 * `fullStream` and yields the wire's renderable subset: text chunks
 * (`data`), tool-use indicators (`current_tool_use` / `tool_result`,
 * slimmed so tool arguments and tool output stay off the wire), files
 * (`file` — the model's own file parts, plus the media parts a tool named
 * in `filesFrom` returned as its tool-result content), interrupts
 * (`interrupt` — a suspended tool call's id and suspend payload, the
 * latter passed through unmodified since interpreting a reason is the
 * renderer's job; a tool call awaiting `requireToolApproval` gets a
 * synthesized reason with Approve/Deny buttons whose `y` / `n` answer maps
 * to `approveToolCall` / `declineToolCall`), and failures (`error`, from
 * error and tripwire chunks). Everything else is dropped.
 *
 * An event with nothing to render is dropped too: a text chunk the model
 * left empty, a file that points at its bytes rather than carrying them,
 * and a file with no bytes — which Slack refuses, failing the whole reply
 * with it. The empty one leaves a process warning behind, naming what
 * returned it; a pointer is nothing to report.
 *
 * Which of the agent's files belong in the reply is the agent's call, so
 * a tool's files become `file` events only when the tool is named in
 * `filesFrom` — a tool that hands the model a file to read stays off the
 * wire unless it is listed. Files the model itself returns are its reply,
 * and always go.
 *
 * @param chunks - The chunks of a Mastra agent stream, e.g. `fullStream`.
 * @param options - `filesFrom`: the names of the tools whose files become
 *   `file` events.
 * @yields The renderable wire events, in stream order.
 */
export async function* renderableEvents<OUTPUT = undefined>(
  chunks: AsyncIterable<ChunkType<OUTPUT>>,
  options?: RenderableEventsOptions,
): AsyncGenerator<RenderableEvent, void, undefined> {
  const filesFrom = new Set(options?.filesFrom ?? []);
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case "text-delta": {
        // An empty chunk carries nothing to render.
        if (chunk.payload.text.length > 0) {
          yield { data: chunk.payload.text };
        }
        break;
      }
      case "tool-call": {
        const { toolCallId, toolName } = chunk.payload;
        yield { current_tool_use: { toolUseId: toolCallId, name: toolName } };
        break;
      }
      case "tool-result": {
        const { toolCallId, toolName, isError, result } = chunk.payload;
        yield {
          tool_result: {
            toolUseId: toolCallId,
            status: isError === true ? "error" : "success",
          },
        };
        if (filesFrom.has(toolName)) {
          yield* resultFileEvents(result, toolName);
        }
        break;
      }
      case "tool-error": {
        yield {
          tool_result: { toolUseId: chunk.payload.toolCallId, status: "error" },
        };
        break;
      }
      case "file": {
        const { data, base64, mimeType } = chunk.payload;
        // A generated file carries its bytes or points at them by URL, and
        // there is nothing to upload from a pointer. Which one a string is
        // is Mastra's reading, not a guess made here: it fills `base64` in
        // with the data it considers base64, and leaves it unset for a URL.
        if (typeof data === "string" && base64 === undefined) {
          break;
        }
        const event = fileEvent(fileName(mimeType), data, "the model");
        if (event !== null) {
          yield event;
        }
        break;
      }
      case "tool-call-suspended": {
        const { toolCallId, toolName, suspendPayload } = chunk.payload;
        yield {
          interrupt: { id: toolCallId, name: toolName, reason: suspendPayload },
        };
        break;
      }
      case "tool-call-approval": {
        const { toolCallId, toolName, args } = chunk.payload;
        yield {
          interrupt: {
            id: toolCallId,
            name: toolName,
            reason: approvalReason(toolName, args),
          },
        };
        break;
      }
      case "error": {
        yield { error: errorText(chunk.payload.error) };
        break;
      }
      case "tripwire": {
        const { reason } = chunk.payload;
        yield {
          error:
            reason.length > 0
              ? reason
              : "the reply was blocked by an output processor",
        };
        break;
      }
      default: {
        break;
      }
    }
  }
}

/**
 * Pull the files a tool handed the model out of its tool result.
 *
 * A tool hands the model a file by returning AI SDK tool-result content —
 * `ToolResultContent`, a `media` part per file — which the stream carries
 * as the tool's raw result. A tool returns whatever it likes, so this is
 * the one reply shape that has to be recognized rather than read: content
 * that does not fit carries no file. The upload name comes from the part's
 * `filename`, and falls back to the media type when the tool leaves it off.
 *
 * @param result - The tool's raw result, as the stream carried it.
 * @param toolName - The tool that returned it, for the warning an empty
 *   file leaves behind.
 * @returns One `file` event per media part with bytes to upload, or none.
 */
function resultFileEvents(result: unknown, toolName: string): FileEvent[] {
  if (
    !isRecord(result) ||
    result.type !== "content" ||
    !Array.isArray(result.value)
  ) {
    return [];
  }
  const events: FileEvent[] = [];
  for (const part of result.value) {
    if (
      !isRecord(part) ||
      part.type !== "media" ||
      typeof part.data !== "string"
    ) {
      continue;
    }
    const name =
      typeof part.filename === "string" && part.filename.length > 0
        ? part.filename
        : fileName(part.mediaType);
    const event = fileEvent(name, part.data, toolName);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Build a `file` wire event, which Welt uploads to the Slack thread.
 *
 * @param name - The upload filename, extension included.
 * @param data - The file's bytes, base64 already or raw.
 * @param origin - What produced the file, for the warning an empty one
 *   leaves behind.
 * @returns The `file` event (name plus base64 bytes), or null for a file
 *   with no bytes.
 */
function fileEvent(
  name: string,
  data: string | Uint8Array,
  origin: string,
): FileEvent | null {
  // A string is already base64; Mastra sets `payload.base64` only when
  // `data` is a string, and to the same value.
  const bytes =
    typeof data === "string" ? data : Buffer.from(data).toString("base64");
  if (bytes.length === 0) {
    // Slack refuses a zero-byte upload, and the whole reply fails with it,
    // so an empty file does not go on the wire.
    process.emitWarning(
      `Skipped an empty file from ${origin}: ${name}`,
      WARNING_TYPE,
    );
    return null;
  }
  return { file: { name, bytes } };
}

/**
 * Name a file after the media type it arrived under.
 *
 * @param mimeType - The part's media type; a tool's may be anything.
 * @returns The upload filename (`image.png`, `file.csv`, `file.bin`).
 */
function fileName(mimeType: unknown): string {
  const [type = "", subtype = ""] = (
    typeof mimeType === "string" ? mimeType : ""
  ).split("/");
  const stem =
    type === "image" || type === "video" || type === "audio" ? type : "file";
  const extension =
    EXTENSION_BY_SUBTYPE[subtype] ??
    (/^[0-9a-z]+$/.test(subtype) ? subtype : "bin");
  return `${stem}.${extension}`;
}

function approvalReason(
  toolName: string,
  args: Record<string, unknown>,
): InterruptReason {
  const heading =
    toolName.length > 0 ? `May I run \`${toolName}\`?` : "May I run this tool?";
  const rendered = renderedArgs(args);
  return interruptReason(
    rendered === null ? heading : `${heading}\n\`\`\`\n${rendered}\n\`\`\``,
    [
      { value: "y", label: "Approve", style: "primary" },
      { value: "n", label: "Deny" },
    ],
  );
}

function renderedArgs(args: Record<string, unknown>): string | null {
  if (Object.keys(args).length === 0) {
    return null;
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(args, null, 2);
  } catch {
    // Not JSON-serializable (a BigInt, a cycle); the heading alone will do.
    return null;
  }
  return rendered.length > MAX_APPROVAL_ARGS_CHARS
    ? `${rendered.slice(0, MAX_APPROVAL_ARGS_CHARS)}…`
    : rendered;
}

function errorText(error: unknown): string {
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
