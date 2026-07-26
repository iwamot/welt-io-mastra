# @welt-io/mastra

[![npm](https://img.shields.io/npm/v/%40welt-io%2Fmastra.svg)](https://www.npmjs.com/package/@welt-io/mastra)
[![node](https://img.shields.io/node/v/%40welt-io%2Fmastra.svg)](https://www.npmjs.com/package/@welt-io/mastra)

The [Mastra](https://mastra.ai/) (TypeScript) adapter for [Welt](https://github.com/iwamot/welt)'s wire contract.

## Install

```bash
npm install @welt-io/mastra
```

## Usage

See [`examples/agent`](examples/agent) — the smallest complete agent built on this package (text streaming, tool use, file output, file input, and human-approval tools). The sections below explain the adapters it wires in.

## API

The wire between Welt and the agent is JSON, specified by [Welt's wire contract](https://github.com/iwamot/welt/blob/main/docs/wire.md) — plain Mastra values do not fit it in either direction. Two functions adapt the inbound payload, three the outbound stream.

### Inbound

#### `decodeMessages(messages)`

Turns Welt's Converse-shaped messages — built from the Slack thread, file bytes base64-encoded — into the AI SDK model messages `Agent.stream()` consumes:

| Converse block | Model message part |
|---|---|
| Text | Text |
| Image | Image |
| Document / video | File |

Each file-carrying part gets the media type Mastra expects in place of the Converse format token. Malformed entries are skipped.

#### `decodeInterruptResponses(responses)`

Turns Welt's resume payload — a mapping of interrupt id to the answer a human chose — into `{toolCallId, answer}` pairs, one per `Agent.resumeStream(answer, { runId, toolCallId })` call. The interrupt id is the suspended tool call's id, as emitted by `renderableEvents`; the run id is the interrupted stream's `runId`, which the host app stashes when an interrupt event goes by (see the [example agent](examples/agent)).

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

#### `fileEvent(name, data)`

Builds the same `file` event from a filename and raw bytes, for the files the host app attaches itself. Yield it alongside the reduced stream:

```ts
yield fileEvent("report.csv", csvBytes);
```

Tools have no use for it — they hand files to the model as tool-result content, and `filesFrom` decides which of those reach the thread.

#### `interruptReason(message, options, input)`

Builds the structured reason Welt renders as a message with the specified widgets — choice buttons (`options`), a free-text field (`input`), or both. The specs are [the wire's own shapes](https://github.com/iwamot/welt/blob/main/docs/wire.md#interrupt); omitted fields keep Welt's defaults, and a typo becomes an immediate `TypeError` instead of a silent fallback to Welt's default rendering:

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

## Working with interrupts

[Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) covers the Slack side: how each reason renders, who can answer, multiple questions, and expiry. On the Mastra side:

- **Register the agent on a `Mastra` instance** and drive it through `mastra.getAgent(...)`. That instance is what holds the suspended run, so an agent built and streamed on its own has nothing for `resumeStream` to find.
- **Code before `suspend` runs again on resume.** Mastra re-executes the tool from its start, and the resumed pass gets the human's answer but not the suspend payload it was answering. So work that must not run twice — side effects, or work that must match what the human approved — belongs in the `resumeData === undefined` branch, and whatever the second pass needs from it has to outlive the pause. A map keyed on `context.agent.toolCallId`, the same id on both passes, is enough: it lives in the same process as the suspended run it pairs with. The [example agent](examples/agent)'s `sample_draft_report` shows the pattern.

## Supported Versions

Welt releases first; @welt-io/mastra follows, mirroring the minor version. While both are 0.x, a @welt-io/mastra 0.Y release supports Welt v0.Y — other combinations may work, but come with no guarantee.

## License

MIT
