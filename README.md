# @welt-io/mastra

[![npm](https://img.shields.io/npm/v/%40welt-io%2Fmastra.svg)](https://www.npmjs.com/package/@welt-io/mastra)
[![node](https://img.shields.io/node/v/%40welt-io%2Fmastra.svg)](https://www.npmjs.com/package/@welt-io/mastra)

The [Mastra](https://mastra.ai/) (TypeScript) adapter for [Welt](https://github.com/iwamot/welt)'s wire contract — one of Welt's [agent-side adapters](https://github.com/iwamot/welt#agent-side-adapters).

## Install

```bash
npm install @welt-io/mastra
```

## Usage

See [`examples/agent`](examples/agent) — the smallest complete agent built on this package (text streaming, tool use, file output, file input, and a human-approval tool). The sections below explain the adapters it wires in.

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

#### `renderableEvents(chunks)`

Reduces the chunks of `Agent.stream()`'s (or `Agent.resumeStream()`'s) `fullStream` — whose shapes Welt does not render — to the events Welt renders:

| Mastra emits | On the wire | In the Slack thread |
|---|---|---|
| Text deltas | `data` | The streamed reply |
| Tool calls and results | `current_tool_use` / `tool_result` | "Using tool" indicators (tool output stays off the wire) |
| File parts the model produces | `file` | An uploaded file ([size limits](https://github.com/iwamot/welt/blob/main/docs/wire.md#limits)) |
| Failures | `error` | A reply failure notice |
| Suspended tool calls | `interrupt` | Buttons and/or a text field |

A run that stops for human input ends its stream with one `interrupt` event per suspended tool call; agents that do not suspend see no change. Two suspension flavors map:

- An explicit `suspend(...)` in a tool passes its suspend payload through as the interrupt reason unmodified — build it with `interruptReason` below to control the widgets. Declare `resumeSchema: z.string()` on the tool: the human's answer comes back as the resume data.
- A tool call awaiting Mastra's [`requireToolApproval`](https://mastra.ai/docs) gets a synthesized reason with **Approve** / **Deny** buttons whose `y` / `n` answer the host app maps to `approveToolCall` / `declineToolCall`.

#### `fileEvent(name, data)`

Builds the same `file` event from a filename and raw bytes, for attaching arbitrary files of your own. Yield it from the host app alongside the reduced stream, or write it to the tool execution context's stream writer to attach a file from inside a tool — `renderableEvents` passes it through by itself:

```ts
await context.writer.write(fileEvent("report.csv", csvBytes));
```

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
    { label: "Or tell me what to do instead" },
  ),
);
```

[Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) covers the Slack side: how each reason renders, who can answer, multiple questions, and expiry.

## Supported Versions

Welt releases first; @welt-io/mastra follows, mirroring the minor version. While both are 0.x, a @welt-io/mastra 0.Y release supports Welt v0.Y — other combinations may work, but come with no guarantee.

## License

MIT
