/**
 * A small AgentCore agent that Welt can drive.
 *
 * Receives Welt's payload, feeds it to a Mastra agent, and streams back
 * the renderable subset of its stream chunks — BedrockAgentCoreApp emits
 * each one as SSE, which Welt (https://github.com/iwamot/welt) renders
 * into Slack. `startReply` reads which envelope Welt sent (a conversation
 * turn, or the answers that resume an interrupted run), decodes it, and
 * starts the streams that answer it; `renderableEvents` reduces what they
 * carry. Keeping an interrupted run until its buttons are answered is
 * this file's job, below.
 *
 * This example is a standalone deployable; Welt drives it only through
 * the JSON wire contract, which @welt-io/mastra adapts in both directions.
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import type { ToolResultContent } from "@welt-io/mastra";
import { interruptReason, renderableEvents, startReply } from "@welt-io/mastra";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

// The model is the one place that decides which Bedrock endpoint, API, and
// region the agent talks to; nothing else in this file depends on that
// choice. The AI SDK's Bedrock provider speaks Converse to bedrock-runtime,
// so MODEL_ID takes any Converse model there. The AWS SDK provider chain
// picks up the AgentCore Runtime workload credentials; the AI SDK's default
// env-var resolution would not. The region has no such chain to fall back
// on: BEDROCK_REGION names it, and unset the provider reads AWS_REGION and
// nothing else — not AWS_DEFAULT_REGION, not the profile. `||`, not `??`: an
// empty value means unset, like Welt's own variables.
const bedrock = createAmazonBedrock({
  credentialProvider: fromNodeProviderChain(),
  ...(process.env.BEDROCK_REGION ? { region: process.env.BEDROCK_REGION } : {}),
});
const model = bedrock(
  process.env.MODEL_ID || "global.anthropic.claude-sonnet-4-6",
);

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
  // A sample of the other pause: Mastra holds the call before the tool
  // runs, and the adapter turns that into Welt's Approve / Reject
  // buttons. The pause below in `sample_dangerous_action` is the tool's
  // own, and reaches the thread the same way.
  requireApproval: true,
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
  resumeSchema: z.union([z.boolean(), z.string()]),
  // A sample of the approval round trip: the suspend below pauses the run
  // until someone answers in the Slack thread — with the buttons, or by
  // typing an answer into the text field. Nothing is actually
  // executed.
  execute: async (input, context) => {
    const answer = context?.agent?.resumeData;
    if (answer === undefined) {
      await context?.agent?.suspend(
        interruptReason({
          message: `May I run this dangerous action? — ${input.action}`,
          approve: {},
          reject: { label: "Cancel" },
          input: { label: "Or type your answer" },
        }),
      );
      return undefined;
    }
    if (answer === true) {
      return `Ran: ${input.action}. Completed successfully (simulated by this demo tool).`;
    }
    if (answer === false) {
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
    const toolCallId = context?.agent?.toolCallId;
    if (toolCallId === undefined) {
      throw new Error("This tool needs its tool call id to keep the draft.");
    }
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
        interruptReason({
          message: `May I publish this draft?\n\n\`\`\`\n${draft}\`\`\``,
          options: [
            { value: "Publish", style: "primary" },
            { value: "Discard" },
          ],
          input: { label: "Or type your answer" },
        }),
      );
      return undefined;
    }
    // The draft is what the human approved, so there is nothing to fall back
    // to: publishing an empty file — or a redraft — would publish something
    // other than what they saw.
    const draft = drafts.get(toolCallId);
    if (draft === undefined) {
      throw new Error("The approved draft is gone; it lives in this process.");
    }
    drafts.delete(toolCallId);
    if (answer === "Publish") {
      return fileContent(
        "The user answered the publish question in the thread by pressing" +
          " Publish, so this draft is already published there as report.md." +
          " The publish flow is complete; nothing is left to approve.",
        "report.md",
        "text/markdown",
        new TextEncoder().encode(draft),
      );
    }
    if (answer === "Discard") {
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
      model,
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

// The ids of the runs that stopped for approval, under the ids of the
// tool calls they stopped on — Welt sends those back when the buttons are
// answered. The run itself lives on the `Mastra` instance above; this map
// only remembers which one to resume. An entry lives as long as this
// process: AgentCore Runtime gives each session its own microVM, so a
// resume that arrives after it was recycled finds nothing and throws,
// which Welt renders as its resume-failure notice.
const interrupted = new Map<string, string>();

/**
 * Take the run the answered questions belong to, and let the whole stop
 * go from the map.
 *
 * A stop's questions are answered together, so every id in one payload
 * names the same run; every entry holding that run leaves with it,
 * including any the payload did not answer.
 *
 * Throws when no answered id is held — a resume that arrives after the
 * process was recycled finds nothing.
 */
function resumed(answers: Record<string, unknown>): string {
  const runId = Object.keys(answers)
    .map((id) => interrupted.get(id))
    .find((value) => value !== undefined);
  if (runId === undefined) {
    throw new Error("No interrupted run to resume in this session.");
  }
  for (const [id, value] of interrupted) {
    if (value === runId) {
      interrupted.delete(id);
    }
  }
  return runId;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: unknown) {
      const envelope = payload as {
        interrupt_responses?: Record<string, unknown>;
      };
      const answers = envelope.interrupt_responses;
      const runId = answers === undefined ? undefined : resumed(answers);

      // A resume is one stream per answer; a conversation turn is one.
      for await (const stream of startReply(agent, payload, {
        ...(runId === undefined ? {} : { runId }),
      })) {
        for await (const event of renderableEvents(stream.fullStream, {
          filesFrom: FILES_FROM,
        })) {
          if ("interrupt" in event) {
            // The run stopped here, and its id is what resumes it when
            // the buttons come back.
            interrupted.set(event.interrupt.id, stream.runId);
          }
          // The AgentCore Runtime SDK puts a yielded object's `data`
          // field on the SSE `data:` line.
          yield { data: event };
        }
      }
    },
  },
});

app.run();
