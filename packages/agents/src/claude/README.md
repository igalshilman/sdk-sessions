# Claude

The Anthropic SDK's tool runner (`client.beta.messages.toolRunner` in
[`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript))
is a light agent harness: the tool-calling loop, in the process, with nothing
stored. It keeps the conversation in its params, so an agent built on it is
durable when the conversation is: here it is the agent's conversation of
turns, in its SQL database
([SQL in Restate virtual objects](../../../sessions/README.md)).

It is lighter than the Claude Agent SDK, which runs Claude Code as a
subprocess. Claude Code's own tools (bash, read, write, edit, glob, grep)
come to the runner as `betaAgentToolset20260401` from
`@anthropic-ai/sdk/tools/agent-toolset/node`; the agent takes whatever tools
you give it.

## Use

```ts
import { serve } from '@restatedev/agents';
import * as claude from '@restatedev/agents/claude';
import { weather } from './weather.ts';

const assistant = claude.agent({ name: 'assistant', system: 'Answer briefly.', tools: [weather] });
await serve(assistant);
```

| Option         | What                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`        | `anthropic/model-id`; or else `MODEL`, or else `anthropic/claude-sonnet-5-5` (`ANTHROPIC_API_KEY`)                                                                                                                        |
| `system`       | The system prompt                                                                                                                                                                                                         |
| `tools`        | `tool()`s and Restate's tools of `@restatedev/agents`, or the SDK's runnable tools (such as `betaZodTool`)                                                                                                                |
| `output`       | A zod object: the answer as data, which the agent replies with as JSON, and `chat` answers with (see [Structured answers](../../README.md#structured-answers)): asked for natively where the model has structured outputs |
| `nativeOutput` | Whether `output` is asked for with the API's structured outputs (`output_config.format`) rather than in the prompt (default: if the model has them, as Claude's 4.5 models and later do)                                  |
| `client`       | The Anthropic client (a base URL or a proxy of your own, say); by default one with `ANTHROPIC_API_KEY`                                                                                                                    |
| `maxTokens`    | The most tokens of each of the model's replies (default 16000): a reply cut off there fails its message (a terminal error)                                                                                                |
| `effort`       | How much effort the model puts into each reply: `low`, `medium`, `high`, `xhigh` or `max` (default: the model's)                                                                                                          |

With `output`, a model with structured outputs is asked for the answer
natively: each request of the run has the JSON schema of `output` as its
`output_config.format` (the SDK's `betaZodOutputFormat`), which holds the
model's final reply to it, while its tool calls go on as before. Neither
the system prompt nor the prompt asks for it. The reply is checked all the
same, against what the API does not hold it to (a string's `max`, an
`enum`: the SDK moves them into the schema's descriptions), and a reply
that does not fit is asked again once, as when asked in the prompt. A
declined reply, or one cut off at `maxTokens`, ends the turn, as without
`output`. A schema the API refuses (one too complex for it, say) refuses
the message: `nativeOutput: false` asks in the prompt, as for a model
without structured outputs (Claude 3, Opus 4 and 4.1, Sonnet 4) or a model
id the agent does not know.

For a session object of your own, `claude.chat(options)` is the handler and
`claude.messages()` the view; `options` may be a function of the
invocation's context (each user's system prompt, say). `claude.prompt(ctx,
text, options)` answers a prompt in a handler of your own, once, however
often the handler runs; each prompt of an invocation is a prompt of its own.

## Through crashes

The conversation is the object's conversation of turns
([docs/conversation.md](../../docs/conversation.md)), whose items are the
SDK's messages. The runner starts from what the model sees of it: the
earlier turns as their prompt and answer (as many as `budget` holds, the
earliest summarized), the latest `window` turns whole. The handler is not
replayed: a retried attempt runs it again from the start, from what is
stored.

- **Each reply is stored before its tools run, and their results before the
  next request.** So a crash during the tools resumes them with the same tool
  call ids, without asking the model again; and a stored final reply is the
  answer, without asking the model for it again.
- **A tool is idempotent by its tool call id** (`callId` of `tool()`'s
  `run`, or `callId(context)` for the SDK's tools), which it passes on, such
  as in an idempotency key.
- **A tool's error fails the attempt**, and Restate retries it; a
  `restate.TerminalError` of a `@restatedev/agents` tool, and the SDK's
  `ToolError`, are its answer to the model.
- **A message is answered once per invocation** (`answerOnce`). A turn that
  a killed invocation left is closed (`ended`), never finished: by the next
  message, or by the agent's `settle` once its companion finds the
  invocation gone.

## Run

```sh
cd packages/examples && ANTHROPIC_API_KEY=… node basic/claude.ts
```

With a Restate server, and the agent registered with it: see
[Run an example](../../../examples/README.md#run-an-example).

## Tests

The tests run on a scripted model, [`test/fakes/claude.ts`](../../test/fakes/claude.ts)
(`pnpm --filter @restatedev/agents test claude`, from the repository root):

- [`test/claude.test.ts`](../../test/claude.test.ts):
  each point above, with crashes that stop an attempt in a tool call, or at
  any of its state requests, and abandon it, keeping what it committed; and
  `messages`.
- [`test/claude.ts`](../../test/claude.ts): the bank
  agent, whose tools move money in the [ledger](../../../sessions/test/ledger.ts),
  through crashes in [the crash test](../../../e2e/crash.ts)
  (`pnpm --filter e2e crash`): every message moves money exactly once.
