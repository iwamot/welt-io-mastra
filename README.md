# @welt-io/mastra

[![npm](https://img.shields.io/npm/v/%40welt-io%2Fmastra.svg)](https://www.npmjs.com/package/@welt-io/mastra)
[![node](https://img.shields.io/node/v/%40welt-io%2Fmastra.svg)](https://www.npmjs.com/package/@welt-io/mastra)

The [Mastra](https://mastra.ai/) (TypeScript) adapter for [Welt](https://github.com/iwamot/welt)'s wire contract.

## Install

```bash
npm install @welt-io/mastra
```

`@mastra/core` comes with it as a peer dependency: the messages this package builds and the stream chunks it reads are Mastra's own types.

## Usage

See [`examples/agent`](examples/agent) — the smallest complete agent built on this package (text streaming, tool use, file output, file input, and human-approval tools). The sections below explain the adapters it wires in.

## Supported Versions

### Welt

Welt releases first; @welt-io/mastra follows, mirroring the minor version. While both are 0.x, a @welt-io/mastra 0.Y release supports Welt v0.Y — other combinations may work, but come with no guarantee.

### Mastra

| Package | Installable | Version CI runs against |
|---|---|---|
| `@mastra/core` | `>=1.0.0` | <!-- renovate: datasource=npm depName=@mastra/core --> `1.55.0` |

Every push and pull request runs the suite at both ends of that range. That is best effort rather than a guarantee: the floor is where the suite was last seen to pass, so a later release may raise it, and no ceiling is declared at all.

Something misbehaving inside that range is worth an [issue](https://github.com/iwamot/welt-io-mastra/issues).

## API

The wire between Welt and the agent is JSON, specified by [Welt's wire contract](https://github.com/iwamot/welt/blob/main/docs/wire.md) — plain Mastra values do not fit it in either direction. Two functions adapt the inbound payload, two the outbound stream.

### Inbound

#### `decodeMessages(messages)`

Turns Welt's Converse-shaped messages — built from the Slack thread, file bytes base64-encoded — into the AI SDK model messages `Agent.stream()` consumes:

| Converse block | Model message part |
|---|---|
| Text | Text |
| Image | Image |
| Document / video | File |

Each file-carrying part gets the media type an AI SDK part takes in place of the Converse format token — every format token the wire carries has one. The base64 travels on as it arrived, since an AI SDK part takes the string itself.

Video is the exception, and the wire is not the reason: `@ai-sdk/amazon-bedrock` sends `image/*` to a Converse `image` block and everything else to a `document` block, and its media-type table holds no video type, so a video upload throws `Unsupported file mime type: video/mp4` while the request is being built — whatever the model. Leave `video` out of Welt's [`FILE_INPUT_MODALITIES`](https://github.com/iwamot/welt/blob/main/docs/files.md) when the agent runs on Bedrock.

#### `decodeInterruptResponses(responses)`

Turns Welt's resume payload — a mapping of interrupt id to the answer a human chose — into `{toolCallId, answer}` pairs, one per `Agent.resumeStream(answer, { runId, toolCallId })` call. The interrupt id is the suspended tool call's id, as emitted by `renderableEvents`; the run id is the interrupted stream's `runId`, which the host app stashes when an interrupt event goes by (see the [example agent](examples/agent)).

#### What arrives is taken as correct

Welt builds the payload and checks its own output against the wire contract before releasing it, so these two functions do no checking of their own. Their parameter types — `WireMessage[]` and `Record<string, string>` — say what arrives, and the host app asserts the payload is Welt's where it enters (see the [example agent](examples/agent)). A payload that departs from the contract is a bug on the sending side rather than an input to guard against, and it surfaces as an ordinary error from whatever touches it first.

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

- An explicit `suspend(...)` in a tool passes its suspend payload through as the interrupt reason unmodified — build it with `interruptReason` below to control the widgets. Declare `resumeSchema: z.string()` on the tool: the human's answer comes back as the resume data.
- A tool call awaiting Mastra's [`requireToolApproval`](https://mastra.ai/docs) gets a synthesized reason with **Approve** / **Deny** buttons whose `y` / `n` answer the host app maps to `approveToolCall` / `declineToolCall`.

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

#### `interruptReason(message, options, input)`

Builds the structured reason Welt renders as a message with the specified widgets — choice buttons (`options`), a free-text field (`input`), or both. The specs are [the wire's own shapes](https://github.com/iwamot/welt/blob/main/docs/wire.md#interrupt), typed as `OptionSpec` and `InputSpec`, and omitted fields keep Welt's defaults:

```ts
await context.agent.suspend(
  interruptReason(
    "Deploy to prod?",
    [
      { value: "y", label: "Deploy", style: "primary" },
      { value: "n", label: "Cancel" },
    ],
    { label: "Or type your answer" },
  ),
);
```

Building the reason through this helper is what makes a typo an error. A tool that declares no `suspendSchema` takes its suspend payload as `unknown`, so an object literal handed to `suspend` directly is checked by nothing, and Welt's reaction to a reason it cannot match is its default **Approve** / **Deny** buttons — no error, no log, just widgets you did not ask for. The typed parameters catch a misspelled key before the run; the checks inside catch it in the runs the types miss, since TypeScript's excess-property check fires on an object literal written at the call site and not on one that reached it through a variable. A wrong type throws a `TypeError`, an unknown key or an empty required string an `Error`. What they check is the shape, not the size: how many buttons one Slack block holds, and how long a button value may be, are Welt's to enforce.

## Working with interrupts

[Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) covers the Slack side: how each reason renders, who can answer, multiple questions, and expiry. On the Mastra side:

- **Register the agent on a `Mastra` instance** and drive it through `mastra.getAgent(...)`. That instance is what holds the suspended run, so an agent built and streamed on its own has nothing for `resumeStream` to find.
- **Code before `suspend` runs again on resume.** Mastra re-executes the tool from its start, and the resumed pass gets the human's answer but not the suspend payload it was answering. So work that must not run twice — side effects, or work that must match what the human approved — belongs in the `resumeData === undefined` branch, and whatever the second pass needs from it has to outlive the pause. A map keyed on `context.agent.toolCallId`, the same id on both passes, is enough: it lives in the same process as the suspended run it pairs with. The [example agent](examples/agent)'s `sample_draft_report` shows the pattern.

## License

MIT
