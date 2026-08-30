# @welt-io/mastra

[![npm](https://img.shields.io/npm/v/%40welt-io%2Fmastra.svg)](https://www.npmjs.com/package/@welt-io/mastra)
[![node](https://img.shields.io/node/v/%40welt-io%2Fmastra.svg)](https://www.npmjs.com/package/@welt-io/mastra)
[![@mastra/core](https://img.shields.io/npm/dependency-version/%40welt-io%2Fmastra/peer/%40mastra%2Fcore.svg)](https://www.npmjs.com/package/@mastra/core)

The [Mastra](https://mastra.ai/) (TypeScript) adapter for [Welt](https://github.com/iwamot/welt)'s wire contract.

## Install

```bash
npm install @welt-io/mastra
```

`@mastra/core` comes with it as a peer dependency: the messages this package builds and the stream chunks it reads are Mastra's own types.

## Usage

`startReply` and `renderableEvents` are the wiring between Welt's payload and a Mastra agent, so a deployable is your agent plus a short handler:

```ts
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { renderableEvents, startReply } from "@welt-io/mastra";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

const bedrock = createAmazonBedrock({
  credentialProvider: fromNodeProviderChain(),
});

const mastra = new Mastra({
  agents: {
    assistant: new Agent({
      id: "assistant",
      name: "Assistant",
      instructions: "You are a helpful assistant replying in a Slack thread.",
      model: bedrock("global.anthropic.claude-sonnet-4-6"),
    }),
  },
});

const agent = mastra.getAgent("assistant");

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: unknown) {
      for await (const stream of startReply(agent, payload)) {
        for await (const event of renderableEvents(stream.fullStream)) {
          yield { data: event };
        }
      }
    },
  },
});

app.run();
```

An agent with approval tools keeps the run ids it needs to resume; [`examples/agent`](examples/agent) shows that — a map in the entrypoint, keyed on interrupt id, and a lookup beside it that hands back the run the answers name and drops the whole stop with it.

See [`examples/agent`](examples/agent) for the full version — the smallest complete agent built on this package (text streaming, tool use, file output, file input, and human-approval tools). The sections below cover the handler and the adapters it wires in.

## Supported Versions

### Welt

While both are 0.x, a @welt-io/mastra 0.Y release supports Welt v0.Y. From 1.0 on, a release supports any Welt release that shares its major version, and the minor versions move independently. Support is best effort either way, and other combinations come with no guarantee.

### Mastra

The badge at the top states the range this release installs against. Every push and pull request runs the suite at both ends of it: the declared floor, and the newest release CI has picked up. That is best effort rather than a guarantee — the floor is where the suite was last seen to pass, so a later release may raise it, and no ceiling is declared at all.

The badge follows the current release. For the range an older release declared, read that release's own metadata on npm.

Something misbehaving inside that range is worth an [issue](https://github.com/iwamot/welt-io-mastra/issues).

## API

The wire between Welt and the agent is JSON, specified by [Welt's wire contract](https://github.com/iwamot/welt/blob/main/docs/wire.md) — plain Mastra values do not fit it in either direction. Two functions adapt the inbound payload, two the outbound stream. `startReply` wires the inbound pair into the streams of one reply (`interruptReason` serves the tools themselves); reach for the pieces directly when your handler needs a shape of its own — messages to edit before the run, an agent to stream some other way.

### Reply

#### `startReply(agent, payload, { runId })`

Starts the streams that reply to Welt's payload. It reads which envelope Welt sent — Converse-shaped `messages` for a conversation turn, `interrupt_responses` for the answers that resume an interrupted run — decodes it, and streams the agent on the result. Each stream's `fullStream` is what `renderableEvents` below takes.

A conversation turn is one stream. A resume is one per answer, since Mastra resumes a suspended tool call by its own id: a stop that asked two questions is answered in two calls. The generator is lazy — each resume starts only when you pull the next stream — so drain each stream before pulling again, and each call picks up where the last left off. The agent must live on a `Mastra` instance, because that instance is what holds a suspended run — an Agent streamed on its own keeps no suspended run for `resumeStream` to find.

Each stream carries the `runId` that resumes it. Where to keep that — and for how long an unanswered approval stays answerable — is the agent's to decide; answers with no `runId` beside them throw. Nothing is held here.

### Inbound

#### `decodeMessages(messages)`

Turns Welt's Converse-shaped messages — built from the Slack thread, file bytes base64-encoded — into the AI SDK model messages `Agent.stream()` consumes:

| Converse block | Model message part |
|---|---|
| Text | Text |
| Image | Image |
| Document / video | File |

Each file-carrying part gets the media type an AI SDK part takes in place of the Converse format token — every format token the wire carries has one. The base64 travels on as it arrived, since an AI SDK part takes the string itself.

#### `decodeInterruptResponses(responses)`

Turns Welt's resume payload — a mapping of interrupt id to the answer a human chose and the widget it came from — into `{toolCallId, answer}` pairs, the answer travelling on as the value it was given, one per `Agent.resumeStream(answer, { runId, toolCallId })` call. The interrupt id is the suspended tool call's id, as emitted by `renderableEvents`; the run id is the interrupted stream's `runId`, which the handler stashes when an interrupt event goes by.

#### What arrives is taken as correct

Welt builds the payload and checks its own output against the wire contract before releasing it, so these two functions do no field validation of their own. Their parameter types — `WireMessage[]` and `Readonly<Record<string, InterruptAnswer>>` — say what arrives, and the payload is asserted to be Welt's where it enters — `startReply` does this at its door. A payload that departs from the contract is a bug on the sending side rather than an input to guard against, and it surfaces as an ordinary error from whatever touches it first.

The one thing `decodeMessages` refuses outright is a content block of a kind Welt never sends. A `messages` turn carries only `text`, `image`, `document`, and `video` blocks; a `toolUse` or `toolResult` block is not a malformed one of those but a forged conversation turn, and rebuilt into history it would let a caller that is not Welt put words the model treats as its own past tool calls and their results into the run. It throws an `Error`. This is a trust-boundary check, not the field validation the contract otherwise saves you from.

### Outbound

#### `renderableEvents(chunks, { filesFrom })`

Reduces the chunks of `Agent.stream()`'s (or `Agent.resumeStream()`'s) `fullStream` — whose shapes Welt does not render — to the events Welt renders:

| Mastra emits | On the wire | In the Slack thread |
|---|---|---|
| Text deltas | `data` | The streamed reply |
| Tool calls and results | `current_tool_use` / `tool_result` | "Using tool" indicators (tool output stays off the wire) |
| File parts the model produces, or a tool named in `filesFrom` returns | `file` | An uploaded file ([size limits](https://github.com/iwamot/welt/blob/main/docs/wire.md#limits)) |
| Failures | `error` | A reply failure notice |
| Suspended tool calls | `interrupt` | Buttons and/or a text field |

A run that stops for human input ends its stream with one `interrupt` event per suspended tool call; agents that do not suspend see no change. Two suspension flavors map:

- An explicit `suspend(...)` in a tool passes its suspend payload through as the interrupt reason unmodified — build it with `interruptReason` below to control the widgets. The answer comes back as the resume data, so the tool's `resumeSchema` has to admit everything the widgets it asked for can answer with: `approve` and `reject` answer with a boolean, an option with its own `value`, a text field with a string. The [example agent](examples/agent)'s approval tool offers buttons and a text field, so it declares `z.union([z.boolean(), z.string()])`.
- A tool call awaiting Mastra's [`requireToolApproval`](https://mastra.ai/docs/agents/human-in-the-loop) gets a synthesized reason whose Approve and Reject buttons answer with `{approved: true}` and `{approved: false}` — the resume input Mastra reads a decision out of, so the pressed button resumes the run through the same `resumeStream` call as any other answer, and a rejected call closes its indicator as an error. The [example agent](examples/agent)'s `create_sample_file` is gated this way.

A tool hands files to the model for either of two reasons — to have it read them, or to give them to the human — and only the agent knows which is which, so name the tools whose files belong in the thread:

```ts
for await (const event of renderableEvents(stream.fullStream, {
  filesFrom: ["create_sample_file"],
})) {
```

A tool left out keeps its files to the model: one that reads a PDF for the model does not drop it into the thread as a side effect. A tool named there hands the model a file the way any Mastra tool does — by returning AI SDK tool-result content, a `media` part per file, with `toModelOutput` putting that content in front of the model:

```ts
execute: async (): Promise<ToolResultContent> => ({
  type: "content",
  value: [
    { type: "text", text: "Created sample.csv." },
    { type: "media", data: base64Csv, mediaType: "text/csv", filename: "sample.csv" },
  ],
}),
toModelOutput: (output) => output,
```

`ToolResultContent` is exported for that annotation: content the adapter cannot read carries no file and says nothing about it, so a typo is better caught by the compiler.

Uploaded names come from the `filename`, and it is yours to pick — nothing else in the run competes for it; left off, the upload falls back to the media type (`file.csv`, `image.png`). The model sees another name on the file itself, because Mastra drops the `filename` from tool result content on the way to the model and the Bedrock provider falls back to naming the document it builds (`document-1`) — its handle on the document rather than a filename. So a tool that wants the model to use the upload name says it in the text part, as above, and the [example agent](examples/agent) adds a line to its instructions to keep the model from repeating the internal one.

Each event carries only what Welt reads — a `current_tool_use` is the name and id behind the indicator, a `tool_result` the id and status — so tool arguments and tool output stay off the wire. An event with nothing to render is not sent at all: a text chunk the model left empty, a file that points at its bytes by URL rather than carrying them, and a file with no bytes, which Slack refuses and fails the whole reply with. The empty one leaves a [process warning](https://nodejs.org/api/process.html#event-warning) behind, naming what returned it.

#### `interruptReason(spec)`

Builds the structured reason Welt renders as a message with the specified widgets — the approve and reject buttons Welt words and values itself (`approve`, `reject`), choice buttons of your own (`options`), a free-text field (`input`), or any combination. `approve` and `reject` answer with `true` and `false`, so a question whose decision is approval asks for them by name instead of inventing values; `{}` takes Welt's wording, and a `label` or `style` overrides it. An option's `value` is any JSON value, and the pressed button answers with it as it was declared. With no widget at all the message renders as itself and Welt's default buttons answer it. The specs are [the wire's own shapes](https://github.com/iwamot/welt/blob/main/docs/wire.md#interrupt), typed as `ReasonSpec` over `DecisionSpec`, `OptionSpec`, and `InputSpec`, and omitted fields keep Welt's defaults:

```ts
await context.agent.suspend(
  interruptReason({
    message: "Deploy to prod?",
    approve: { label: "Deploy" },
    reject: { label: "Cancel" },
    input: { label: "Or type your answer" },
  }),
);
```

Building the reason through this helper is what makes a typo an error. A tool that declares no `suspendSchema` takes its suspend payload as `unknown`, so an object literal handed to `suspend` directly is checked by nothing, and Welt's reaction to a reason it cannot match is its default buttons — no error, no log, just widgets you did not ask for. The typed parameters catch a misspelled key before the run; the checks inside catch it in the runs the types miss, since TypeScript's excess-property check fires on an object literal written at the call site and not on one that reached it through a variable. A wrong type throws a `TypeError`, an unknown key or an empty required string an `Error`. What they check is the shape, not the size: how many buttons one Slack block holds, and how long a button value may be, are Welt's to enforce.

## Working with interrupts

[Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) covers the Slack side: how each reason renders, who can answer, multiple questions, and expiry. On the Mastra side:

- **Register the agent on a `Mastra` instance** and drive it through `mastra.getAgent(...)`. That instance is what holds the suspended run, so an agent built and streamed on its own has nothing for `resumeStream` to find.
- **Code before `suspend` runs again on resume.** Mastra re-executes the tool from its start, and the resumed pass gets the human's answer but not the suspend payload it was answering. So work that must not run twice — side effects, or work that must match what the human approved — belongs in the `resumeData === undefined` branch, and whatever the second pass needs from it has to outlive the pause. A map keyed on `context.agent.toolCallId`, the same id on both passes, is enough: it lives in the same process as the suspended run it pairs with. The [example agent](examples/agent)'s `sample_draft_report` shows the pattern.

## License

MIT
