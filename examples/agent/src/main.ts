/**
 * A small AgentCore agent that Welt can drive.
 *
 * Receives Welt's payload, feeds it to a Mastra agent, and yields the
 * renderable subset of its stream chunks — BedrockAgentCoreApp emits each
 * one as SSE, which Welt (https://github.com/iwamot/welt) renders into
 * Slack. The payload carries one of two envelopes: Converse-shaped
 * `messages` for a conversation turn, or `interrupt_responses` when a
 * human answered the approval buttons of an interrupted run.
 *
 * This example is a standalone deployable; Welt drives it only through
 * the JSON wire contract, which @welt-io/mastra adapts in both directions.
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import type { RenderableEvent } from "@welt-io/mastra";
import {
  decodeInterruptResponses,
  decodeMessages,
  fileEvent,
  interruptReason,
  renderableEvents,
} from "@welt-io/mastra";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

// The AWS SDK provider chain picks up the AgentCore Runtime workload
// credentials; the AI SDK's default env-var resolution would not.
const bedrock = createAmazonBedrock({
  credentialProvider: fromNodeProviderChain(),
});

const currentTime = createTool({
  id: "current_time",
  description: "Get the current date and time.",
  inputSchema: z.object({}),
  execute: async () => new Date().toISOString(),
});

const attachSampleFile = createTool({
  id: "attach_sample_file",
  description: "Attach a small sample CSV file to the Slack thread.",
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    // A `fileEvent`-shaped value written to the tool's stream surfaces as
    // a `file` wire event, which Welt uploads to the thread.
    const csv = new TextEncoder().encode("fruit,count\napple,3\nbanana,5\n");
    await context?.writer?.write(fileEvent("sample.csv", csv));
    return "Attached sample.csv to the thread.";
  },
});

const sampleDangerousAction = createTool({
  id: "sample_dangerous_action",
  description:
    "Pretend to run a dangerous or irreversible action the user asked for.",
  inputSchema: z.object({
    action: z.string().describe("The action to pretend to run."),
  }),
  resumeSchema: z.string(),
  // A sample of the approval round trip: the suspend below pauses the run
  // until someone answers in the Slack thread — with the buttons, or by
  // typing an instruction into the text field. Nothing is actually
  // executed.
  execute: async (input, context) => {
    const answer = context?.agent?.resumeData;
    if (answer === undefined) {
      await context?.agent?.suspend(
        interruptReason(
          `May I run this dangerous action? — ${input.action}`,
          [
            { value: "y", label: "Approve", style: "primary" },
            { value: "n", label: "Cancel" },
          ],
          { label: "Or tell me what to do instead" },
        ),
      );
      return undefined;
    }
    if (answer === "y") {
      return `Ran: ${input.action}. (This example doesn't actually run anything.)`;
    }
    if (answer === "n") {
      return "The action was cancelled by the user.";
    }
    return `The action was not run. The user said instead: ${answer}`;
  },
});

const agent = new Agent({
  id: "welt-example-agent",
  name: "Welt example agent",
  description: "A sample agent that replies in a Slack thread through Welt.",
  instructions:
    "You are a helpful assistant replying in a Slack thread. Keep replies concise.",
  model: bedrock(process.env.MODEL_ID ?? "global.anthropic.claude-opus-4-8"),
  // The record keys are the tool names the model and the thread see.
  tools: {
    current_time: currentTime,
    attach_sample_file: attachSampleFile,
    sample_dangerous_action: sampleDangerousAction,
  },
});

// Where an interrupted run waits for its answers. One slot is enough:
// AgentCore Runtime runs each session in its own microVM, so this process
// never serves two sessions. Resume only: a normal turn always streams
// from the messages Welt sends (the Slack thread is the source of truth
// for conversation history, so the slot must not stand in for it). No
// persistence either — Mastra stashes the suspended run in this process's
// memory, and both live and die with the session's microVM (recycled on
// idle timeout, 8 hours at most).
let suspendedRunId: string | null = null;

/**
 * Reduce one agent stream to wire events, re-stashing the run id whenever
 * the stream stops for human input so a resume that interrupts again
 * keeps working.
 *
 * Each event is wrapped as `{data: event}`: the AgentCore SDK treats a
 * yielded object's `data` field as the SSE data payload, so the wrapper
 * puts the wire event itself — text events included, whose own `data` key
 * would otherwise be mistaken for the envelope — on the `data:` line.
 */
async function* replies(
  stream: Awaited<ReturnType<typeof agent.stream>>,
): AsyncGenerator<{ data: RenderableEvent }> {
  let interrupted = false;
  for await (const event of renderableEvents(stream.fullStream)) {
    if ("interrupt" in event) {
      interrupted = true;
    }
    yield { data: event };
  }
  if (interrupted) {
    suspendedRunId = stream.runId;
  }
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async function* (payload: unknown) {
      const envelope = payloadEnvelope(payload);

      if (envelope.interruptResponses !== undefined) {
        const runId = suspendedRunId;
        suspendedRunId = null;
        if (runId === null) {
          // The microVM was recycled while the buttons waited. The SDK
          // reports the throw as an `error` event, and Welt renders its
          // resume-failure notice.
          throw new Error("No interrupted run to resume in this session.");
        }
        for (const { toolCallId, answer } of decodeInterruptResponses(
          envelope.interruptResponses,
        )) {
          yield* replies(
            await agent.resumeStream(answer, { runId, toolCallId }),
          );
        }
        return;
      }

      const messages = decodeMessages(envelope.messages);
      if (messages.length === 0) {
        yield {
          data: {
            data: "I received an empty conversation, so there is nothing to reply to.",
          },
        };
        return;
      }
      yield* replies(await agent.stream(messages));
    },
  },
});

function payloadEnvelope(payload: unknown): {
  messages?: unknown;
  interruptResponses?: unknown;
} {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return "interrupt_responses" in record
    ? { interruptResponses: record.interrupt_responses }
    : { messages: record.messages };
}

app.run();
