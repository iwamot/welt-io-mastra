/**
 * The AgentCore Runtime invocation handler for a Mastra agent Welt drives.
 *
 * `weltAgent` builds the handler that `BedrockAgentCoreApp` serves, so an
 * agent connects to Welt without rewriting the wiring every deployable
 * needs: telling a conversation turn from the answers that resume an
 * interrupted run, decoding each envelope, keeping the interrupted run's
 * id until its answers arrive, reducing the stream to the events Welt
 * renders, and wrapping each one as `{ data: event }` — the AgentCore
 * Runtime SDK treats a yielded object's `data` field as the SSE data
 * payload, so the wrapper puts the wire event itself on the `data:` line.
 * The example agent of this repository once wrote this wiring out by
 * hand; this module is the same wiring as a function.
 *
 * The interrupted run's id waits inside the returned handler, under the
 * runtime's own lifecycle: AgentCore Runtime serves each session from its
 * own microVM, so one slot is enough, and the slot lives and dies with
 * that microVM — resuming after it was recycled (idle timeout, 8 hours at
 * most) throws an error the AgentCore Runtime SDK reports as an `error`
 * event, which Welt renders as its resume-failure notice. The run itself
 * is stashed by Mastra in the same process, which is why the agent must
 * be driven through a `Mastra` instance: an Agent streamed on its own
 * keeps no suspended run for `resumeStream` to find.
 *
 * `sendFile` hands the Slack thread a file without handing it to the
 * model: a tool queues the file, and the handler puts it on the wire
 * beside the events of the reply being streamed. The model never sees
 * what was sent, so a tool whose file matters to the conversation says
 * what it holds in its result — or returns the file as a media part of
 * its tool-result content and is named in `filesFrom` instead.
 */

import { Buffer } from "node:buffer";
import type { AIV5Type } from "@mastra/core/agent/message-list";
import type { ChunkType } from "@mastra/core/stream";
import type {
  FileEvent,
  InterruptAnswer,
  JsonValue,
  RenderableEvent,
  WireMessage,
} from "./index.ts";
import {
  decodeInterruptResponses,
  decodeMessages,
  renderableEvents,
} from "./index.ts";

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

/** What `weltAgent` takes beside the agent. */
export interface WeltAgentOptions {
  /**
   * The names of the tools whose media parts become `file` events, as
   * `renderableEvents` takes it. Omitted, no tool's files reach the
   * thread this way.
   */
  filesFrom?: Iterable<string>;
}

/** An SSE frame: the wire event on the `data:` line. */
export interface DataFrame {
  data: RenderableEvent;
}

/** What `BedrockAgentCoreApp` takes as its `invocationHandler`. */
export interface InvocationHandler {
  process(payload: unknown): AsyncGenerator<DataFrame, void, undefined>;
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

// The files queued by `sendFile`, on their way to the Slack thread. One
// queue for the process, like the interrupt slot is one per handler:
// AgentCore Runtime serves each session from its own microVM, so no other
// reply's files can interleave with the running one's.
const pendingFiles: FileEvent[] = [];

/**
 * Queue one file for the Slack thread, beside the reply being streamed.
 *
 * The file rides the wire between the events of the running reply, and
 * never reaches the model. A tool that wants the model to know what the
 * file holds says so in its result — or returns the file as a media part
 * of its tool-result content and is named in `filesFrom`, which puts it
 * in front of the model and on the thread both.
 *
 * A file queued by a turn that failed before draining does not ride a
 * later reply: the handler starts every turn with the queue empty.
 *
 * @param name - The upload filename, extension included.
 * @param data - The raw file bytes.
 * @throws TypeError if the name or the data is of the wrong type.
 * @throws Error if either is empty. Slack refuses a zero-byte upload, and
 *   the whole reply fails with it, so an empty file is refused here,
 *   where the tool that queued it is still on the stack.
 */
export function sendFile(name: string, data: Uint8Array): void {
  pendingFiles.push({
    file: {
      name: checkedName(name),
      bytes: Buffer.from(checkedData(data)).toString("base64"),
    },
  });
}

/** Check an upload filename. */
function checkedName(name: unknown): string {
  if (typeof name !== "string") {
    throw new TypeError(`name must be a string, not ${typeof name}`);
  }
  if (name.length === 0) {
    throw new Error("name must not be empty");
  }
  return name;
}

/** Check a file's bytes. */
function checkedData(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("data must be a Uint8Array");
  }
  if (data.length === 0) {
    throw new Error("data must not be empty; Slack refuses an empty upload");
  }
  return data;
}

/** Take every queued file off the queue, in order, as SSE frames. */
function* drainedFrames(): Generator<DataFrame, void, undefined> {
  for (const file of pendingFiles.splice(0, pendingFiles.length)) {
    yield { data: file };
  }
}

/**
 * Build the AgentCore Runtime invocation handler for an agent Welt drives.
 *
 * The returned object is what `BedrockAgentCoreApp` takes:
 *
 * ```ts
 * const app = new BedrockAgentCoreApp({
 *   invocationHandler: weltAgent(agent, { filesFrom: ["generate_image"] }),
 * });
 * ```
 *
 * It reads which envelope Welt sent — Converse-shaped `messages` for a
 * conversation turn, `interrupt_responses` for the answers that resume an
 * interrupted run — drives the agent, and yields the events Welt renders,
 * the files tools queued with `sendFile` among them. A conversation turn
 * always streams fresh from the messages Welt sends, because the Slack
 * thread is the source of truth for conversation history and the payload
 * already carries it whole; resuming a run its microVM no longer holds
 * throws, which the AgentCore Runtime SDK reports as an `error` event and
 * Welt renders as its resume-failure notice.
 *
 * @param agent - The agent to drive, living on a `Mastra` instance — that
 *   instance is what holds an interrupted run for `resumeStream` to find.
 * @param options - `filesFrom`: the names of the tools whose media parts
 *   become `file` events.
 * @returns The invocation handler.
 */
export function weltAgent(
  agent: StreamingAgent,
  options?: WeltAgentOptions,
): InvocationHandler {
  const filesFrom = [...(options?.filesFrom ?? [])];
  let interruptedRunId: string | null = null;

  /**
   * Reduce one agent stream to SSE frames, re-stashing the run id
   * whenever the stream stops for human input so a resume that
   * interrupts again keeps working.
   */
  async function* relayed(
    stream: AgentStream,
  ): AsyncGenerator<DataFrame, void, undefined> {
    let interrupted = false;
    for await (const event of renderableEvents(stream.fullStream, {
      filesFrom,
    })) {
      if ("interrupt" in event) {
        interrupted = true;
      }
      yield { data: event };
      yield* drainedFrames();
    }
    // Files a tool queued after its result's events had already drained —
    // the stream's tail — still belong to this reply.
    yield* drainedFrames();
    if (interrupted) {
      interruptedRunId = stream.runId;
    }
  }

  return {
    async *process(payload: unknown) {
      // A failed turn's leftovers stay off this reply.
      pendingFiles.length = 0;
      const envelope = payload as WeltPayload;

      if ("interrupt_responses" in envelope) {
        const runId = interruptedRunId;
        interruptedRunId = null;
        if (runId === null) {
          // The microVM was recycled while the buttons waited.
          throw new Error("No interrupted run to resume in this session.");
        }
        for (const { toolCallId, answer } of decodeInterruptResponses(
          envelope.interrupt_responses,
        )) {
          yield* relayed(
            await agent.resumeStream(answer, { runId, toolCallId }),
          );
        }
        return;
      }

      yield* relayed(await agent.stream(decodeMessages(envelope.messages)));
    },
  };
}
