# Example Agent

The example agent for [Welt](https://github.com/iwamot/welt): the smallest complete agent that exercises the wire in both directions through @welt-io/mastra.

## Stack

| Package | Role |
|---------|------|
| [Bedrock AgentCore SDK](https://github.com/aws/bedrock-agentcore-sdk-typescript) | Serves the endpoint |
| [Mastra](https://mastra.ai/) | Runs the model and the tools |
| [@ai-sdk/amazon-bedrock](https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock) | Provides the Bedrock model |
| @welt-io/mastra | Adapts the wire to Welt |

## Run Locally

The agent runs on your machine as-is — [Welt's Quick Start](https://github.com/iwamot/welt#quick-start) starts here, before anything is deployed: the AgentCore SDK serves the same HTTP surface locally, on port 8080, that AgentCore Runtime serves in the cloud, and Welt's local mode invokes it there.

Fetch the agent and run it with Node.js 24, which runs TypeScript directly:

```sh
curl -O https://raw.githubusercontent.com/iwamot/welt-io-mastra/main/examples/agent/src/main.ts
echo '{"type":"module"}' > package.json
npm install @welt-io/mastra @mastra/core @ai-sdk/amazon-bedrock @aws-sdk/credential-providers zod bedrock-agentcore
BEDROCK_REGION=us-west-2 node main.ts
```

The process needs AWS credentials the standard SDK way — environment variables, `AWS_PROFILE`, an SSO session — because the model still runs on Amazon Bedrock.

`MODEL_ID` takes any Converse model with access enabled in the Amazon Bedrock console; unset, the agent uses `global.anthropic.claude-sonnet-4-6`, Anthropic Claude Sonnet 4.6 through Bedrock's global inference profile. The model is built in one place near the top of `main.ts`: the AI SDK's Bedrock provider, which speaks Converse to bedrock-runtime.

`BEDROCK_REGION` sends the model calls to a region of their own, and this example is the one that needs it locally: unlike credentials, the AI SDK's Bedrock provider resolves a region from `AWS_REGION` alone — not `AWS_DEFAULT_REGION`, not your AWS profile — and fails the call when neither that nor `BEDROCK_REGION` names one. Pass whichever region your model access lives in. Deployed, this is already handled: AgentCore Runtime names its own region in `AWS_REGION`.

One difference from the cloud: AgentCore Runtime gives every session its own microVM, while the local server is a single process for all sessions — the interrupted run ids this example keeps all share that one process, outlive the session that raised them, and accumulate while unanswered until the process exits.

## Deploy

Deploy with the [AgentCore CLI](https://github.com/aws/agentcore-cli):

```sh
agentcore create --name WeltExample --no-agent
cd WeltExample
agentcore add agent --name WeltExample --type create --build CodeZip --language TypeScript --framework Strands --model-provider Bedrock --memory none

curl -o app/WeltExample/main.ts https://raw.githubusercontent.com/iwamot/welt-io-mastra/main/examples/agent/src/main.ts
npm --prefix app/WeltExample install @welt-io/mastra @mastra/core @ai-sdk/amazon-bedrock @aws-sdk/credential-providers zod

agentcore deploy
```

The agent defaults to Anthropic Claude Sonnet 4.6 through Bedrock's global inference profile (`global.anthropic.claude-sonnet-4-6`) — enable access for it in the Amazon Bedrock console, or point the `MODEL_ID` environment variable at another Converse model — and `BEDROCK_REGION` at another region, to leave the model access where it already is. `agentcore status` reports the agent runtime ARN: Welt's `AGENT_ARN` points at it.

The CLI has no teardown command — removing the deployment means deleting the CloudFormation stack it created, `AgentCore-WeltExample-default`.

## Tools

- `current_time` — the minimal tool: plain text streaming, nothing else. Ask "what time is it?" to see tool use in the thread.
- `create_sample_file` — writes a small CSV and returns it as a media part, which the model reads and Welt uploads to the thread as `sample.csv`. Ask it for a sample file.
- `sample_dangerous_action` — a pretend dangerous action (no side effects, no extra AWS permissions) that pauses for human approval: Welt renders the pause as **Approve** / **Cancel** buttons plus a free-text field in the Slack thread, and whichever answer comes first — a press, or typed text — resumes the run. Ask "deploy api-service v1.2.3 to prod", then press a button or type something like "not now". See [Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) for the round trip.
- `sample_draft_report` — drafts a small report, pauses to show it for approval, and on approval returns it as `report.md`. Drafting before the pause is the Mastra suspend pitfall: an interrupted tool re-executes from its start on resume, so the drafting sits in the first pass's branch and the draft waits out the pause in a map keyed on the tool call id — the published file stays identical to the approved draft. That map is the draft's only copy and lives in this process, so a resume that cannot find it fails the tool rather than publish something the human never saw. Ask "draft a report about apples", then answer the buttons.

The two that produce files are named in the entrypoint's `filesFrom` — that is what puts their files in the thread, and a tool left out of it would hand its files to the model alone. The agent's instructions carry one line about those files: Mastra drops the filename on the way to the model, so the model sees each one as a document named by the Bedrock provider, and it is told to call files by the names their tools state — the names Welt uploads them under.

## Optional: file input

The agent can also read files uploaded to Slack — disabled by default. To try it, set in Welt's `.env`:

```sh
FILE_INPUT_MODALITIES=image,document
```

These two are what Claude models accept; `video` needs a model that takes video input — see [Welt's Files doc](https://github.com/iwamot/welt/blob/main/docs/files.md).
