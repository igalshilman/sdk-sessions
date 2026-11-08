# LangGraph

[LangGraph](https://langchain-ai.github.io/langgraphjs/) runs an agent as a
graph of steps. The built-in agent here stores each step in the agent's
conversation of turns, in its SQL database
([SQL in Restate virtual objects](../../../sessions/README.md)); a graph of
your own keeps its checkpoints there too, with `SqlCheckpointSaver`.

## Use

```ts
import { serve } from '@restatedev/agents';
import * as langgraph from '@restatedev/agents/langgraph';
import { weather } from './weather.ts';

const assistant = langgraph.agent({ name: 'assistant', system: 'Answer briefly.', tools: [weather] });
await serve(assistant);
```

| Option   | What                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`  | `openai/model-id` (`ChatOpenAI`) or `anthropic/model-id` (`ChatAnthropic`); or else `MODEL`, or else `openai/gpt-6-sol` (`OPENAI_API_KEY`); or any LangChain chat model that calls tools |
| `system` | The system prompt                                                                                                                                                                        |
| `tools`  | `tool()`s and Restate's tools of `@restatedev/agents`, or LangChain's tools                                                                                                              |
| `output` | A zod object: the answer as data, which the agent replies with as JSON, and `chat` answers with (see [Structured answers](../../README.md#structured-answers))                           |

For a session object of your own, `langgraph.chat(options)` is the handler and
`langgraph.messages()` the view; `options` may be a function of the
invocation's context (each user's system prompt, say). `langgraph.prompt(ctx,
text, options)` answers a prompt in a handler of your own, once, however
often the handler runs; each prompt of an invocation is a prompt of its own. The graph is the usual tool-calling
loop: a model node, a tools node, and back to the model until it answers.

## Through crashes

The built-in agent keeps no checkpoints: its conversation is the object's
conversation of turns ([docs/conversation.md](../../docs/conversation.md)),
whose items are LangChain's messages, and its graph starts from what the
model sees of it (the earlier turns as their prompt and answer, within
`budget`; the latest `window` turns whole). The handler is not replayed: a
retried attempt runs it again from the start, from what is stored.

- **The model node stores its reply before it returns, and the tools node
  each result as it lands.** So a crash during the tools runs those without
  a result again, with the same tool call ids, without asking the model
  again; and a stored final reply is the answer.
- **A tool is idempotent by its tool call id** (`callId` of `tool()`'s
  `run`), which it passes on, such as in an idempotency key.
- **A tool's error fails the attempt**, and Restate retries it (the ToolNode
  would hand it to the model); a `restate.TerminalError` of a
  `@restatedev/agents` tool is its answer to the model, and so are arguments
  that do not fit a tool, and a call of a tool the agent does not have.
- **A turn takes at most `recursionLimit` steps** (default 10 000): past
  it, it fails for good.
- **A message is answered once per invocation** (`answerOnce`). A turn that
  a killed invocation left is closed (`ended`), never finished.

The checkpointer ([`checkpointer.ts`](checkpointer.ts), `SqlCheckpointSaver`),
for a graph of your own, keeps checkpoints, channel values and pending
writes in three tables; a step stores only the channels it changed. With
`history: 'latest'` a thread keeps its latest checkpoint only, and the
ancestors a `DeltaChannel` is rebuilt from; by default it keeps them all,
for LangGraph's history.

## Run

```sh
cd packages/examples && OPENAI_API_KEY=… node basic/langgraph.ts
```

With a Restate server, and the agent registered with it: see
[Run an example](../../../examples/README.md#run-an-example).

## Tests

The tests run on a scripted model, [`test/fakes/langgraph.ts`](../../test/fakes/langgraph.ts)
(`pnpm --filter @restatedev/agents test langgraph`, from the repository root):

- [`test/storage/langgraph.test.ts`](../../test/storage/langgraph.test.ts):
  LangGraph's checkpointer conformance suite
  (`@langchain/langgraph-checkpoint-validation`, 718 tests); and
  [`langgraph-fork.test.ts`](../../test/storage/langgraph-fork.test.ts),
  a forked thread; [`langgraph-latest.test.ts`](../../test/storage/langgraph-latest.test.ts),
  `history: 'latest'` with a `DeltaChannel`, and graphs of more channels than
  an `OR` of them can match.
- [`test/langgraph.test.ts`](../../test/langgraph.test.ts):
  each point above, with crashes that stop an attempt in a tool call, or
  at any of its state requests; the
  system prompt; arguments that do not fit a tool; the recursion limit; and
  `messages`.
- [`test/langgraph.ts`](../../test/langgraph.ts): the
  bank agent, through crashes in [the crash test](../../../e2e/crash.ts)
  (`pnpm --filter e2e crash`): every message moves money exactly once.
