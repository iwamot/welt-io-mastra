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
 */

import { Buffer } from "node:buffer";

/** A text part of a decoded model message. */
export interface DecodedTextPart {
  type: "text";
  text: string;
}

/** An image part of a decoded model message; `image` is the base64 data. */
export interface DecodedImagePart {
  type: "image";
  image: string;
  mediaType?: string;
}

/** A file part of a decoded model message; `data` is the base64 data. */
export interface DecodedFilePart {
  type: "file";
  data: string;
  mediaType: string;
  filename?: string;
}

/** A content part of a decoded user message. */
export type DecodedUserPart =
  | DecodedTextPart
  | DecodedImagePart
  | DecodedFilePart;

/** An AI SDK model message decoded from Welt's Converse-shaped payload. */
export type DecodedMessage =
  | { role: "user"; content: DecodedUserPart[] }
  | { role: "assistant"; content: DecodedTextPart[] };

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const DOCUMENT_MEDIA_TYPES: Readonly<Record<string, string>> = {
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

const VIDEO_MEDIA_TYPES: Readonly<Record<string, string>> = {
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

/**
 * Decode Welt's Converse-shaped messages into AI SDK model messages.
 *
 * Strands consumes Welt's messages as-is, but Mastra does not: its agents
 * take AI SDK model messages, whose file parts carry a media type instead
 * of a Converse format token, and whose base64 data needs no decoding.
 * This walks the payload's `messages` value and rebuilds each message —
 * text blocks become text parts, image blocks image parts, and document
 * and video blocks file parts. Malformed entries are skipped, since they
 * come from the wire rather than the developer; messages left with no
 * parts are dropped.
 *
 * @param messages - The `messages` value of Welt's payload.
 * @returns Model messages for `Agent.stream()`.
 */
export function decodeMessages(messages: unknown): DecodedMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const decoded: DecodedMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    if (message.role === "user") {
      const content = userContent(message.content);
      if (content.length > 0) {
        decoded.push({ role: "user", content });
      }
    } else if (message.role === "assistant") {
      const content = assistantContent(message.content);
      if (content.length > 0) {
        decoded.push({ role: "assistant", content });
      }
    }
  }
  return decoded;
}

function userContent(content: unknown): DecodedUserPart[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: DecodedUserPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    const part =
      imagePart(block.image) ??
      documentPart(block.document) ??
      videoPart(block.video);
    if (part !== null) {
      parts.push(part);
    }
  }
  return parts;
}

function assistantContent(content: unknown): DecodedTextPart[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: DecodedTextPart[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    }
  }
  return parts;
}

function imagePart(media: unknown): DecodedImagePart | null {
  if (!isRecord(media)) {
    return null;
  }
  const bytes = sourceBytes(media);
  if (bytes === null) {
    return null;
  }
  // An unknown format omits the media type; the AI SDK detects common
  // image types from the bytes.
  const mediaType =
    typeof media.format === "string"
      ? IMAGE_MEDIA_TYPES[media.format]
      : undefined;
  return mediaType === undefined
    ? { type: "image", image: bytes }
    : { type: "image", image: bytes, mediaType };
}

function documentPart(media: unknown): DecodedFilePart | null {
  if (!isRecord(media)) {
    return null;
  }
  const bytes = sourceBytes(media);
  if (bytes === null) {
    return null;
  }
  const mediaType =
    (typeof media.format === "string"
      ? DOCUMENT_MEDIA_TYPES[media.format]
      : undefined) ?? "application/octet-stream";
  return typeof media.name === "string" && media.name.length > 0
    ? { type: "file", data: bytes, mediaType, filename: media.name }
    : { type: "file", data: bytes, mediaType };
}

function videoPart(media: unknown): DecodedFilePart | null {
  if (!isRecord(media)) {
    return null;
  }
  const bytes = sourceBytes(media);
  if (bytes === null) {
    return null;
  }
  const mediaType =
    (typeof media.format === "string"
      ? VIDEO_MEDIA_TYPES[media.format]
      : undefined) ?? "application/octet-stream";
  return { type: "file", data: bytes, mediaType };
}

function sourceBytes(media: Record<string, unknown>): string | null {
  const source = media.source;
  if (!isRecord(source)) {
    return null;
  }
  return typeof source.bytes === "string" && source.bytes.length > 0
    ? source.bytes
    : null;
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
 * id to the answer a human chose in the thread. `renderable_events` uses
 * the suspended tool call's id as the interrupt id, so each entry here
 * feeds one `Agent.resumeStream(answer, { runId, toolCallId })` call.
 *
 * @param responses - The `interrupt_responses` value of Welt's payload.
 * @returns One entry per answered interrupt, in payload order.
 */
export function decodeInterruptResponses(
  responses: unknown,
): InterruptResponse[] {
  if (!isRecord(responses)) {
    return [];
  }
  const decoded: InterruptResponse[] = [];
  for (const [toolCallId, answer] of Object.entries(responses)) {
    if (typeof answer === "string") {
      decoded.push({ toolCallId, answer });
    }
  }
  return decoded;
}

/** A `file` wire event: a filename plus base64 bytes Welt uploads to Slack. */
export interface FileEvent {
  file: { name: string; bytes: string };
}

/**
 * Build a `file` wire event, which Welt uploads to the Slack thread.
 *
 * `renderableEvents` emits these for the files the model generates; this
 * builds the same event from arbitrary bytes, for agents that attach
 * files of their own alongside the reduced stream — yield it from the
 * host app, or `write` it to the tool execution context's stream writer
 * to attach a file from inside a tool.
 *
 * @param name - The upload filename, extension included.
 * @param data - The raw file bytes.
 * @returns The `file` event (name plus base64 bytes).
 * @throws TypeError if the name is empty (Welt drops a nameless file).
 */
export function fileEvent(name: string, data: Uint8Array): FileEvent {
  if (name.length === 0) {
    throw new TypeError("name must not be empty");
  }
  return { file: { name, bytes: Buffer.from(data).toString("base64") } };
}

/** A button of a structured interrupt reason. */
export interface InterruptOption {
  value: string;
  label?: string;
  style?: "primary" | "danger";
}

/** The free-text field of a structured interrupt reason. */
export interface InterruptInput {
  label?: string;
  multiline?: boolean;
}

/** The structured interrupt reason shape Welt renders as widgets. */
export interface InterruptReason {
  message: string;
  options?: InterruptOption[];
  input?: InterruptInput;
}

const OPTION_KEYS = new Set(["value", "label", "style"]);
const INPUT_KEYS = new Set(["label", "multiline"]);

/**
 * Build an interrupt reason that Welt renders as the specified widgets.
 *
 * Welt renders this shape as `message` followed by one button per option
 * (`options`), a free-text field whose submitted text becomes the
 * interrupt's response (`input`), or both — whichever answer comes
 * first, a pressed button or the submitted text, settles the question.
 * Both widget specs are the wire's own shapes; building them through
 * this helper turns a typo into an immediate TypeError instead of a
 * silent fallback to Welt's default rendering.
 *
 * @param message - The text Welt shows above the widgets.
 * @param options - One entry per button: a required `value` (what the
 *   suspended tool receives as the answer when the button is pressed),
 *   an optional `label` (the button text; omitted, Welt shows the
 *   value), and an optional `style` ("primary" or "danger").
 * @param input - The free-text field: an optional `label` (the field's
 *   label) and an optional `multiline` (whether the field accepts
 *   multiple lines) — `{}` takes Welt's defaults for both. Omitted, no
 *   field renders.
 * @returns The reason to pass to the tool execution context's `suspend`.
 * @throws TypeError if the message is empty, neither options nor input
 *   is given, or a widget spec is off — an unknown key, a missing value,
 *   an empty or non-string value/label, a style that is not "primary" or
 *   "danger", or a non-boolean multiline.
 */
export function interruptReason(
  message: string,
  options?: readonly InterruptOption[],
  input?: InterruptInput,
): InterruptReason {
  if (message.length === 0) {
    throw new TypeError("message must not be empty");
  }
  if (options === undefined && input === undefined) {
    throw new TypeError("options or input must be given");
  }
  const reason: InterruptReason = { message };
  if (options !== undefined) {
    reason.options = builtOptions(options);
  }
  if (input !== undefined) {
    reason.input = builtInput(input);
  }
  return reason;
}

function builtOptions(options: readonly InterruptOption[]): InterruptOption[] {
  if (options.length === 0) {
    throw new TypeError("options must not be empty");
  }
  const built: InterruptOption[] = [];
  for (const option of options) {
    const unknownKeys = Object.keys(option).filter(
      (key) => !OPTION_KEYS.has(key),
    );
    if (unknownKeys.length > 0) {
      throw new TypeError(
        `unknown option keys: ${unknownKeys.sort().join(", ")}`,
      );
    }
    const value: unknown = option.value;
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("option value must be a non-empty string");
    }
    const entry: InterruptOption = { value };
    if ("label" in option) {
      const label: unknown = option.label;
      if (typeof label !== "string" || label.length === 0) {
        throw new TypeError("option label must be a non-empty string");
      }
      entry.label = label;
    }
    if ("style" in option) {
      const style: unknown = option.style;
      if (style !== "primary" && style !== "danger") {
        throw new TypeError(
          `style must be "primary" or "danger": ${JSON.stringify(style)}`,
        );
      }
      entry.style = style;
    }
    built.push(entry);
  }
  return built;
}

function builtInput(input: InterruptInput): InterruptInput {
  const unknownKeys = Object.keys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(`unknown input keys: ${unknownKeys.sort().join(", ")}`);
  }
  const built: InterruptInput = {};
  if ("label" in input) {
    const label: unknown = input.label;
    if (typeof label !== "string" || label.length === 0) {
      throw new TypeError("input label must be a non-empty string");
    }
    built.label = label;
  }
  if ("multiline" in input) {
    const multiline: unknown = input.multiline;
    if (typeof multiline !== "boolean") {
      throw new TypeError("input multiline must be a boolean");
    }
    built.multiline = multiline;
  }
  return built;
}

/** A `data` wire event: one text chunk of the reply. */
export interface TextEvent {
  data: string;
}

/** A `current_tool_use` wire event: a tool call started. */
export interface ToolUseEvent {
  current_tool_use: { toolUseId: string | null; name: string | null };
}

/** A `tool_result` wire event: a tool call finished. */
export interface ToolResultEvent {
  tool_result: { toolUseId: string | null; status: "success" | "error" };
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

const APPROVAL_OPTIONS: readonly InterruptOption[] = [
  { value: "y", label: "Approve", style: "primary" },
  { value: "n", label: "Deny" },
];

const MAX_APPROVAL_ARGS_CHARS = 1500;

/**
 * Reduce a Mastra agent stream to the events Welt renders.
 *
 * Iterates the chunks of `Agent.stream()`'s (or `Agent.resumeStream()`'s)
 * `fullStream` and yields the wire's renderable subset: text chunks
 * (`data`), tool-use indicators (`current_tool_use` / `tool_result`,
 * slimmed so tool output stays off the wire), generated files (`file` —
 * the model's file parts, plus every `fileEvent`-shaped value a tool
 * writes to its execution context's stream writer), interrupts
 * (`interrupt` — a suspended tool call's id and suspend payload, the
 * latter passed through unmodified since interpreting a reason is the
 * renderer's job; a tool call awaiting `requireToolApproval` gets a
 * synthesized reason with Approve/Deny buttons whose `y` / `n` answer
 * maps to `approveToolCall` / `declineToolCall`), and failures (`error`,
 * from error and tripwire chunks). Everything else is dropped.
 *
 * @param chunks - The chunks of a Mastra agent stream, e.g. `fullStream`.
 * @yields The renderable wire events, in stream order.
 */
export async function* renderableEvents(
  chunks: AsyncIterable<unknown>,
): AsyncGenerator<RenderableEvent, void, undefined> {
  for await (const chunk of chunks) {
    if (!isRecord(chunk)) {
      continue;
    }
    const payload = chunk.payload;
    if (!isRecord(payload)) {
      continue;
    }
    switch (chunk.type) {
      case "text-delta": {
        if (typeof payload.text === "string" && payload.text.length > 0) {
          yield { data: payload.text };
        }
        break;
      }
      case "tool-call": {
        yield {
          current_tool_use: {
            toolUseId: stringOrNull(payload.toolCallId),
            name: stringOrNull(payload.toolName),
          },
        };
        break;
      }
      case "tool-result": {
        yield {
          tool_result: {
            toolUseId: stringOrNull(payload.toolCallId),
            status: payload.isError === true ? "error" : "success",
          },
        };
        break;
      }
      case "tool-error": {
        yield {
          tool_result: {
            toolUseId: stringOrNull(payload.toolCallId),
            status: "error",
          },
        };
        break;
      }
      case "tool-output": {
        const event = toolFileEvent(payload.output);
        if (event !== null) {
          yield event;
        }
        break;
      }
      case "file": {
        const bytes = fileBytes(payload.data);
        if (bytes !== null) {
          yield { file: { name: fileName(payload.mimeType), bytes } };
        }
        break;
      }
      case "tool-call-suspended": {
        const interrupt = interruptFields(payload);
        if (interrupt !== null) {
          yield { interrupt: { ...interrupt, reason: payload.suspendPayload } };
        }
        break;
      }
      case "tool-call-approval": {
        const interrupt = interruptFields(payload);
        if (interrupt !== null) {
          yield {
            interrupt: {
              ...interrupt,
              reason: approvalReason(interrupt.name, payload.args),
            },
          };
        }
        break;
      }
      case "error": {
        yield { error: errorText(payload.error) };
        break;
      }
      case "tripwire": {
        yield {
          error:
            typeof payload.reason === "string" && payload.reason.length > 0
              ? payload.reason
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolFileEvent(output: unknown): FileEvent | null {
  if (!isRecord(output) || !isRecord(output.file)) {
    return null;
  }
  const { name, bytes } = output.file;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof bytes !== "string"
  ) {
    return null;
  }
  return { file: { name, bytes } };
}

function fileBytes(data: unknown): string | null {
  // A string is already base64; Mastra sets `payload.base64` only when
  // `data` is a string, and to the same value.
  if (typeof data === "string" && data.length > 0) {
    return data;
  }
  if (data instanceof Uint8Array && data.length > 0) {
    return Buffer.from(data).toString("base64");
  }
  return null;
}

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

function interruptFields(
  payload: Record<string, unknown>,
): { id: string; name: string } | null {
  // Welt requires a non-empty id (the resume key) and a string name.
  if (
    typeof payload.toolCallId !== "string" ||
    payload.toolCallId.length === 0
  ) {
    return null;
  }
  return {
    id: payload.toolCallId,
    name: typeof payload.toolName === "string" ? payload.toolName : "",
  };
}

function approvalReason(toolName: string, args: unknown): InterruptReason {
  const heading =
    toolName.length > 0 ? `May I run \`${toolName}\`?` : "May I run this tool?";
  const rendered = renderedArgs(args);
  return {
    message:
      rendered === null ? heading : `${heading}\n\`\`\`\n${rendered}\n\`\`\``,
    options: APPROVAL_OPTIONS.map((option) => ({ ...option })),
  };
}

function renderedArgs(args: unknown): string | null {
  if (!isRecord(args) || Object.keys(args).length === 0) {
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
