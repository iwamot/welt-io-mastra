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
 * `renderableEvents` reduces the stream to the events Welt renders, with
 * the files of the tools the agent names base64-encoded. `fileEvent`
 * builds the same `file` event from a name and raw bytes, for the files
 * the host app attaches itself.
 *
 * Neither direction is restated here. What arrives is checked against
 * Welt's published schemas, vendored as `schema/` and compiled into
 * `_schema.ts`, and what the builders produce is checked against them
 * before it is returned. The reply stream is read as what Mastra's types
 * say it is: `fullStream` yields a closed union of chunks, so each one is
 * read for what it is rather than guarded against shapes Mastra does not
 * produce.
 */

import { Buffer } from "node:buffer";
import type { AIV5Type } from "@mastra/core/agent/message-list";
import type { ChunkType } from "@mastra/core/stream";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { REPLY_EVENTS, REQUEST_PAYLOAD } from "./_schema.ts";

// strict: false — the schemas are Welt's, written to the specification
// rather than to Ajv's stricter reading of it.
const ajv = new Ajv2020({ strict: false });

/**
 * Build a validator for one definition of a wire schema.
 *
 * `decodeMessages` and `decodeInterruptResponses` each take one value out
 * of Welt's envelope rather than the envelope itself, and the builders
 * produce one reply shape each, so each validator points at the definition
 * for its own value.
 *
 * @param defs - The `$defs` of the schema carrying the definition.
 * @param definition - The name under those `$defs`.
 * @returns The validator.
 */
function validator(defs: object, definition: string): ValidateFunction {
  return ajv.compile({ $ref: `#/$defs/${definition}`, $defs: defs });
}

// Inbound: the two envelope values, each taken on its own.
const MESSAGES = validator(REQUEST_PAYLOAD.$defs, "messages");
const INTERRUPT_RESPONSES = validator(
  REQUEST_PAYLOAD.$defs,
  "interruptResponses",
);

// Outbound: what the builders below must produce for Welt to render it.
const FILE = validator(REPLY_EVENTS.$defs, "file");
const STRUCTURED_REASON = validator(REPLY_EVENTS.$defs, "structuredReason");

/**
 * Thrown when a value does not match the shape Welt's wire contract gives
 * it: a payload Welt sent, or an event one of the builders below built.
 *
 * A payload that violates the contract is a bug on the sending side rather
 * than an input to interpret, and an event that violates it would reach the
 * Slack thread as Welt's fallback rendering instead of what was meant.
 */
export class WireContractError extends Error {
  /** Where it broke, as a path into the value (`$.content[0].text`). */
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "WireContractError";
    this.path = path;
  }
}

/**
 * Check a value against one wire schema, raising where it broke.
 *
 * A message is checked against one definition per role, and a content
 * block against one per kind, so a violation inside one fails the whole
 * group and is reported against the block as a whole as well. The error
 * that says which value, and why, is the deepest one.
 *
 * @param validate - The validator for this value.
 * @param value - The value to check.
 * @throws {WireContractError} If the value violates the contract.
 */
function checked(validate: ValidateFunction, value: unknown): void {
  if (validate(value)) {
    return;
  }
  // Ajv fills these in whenever validation fails; the cast says so.
  const errors = validate.errors as ErrorObject[];
  const deepest = errors.reduce((worst, error) =>
    error.instancePath.length > worst.instancePath.length ? error : worst,
  );
  throw new WireContractError(
    shownPath(deepest.instancePath),
    deepest.message as string,
  );
}

/**
 * Show an Ajv instance path as a path into the value.
 *
 * @param instancePath - The JSON Pointer Ajv reports (`/1/content/0`).
 * @returns The path as a caller would write it (`$[1].content[0]`).
 */
function shownPath(instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .reduce(
      (shown, segment) =>
        /^\d+$/.test(segment) ? `${shown}[${segment}]` : `${shown}.${segment}`,
      "$",
    );
}

// The payload shapes the schema has vouched for, as far as the decoding
// below reads them. The format tokens are Converse's, which is what the
// wire carries; each maps to the media type an AI SDK part takes instead.
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

type WireMessage =
  | { role: "user"; content: WireUserBlock[] }
  | { role: "assistant"; content: WireTextBlock[] };

// Total maps: the schema admits these format tokens and no others.
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
 * This checks the payload against Welt's published schema and rebuilds
 * each message — text blocks become text parts, image blocks image parts,
 * and document and video blocks file parts. The result feeds
 * `Agent.stream()`.
 *
 * A payload that departs from the wire contract throws: it is a bug on
 * the sending side, and decoding what is left of it would hand the agent
 * a conversation with a turn missing.
 *
 * @param messages - The `messages` value of Welt's payload.
 * @returns Model messages for `Agent.stream()`.
 * @throws {WireContractError} If the payload violates the wire contract.
 *   The error names the offending path.
 */
export function decodeMessages(messages: unknown): AIV5Type.ModelMessage[] {
  checked(MESSAGES, messages);
  // The schema has vouched for the shape; the cast tells the type checker.
  return (messages as WireMessage[]).map(decodedMessage);
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
 * A payload that departs from the wire contract throws: resuming a run
 * with an answer short is worse than not resuming it at all.
 *
 * @param responses - The `interrupt_responses` value of Welt's payload.
 * @returns One entry per answered interrupt, in payload order.
 * @throws {WireContractError} If the payload violates the wire contract.
 *   The error names the offending path.
 */
export function decodeInterruptResponses(
  responses: unknown,
): InterruptResponse[] {
  checked(INTERRUPT_RESPONSES, responses);
  // The schema has vouched for the shape; the cast tells the type checker.
  return Object.entries(responses as Record<string, string>).map(
    ([toolCallId, answer]) => ({ toolCallId, answer }),
  );
}

/** A `file` wire event: a filename plus base64 bytes Welt uploads to Slack. */
export interface FileEvent {
  file: { name: string; bytes: string };
}

/**
 * Build a `file` wire event, which Welt uploads to the Slack thread.
 *
 * `renderableEvents` emits these for the files the model returns and the
 * files of the tools the agent names; this builds the same event from
 * arbitrary bytes, for the files the host app attaches itself.
 *
 * @param name - The upload filename, extension included.
 * @param data - The raw file bytes.
 * @returns The `file` event (name plus base64 bytes).
 * @throws {WireContractError} If the event would not be one Welt renders —
 *   a nameless file, which it drops.
 */
export function fileEvent(name: string, data: Uint8Array): FileEvent {
  return checkedFileEvent(name, Buffer.from(data).toString("base64"));
}

/** Build a `file` event from bytes that are base64 already. */
function checkedFileEvent(name: string, bytes: string): FileEvent {
  const file = { name, bytes };
  checked(FILE, file);
  return { file };
}

// Type aliases, not interfaces: an alias gets an implicit index signature,
// so a reason fits a suspend payload as-is.

/** A button of a structured interrupt reason. */
export type InterruptOption = {
  value: string;
  label?: string;
  style?: "primary" | "danger";
};

/** The free-text field of a structured interrupt reason. */
export type InterruptInput = {
  label?: string;
  multiline?: boolean;
};

/** The structured interrupt reason shape Welt renders as widgets. */
export type InterruptReason = {
  message: string;
  options?: InterruptOption[];
  input?: InterruptInput;
};

/**
 * Build an interrupt reason that Welt renders as the specified widgets.
 *
 * Welt renders this shape as `message` followed by one button per option
 * (`options`), a free-text field whose submitted text becomes the
 * interrupt's response (`input`), or both — whichever answer comes
 * first, a pressed button or the submitted text, settles the question.
 * Both widget specs are the wire's own shapes; building them through this
 * helper checks the result against Welt's published schema, so a typo
 * throws here instead of reaching the thread as Welt's default rendering —
 * which is what a reason it cannot match falls back to, silently.
 *
 * @param message - The text Welt shows above the widgets.
 * @param options - One entry per button: a required `value` (what the
 *   suspended tool receives as the answer when the button is pressed), an
 *   optional `label` (the button text; omitted, Welt shows the value), and
 *   an optional `style` ("primary" or "danger"). At most 25, which is what
 *   one Slack actions block holds.
 * @param input - The free-text field: an optional `label` (the field's
 *   label) and an optional `multiline` (whether the field accepts
 *   multiple lines) — `{}` takes Welt's defaults for both. Omitted, no
 *   field renders.
 * @returns The reason to pass to the tool execution context's `suspend`.
 * @throws {WireContractError} If the reason would not be one Welt renders
 *   as widgets.
 */
export function interruptReason(
  message: string,
  options?: readonly InterruptOption[],
  input?: InterruptInput,
): InterruptReason {
  const reason: InterruptReason = { message };
  if (options !== undefined) {
    reason.options = [...options];
  }
  if (input !== undefined) {
    reason.input = input;
  }
  checked(STRUCTURED_REASON, reason);
  return reason;
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
 * slimmed so tool output stays off the wire), files (`file` — the model's
 * own file parts, plus the media parts a tool named in `filesFrom`
 * returned as its tool-result content), interrupts (`interrupt` — a
 * suspended tool call's id and suspend payload, the latter passed through
 * unmodified since interpreting a reason is the renderer's job; a tool
 * call awaiting `requireToolApproval` gets a synthesized reason with
 * Approve/Deny buttons whose `y` / `n` answer maps to `approveToolCall` /
 * `declineToolCall`), and failures (`error`, from error and tripwire
 * chunks). Everything else is dropped.
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
        // A delta the model left empty would be an event Welt cannot render.
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
          yield* resultFileEvents(result);
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
        const { data, mimeType } = chunk.payload;
        yield checkedFileEvent(
          fileName(mimeType),
          // A string is already base64; Mastra sets `payload.base64` only
          // when `data` is a string, and to the same value.
          typeof data === "string"
            ? data
            : Buffer.from(data).toString("base64"),
        );
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
 * @returns One `file` event per media part, or none.
 */
function resultFileEvents(result: unknown): FileEvent[] {
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
    events.push(checkedFileEvent(name, part.data));
  }
  return events;
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
