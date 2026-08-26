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
 * an input to validate against runtime errors — the inbound parameter
 * types say what arrives, and a value that is not it surfaces as an
 * ordinary error from whatever touches it first. The one thing
 * `decodeMessages` does refuse is a content block of a kind Welt never
 * sends: a `toolUse` or `toolResult` is not a shape error but a forged
 * conversation turn, and rebuilt as history it would let whoever reached
 * the runtime put words the model treats as its own past actions into the
 * run. What this adapter checks beyond that is the values its own caller
 * passes to `interruptReason`, since Welt renders a reason it cannot match
 * as its default buttons, silently.
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
 * A Mastra agent takes AI SDK model messages, whose file parts carry a
 * media type instead of a Converse format token, and whose base64 data
 * needs no decoding. Each message is rebuilt — text blocks become text parts, image blocks
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

// The content block kinds Welt sends. A block of any other kind — a toolUse
// or toolResult in particular — is a forged conversation turn, not something
// Welt builds, and rebuilt as history it would let a caller put words the
// model treats as its own past actions into the run. It is refused, not
// rebuilt.
const ALLOWED_BLOCK_KEYS = new Set(["text", "image", "document", "video"]);

function refuseForgedBlock(block: object): void {
  if (!Object.keys(block).every((key) => ALLOWED_BLOCK_KEYS.has(key))) {
    throw new Error(
      `unexpected content block: ${Object.keys(block).sort().join(", ")}`,
    );
  }
}

function decodedMessage(message: WireMessage): AIV5Type.ModelMessage {
  for (const block of message.content) {
    refuseForgedBlock(block);
  }
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

/** Any value JSON can carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One answer of Welt's resume payload: what it was, and where from. */
export interface InterruptAnswer {
  value: JsonValue;
  source: "option" | "input";
}

/** One decoded interrupt answer: the suspended tool call and the human's answer. */
export interface InterruptResponse {
  toolCallId: string;
  answer: JsonValue;
}

/**
 * Decode Welt's interrupt answers into Mastra resume inputs.
 *
 * Welt resumes an interrupted run with a payload mapping each interrupt
 * id to the answer a human chose in the thread and the widget it came
 * from. `renderableEvents` uses the suspended tool call's id as the
 * interrupt id, so each entry here feeds one
 * `Agent.resumeStream(answer, { runId, toolCallId })` call.
 *
 * The answer travels on as the value it was given, since what it means is
 * for the suspended tool to decide. The widget it came from is Welt's own
 * vocabulary, and a tool that reads its own option values already knows
 * which of them it declared.
 *
 * @param responses - The `interrupt_responses` value of Welt's payload.
 * @returns One entry per answered interrupt, in payload order.
 */
export function decodeInterruptResponses(
  responses: Readonly<Record<string, InterruptAnswer>>,
): InterruptResponse[] {
  return Object.entries(responses).map(([toolCallId, answer]) => ({
    toolCallId,
    answer: answer.value,
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
  value: JsonValue;
  label?: string;
  style?: "primary" | "danger";
};

/** The look of the approve or reject button, which Welt words itself. */
export type DecisionSpec = {
  label?: string;
  style?: "primary" | "danger";
};

/** The free-text field of a structured interrupt reason. */
export type InputSpec = {
  label?: string;
  multiline?: boolean;
};

/** What a reason asks Welt to render. */
export type ReasonSpec = {
  message: string;
  approve?: DecisionSpec;
  reject?: DecisionSpec;
  options?: readonly OptionSpec[];
  input?: InputSpec;
};

/** The structured interrupt reason shape Welt renders as widgets. */
type InterruptReason = {
  message: string;
  approve?: DecisionSpec;
  reject?: DecisionSpec;
  options?: OptionSpec[];
  input?: InputSpec;
};

const REASON_KEYS = ["message", "approve", "reject", "options", "input"];
const OPTION_KEYS = ["value", "label", "style"];
const DECISION_KEYS = ["label", "style"];
const INPUT_KEYS = ["label", "multiline"];

/**
 * Build an interrupt reason that Welt renders as the specified widgets.
 *
 * Welt renders this shape as `message` followed by the widgets the
 * remaining arguments ask for: the approve and reject buttons Welt words
 * and values itself (`approve`, `reject`), one button per option
 * (`options`), and a free-text field whose submitted text becomes the
 * interrupt's response (`input`). They combine — whichever answer comes
 * first, a pressed button or the submitted text, settles the question —
 * and with none of them the message renders as itself and Welt's default
 * buttons answer it.
 *
 * Building the reason through this helper is what makes a typo an error.
 * A tool that declares no `suspendSchema` takes its suspend payload as
 * `unknown`, so an object literal handed to `suspend` directly is checked
 * by nothing, and Welt's reaction to a reason it cannot match is its
 * default buttons — no error, no log, just widgets the
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
 * @param spec - What the question asks for. `message` is the text Welt
 *   shows above the widgets. `approve` and `reject` are the buttons Welt
 *   words itself (each an optional `label` and `style` — `{}` takes
 *   Welt's own wording), which the suspended tool receives as `true` and
 *   `false`. `options` is one entry per button of your own: a required
 *   `value` (any JSON value, received as the answer when the button is
 *   pressed), an optional `label` (the button text; omitted, Welt shows
 *   the value), and an optional `style`. `input` is the free-text field
 *   (an optional `label` and an optional `multiline` — `{}` takes Welt's
 *   defaults for both). An omitted key renders no widget.
 * @returns The reason to pass to the tool execution context's `suspend`.
 * @throws {TypeError} If a value is of the wrong type.
 * @throws {Error} If a key is unknown or a required string is empty.
 */
export function interruptReason(spec: ReasonSpec): InterruptReason {
  if (!isRecord(spec)) {
    throw new TypeError(`the reason must be an object, not ${typeName(spec)}`);
  }
  refuseUnknownKeys(spec, REASON_KEYS, "the reason");
  const { message, approve, reject, options, input } = spec;
  const reason: InterruptReason = { message: checkedMessage(message) };
  if (approve !== undefined) {
    reason.approve = checkedDecision(approve, "approve");
  }
  if (reject !== undefined) {
    reason.reject = checkedDecision(reject, "reject");
  }
  if (options !== undefined) {
    reason.options = checkedOptions(options);
  }
  if (input !== undefined) {
    reason.input = checkedInput(input);
  }
  return reason;
}

/** Check the look of the approve or reject button. */
function checkedDecision(spec: unknown, subject: string): DecisionSpec {
  if (!isRecord(spec)) {
    throw new TypeError(`${subject} must be an object, not ${typeName(spec)}`);
  }
  refuseUnknownKeys(spec, DECISION_KEYS, subject);
  const { label, style } = spec;
  const checked: DecisionSpec = {};
  if (label !== undefined) {
    checked.label = checkedLabel(label, `${subject}'s label`);
  }
  if (style !== undefined) {
    if (style !== "primary" && style !== "danger") {
      throw new Error(`${subject}'s style must be "primary" or "danger"`);
    }
    checked.style = style;
  }
  return checked;
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
  // An option's value is whatever JSON value the interrupting tool wants
  // back, so nothing about it is a typo to catch beyond its being JSON at
  // all — what a reason carries has to survive the wire.
  if (value === undefined) {
    throw new Error("an option needs a value");
  }
  if (!isJsonValue(value)) {
    throw new TypeError(
      `an option's value must be JSON, not ${typeName(value)}`,
    );
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

// Converse format tokens double as filename extensions, except this one.
const EXTENSION_BY_FORMAT: Readonly<Record<string, string>> = {
  three_gp: "3gp",
};

// The extension for every media type the wire's formats map to, built from
// the maps above so the two cannot drift. A media subtype is not an
// extension in general — `application/vnd.ms-excel` and `video/x-ms-wmv`
// have none in them — which is why this is keyed on the whole media type.
// Where two formats share one (mpeg and mpg), the last one named wins.
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> =
  Object.fromEntries(
    [IMAGE_MEDIA_TYPES, DOCUMENT_MEDIA_TYPES, VIDEO_MEDIA_TYPES].flatMap(
      (mapping) =>
        Object.entries(mapping).map(([format, mediaType]) => [
          mediaType,
          EXTENSION_BY_FORMAT[format] ?? format,
        ]),
    ),
  );

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
 * synthesized reason asking for Welt's own approve and reject buttons,
 * whose `true` / `false` answer maps to `approveToolCall` /
 * `declineToolCall`), and
 * failures (`error`, from
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
    EXTENSION_BY_MEDIA_TYPE[`${type}/${subtype}`] ??
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
  return interruptReason({
    message:
      rendered === null ? heading : `${heading}\n\`\`\`\n${rendered}\n\`\`\``,
    approve: {},
    reject: {},
  });
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

/** Whether a value is one JSON can carry, nested values included. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

/** One agent stream: what `Agent.stream()` and `Agent.resumeStream()` return. */
export interface AgentStream {
  runId: string;
  fullStream: AsyncIterable<ChunkType<unknown>>;
}

/**
 * What the handler drives: the Agent's streaming face.
 *
 * Importing the SDK to name the Agent would say what two methods already
 * say. This names them instead, and an Agent satisfies it — as long as it
 * lives on a `Mastra` instance, which is what holds an interrupted run
 * for `resumeStream` to find. The `never[]` rests make room for the
 * parameters Mastra's own overloads require beyond what the handler
 * passes.
 */
export interface StreamingAgent {
  stream(
    messages: AIV5Type.ModelMessage[],
    ...rest: never[]
  ): Promise<AgentStream>;
  resumeStream(
    answer: JsonValue,
    options: { runId: string; toolCallId: string },
    ...rest: never[]
  ): Promise<AgentStream>;
}

/** What `startReply` takes beside the agent and the payload. */
export interface StartReplyOptions {
  /**
   * The id of the run being resumed, held by the caller since the stop
   * that raised the questions. Required when the payload carries answers,
   * and unused otherwise.
   */
  runId?: string;
}

/**
 * Welt's payload, which carries one of the two envelopes.
 *
 * What Welt sends is taken as correct: it checks its own output against
 * the wire contract before sending it, so this says what arrives rather
 * than checking it. A payload carrying neither key is Welt's bug, and the
 * error it raises is reported as an `error` event by the SDK.
 */
type WeltPayload =
  | { messages: WireMessage[] }
  | { interrupt_responses: Record<string, InterruptAnswer> };

/**
 * Start the streams that reply to the payload Welt sent.
 *
 * ```ts
 * for await (const stream of startReply(agent, payload, { runId })) {
 *   for await (const event of renderableEvents(stream.fullStream, { filesFrom })) {
 *     yield { data: event };
 *   }
 * }
 * ```
 *
 * A conversation turn is one stream, on the messages Welt sends — the
 * Slack thread is the source of truth for conversation history, and the
 * payload carries it whole. A resume is one stream per answer: Mastra
 * resumes a suspended tool call by its own id, so a stop that asked two
 * questions is answered in two calls. The generator is lazy — each
 * resume starts only when the caller pulls the next stream — so drain
 * each stream before pulling again, and each call picks up where the
 * last left off.
 *
 * Each stream carries the `runId` that resumes it, and holding that —
 * for as long as its buttons should stay answerable — is the agent's
 * business. Nothing is held here. The run itself lives on the `Mastra`
 * instance the agent belongs to, which is why an Agent streamed on its
 * own keeps no suspended run for `resumeStream` to find.
 *
 * @param agent - The agent to stream, living on a `Mastra` instance.
 * @param payload - Welt's invocation payload.
 * @param options - `runId`: the run being resumed.
 * @yields The streams of this reply, in order.
 * @throws {Error} If the payload carries answers and no `runId` came with
 *   them — there is no run to resume.
 */
export async function* startReply(
  agent: StreamingAgent,
  payload: unknown,
  options?: StartReplyOptions,
): AsyncGenerator<AgentStream, void, undefined> {
  const envelope = payload as WeltPayload;
  if ("interrupt_responses" in envelope) {
    const runId = options?.runId;
    if (runId === undefined) {
      throw new Error("startReply was given answers but no runId to resume.");
    }
    for (const { toolCallId, answer } of decodeInterruptResponses(
      envelope.interrupt_responses,
    )) {
      yield await agent.resumeStream(answer, { runId, toolCallId });
    }
    return;
  }
  yield await agent.stream(decodeMessages(envelope.messages));
}
