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
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import type { RenderableEvent, ToolResultContent } from "@welt-io/mastra";
import {
  decodeInterruptResponses,
  decodeMessages,
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

/** Build tool-result content that says something and nothing more. */
function textContent(text: string): ToolResultContent {
  return { type: "content", value: [{ type: "text", text }] };
}

/**
 * Build the tool-result content that hands the model one file.
 *
 * A media part is how a tool gives the model a file, and the tool's
 * `toModelOutput` is what puts the content in front of it. The `filename`
 * is the name @welt-io/mastra uploads the file under, free of the run's
 * other files: the Bedrock provider names the document it builds itself,
 * so nothing competes for the name a human reads.
 */
function fileContent(
  text: string,
  filename: string,
  mediaType: string,
  data: Uint8Array,
): ToolResultContent {
  return {
    type: "content",
    value: [
      { type: "text", text },
      {
        type: "media",
        data: Buffer.from(data).toString("base64"),
        mediaType,
        filename,
      },
    ],
  };
}

const createSampleFile = createTool({
  id: "create_sample_file",
  description: "Create a small sample CSV file.",
  inputSchema: z.object({}),
  execute: async () =>
    fileContent(
      "Created sample.csv.",
      "sample.csv",
      "text/csv",
      new TextEncoder().encode("fruit,count\napple,3\nbanana,5\n"),
    ),
  // The raw result is the agent's to keep; this is what the model sees.
  toModelOutput: (output) => output,
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
  // typing an answer into the text field. Nothing is actually
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
          { label: "Or type your answer" },
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
    return `The action was not run. The user answered: ${answer}`;
  },
});

// Draft bodies by tool call id, dropped as soon as their call is answered.
const drafts = new Map<string, string>();

const sampleDraftReport = createTool({
  id: "sample_draft_report",
  description: "Draft a small report on a topic and ask whether to publish it.",
  inputSchema: z.object({
    topic: z.string().describe("The report topic."),
  }),
  resumeSchema: z.string(),
  // A sample of work before a suspend: the draft is written first, then the
  // run pauses to show it for the publish decision, and approval returns
  // the approved draft as a markdown file.
  execute: async (input, context) => {
    const toolCallId = context?.agent?.toolCallId ?? "";
    const answer = context?.agent?.resumeData;
    if (answer === undefined) {
      // Drafting belongs in this branch alone: Mastra re-executes the tool
      // from its start on resume, and a redraft (timestamped here to make
      // that visible) would publish something other than what the human
      // approved. The draft outlives the pause in the map, since a resumed
      // execution gets the answer but not the suspend payload back.
      const draft =
        `# ${input.topic}\n\nEverything about ${input.topic} is going well.\n\n` +
        `_Drafted at ${new Date().toISOString()}._\n`;
      drafts.set(toolCallId, draft);
      await context?.agent?.suspend(
        interruptReason(
          `May I publish this draft?\n\n\`\`\`\n${draft}\`\`\``,
          [
            { value: "y", label: "Publish", style: "primary" },
            { value: "n", label: "Discard" },
          ],
          { label: "Or type your answer" },
        ),
      );
      return undefined;
    }
    const draft = drafts.get(toolCallId) ?? "";
    drafts.delete(toolCallId);
    if (answer === "y") {
      return fileContent(
        "The user answered the publish question in the thread by pressing" +
          " Publish, so this draft is already published there as report.md." +
          " The publish flow is complete; nothing is left to approve.",
        "report.md",
        "text/markdown",
        new TextEncoder().encode(draft),
      );
    }
    if (answer === "n") {
      return textContent(
        "The user discarded the draft; nothing was published.",
      );
    }
    return textContent(
      `The draft was not published. The user answered: ${answer}`,
    );
  },
  toModelOutput: (output) => output,
});

// The tools whose files belong in the Slack thread. A tool left out keeps
// its files to the model — this agent has none, but an agent that reads
// documents for the model would.
const FILES_FROM = ["create_sample_file", "sample_draft_report"];

// The agent lives on a Mastra instance and is driven through it, because
// that instance is what holds an interrupted run: an Agent streamed on its
// own keeps no suspended run for `resumeStream` to find.
const mastra = new Mastra({
  agents: {
    weltExample: new Agent({
      id: "welt-example-agent",
      name: "Welt example agent",
      description:
        "A sample agent that replies in a Slack thread through Welt.",
      // A document's name is the model's handle on it, not the filename a
      // human reads — and here the two differ: Mastra drops the filename
      // from tool result content, so the Bedrock provider falls back to
      // naming the document it builds (`document-1`) while Welt uploads
      // under the name the tool gave. Left unsaid, the model announces the
      // name the user cannot see.
      instructions:
        "You are a helpful assistant replying in a Slack thread. Keep replies" +
        " concise. Files reach the thread under the names their tools state;" +
        " never refer to a file by the name it carries as a document.",
      // `||`, not `??`: an empty MODEL_ID means unset, like Welt's own variables.
      model: bedrock(
        process.env.MODEL_ID || "global.anthropic.claude-sonnet-4-6",
      ),
      // The record keys are the tool names the model and the thread see.
      tools: {
        current_time: currentTime,
        create_sample_file: createSampleFile,
        sample_dangerous_action: sampleDangerousAction,
        sample_draft_report: sampleDraftReport,
      },
    }),
  },
});
const agent = mastra.getAgent("weltExample");

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
  for await (const event of renderableEvents(stream.fullStream, {
    filesFrom: FILES_FROM,
  })) {
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
