# Example Agent

The example agent for [Welt](https://github.com/iwamot/welt): the smallest complete agent that exercises the wire in both directions through @welt-io/mastra.

## Stack

| Package | Role |
|---------|------|
| [Bedrock AgentCore SDK](https://github.com/aws/bedrock-agentcore-sdk-typescript) | Serves the endpoint |
| [Mastra](https://mastra.ai/) | Runs the model and the tools |
| [@ai-sdk/amazon-bedrock](https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock) | Provides the Bedrock model |
| @welt-io/mastra | Adapts the wire to Welt |

## Deploy

Deploy with the [AgentCore CLI](https://github.com/aws/agentcore-cli):

```sh
agentcore create --name WeltExample --no-agent
cd WeltExample
agentcore add agent --name WeltExample --type create --build CodeZip --language TypeScript --framework Strands --model-provider Bedrock --memory none

curl -o app/WeltExample/main.ts https://raw.githubusercontent.com/iwamot/welt-io-mastra/main/examples/agent/src/main.ts
npm --prefix app/WeltExample install @welt-io/mastra @mastra/core @ai-sdk/amazon-bedrock@4 @aws-sdk/credential-providers zod

agentcore deploy
```

The agent defaults to Anthropic Claude Opus 4.8 through Bedrock's global inference profile (`global.anthropic.claude-opus-4-8`) — enable access for it in the Amazon Bedrock console, or point the `MODEL_ID` environment variable at another Converse model. Note the agent runtime ARN from the deploy output: Welt's `AGENT_ARN` points at it.

The Bedrock provider is pinned to its AI SDK v6 line (`@ai-sdk/amazon-bedrock@4`): with the v7 line (5.x), Mastra 1.50 silently drops image and document parts, so file input breaks.

## Tools

- `current_time` — the minimal tool: plain text streaming, nothing else. Ask "what time is it?" to see tool use in the thread.
- `attach_sample_file` — writes a `fileEvent` to its tool stream, which @welt-io/mastra passes through as a file upload in the thread. Ask it to attach the sample file.
- `sample_dangerous_action` — a pretend dangerous action (no side effects, no extra AWS permissions) that pauses for human approval: Welt renders the pause as **Approve** / **Cancel** buttons plus a free-text field in the Slack thread, and whichever answer comes first — a press, or a typed instruction — resumes the run. Ask "deploy to prod", then press a button or type something like "run the tests first". See [Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) for the round trip.

## Optional: file input

The agent can also read files uploaded to Slack — disabled by default. To try it, set in Welt's `.env`:

```sh
FILE_INPUT_MODALITIES=image,document
```

These two are what Claude models accept; `video` needs a model that takes video input — see [Welt's Files doc](https://github.com/iwamot/welt/blob/main/docs/files.md).
