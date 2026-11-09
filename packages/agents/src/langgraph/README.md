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

## A graph of your own

Bring a graph built on LangGraph's `MessagesAnnotation` (or a compiled one,
such as LangChain's `createAgent` makes): `chat` then runs it, with each
message as a new `HumanMessage`, and answers with its last AI message
([`graph.ts`](graph.ts)). It has its own model and tools, so it takes no
`model`, `system`, `tools` or `recursionLimit`.

```ts
const desk = langgraph.agent({ name: 'desk', graph });
// LangGraph's run context, for a graph with a context schema of its own: by default the handler's context.
const desk = langgraph.agent({ name: 'desk', graph, context: { region: 'eu' } });
```

- **Its checkpoints are in the key's database** (`SqlCheckpointSaver`, one
  thread per key), each stored before its step runs (`durability: 'sync'`):
  a retried attempt resumes the run it cut off, and a step stored is not run
  again. Between turns the thread keeps its latest checkpoint (`prune`).
- **The `messages` view shows the run as it goes**: after each step, the AI
  and tool messages it added are copied into the conversation, by their ids.
  The conversation is a log: a message the graph removes or edits later
  stays as it was copied.
- **`interrupt()` waits for a signal** named `interrupt`, which the agent's
  `pending` view lists with the interrupt's value, and `signal` resolves; the
  run resumes with the signal's value as `interrupt()`'s result. The turn
  waits without holding a process. Static breakpoints (`interruptBefore`,
  `interruptAfter`) have nothing to wait for: a graph with them is refused.
- **A step's side effects run again after a crash** (a payment, a plain
  LangChain tool): a graph is durable a step at a time. A model request may
  be made again; for the rest, use Restate's tools.
- **Any error fails the attempt**, which Restate retries; a
  `restate.TerminalError` (and LangGraph's own errors that a retry would
  meet again) ends the turn. A stopped, refused or failed run is not
  resumed: the next message starts a run of its own, with what closed the
  last one (its cut-off calls' results and the note that ends it) first.
- **The graph's state is its own**: its models read the state, not the
  conversation, so `window`, `budget` and `summarize` do not reach them.
  Trim it in the graph (a node that returns a `RemoveMessage` for each
  message to drop, say).
- **`output`**: the graph's own prompts must ask for it. A graph that writes
  a `structuredResponse` (LangChain's `createAgent` with a `responseFormat`)
  answers with it, as JSON; else its last AI message is validated.

### Restate's steps in a graph of your own

A graph is durable a step at a time: a crash runs the step it cut off
again, which is fine for a model request, but not for a payment. Make a
step's side effects Restate's, done once:

- **Prebuilt nodes** ([`nodes.ts`](nodes.ts)): `nodes.waitForSignal`,
  `nodes.workflow`, `nodes.call`, `nodes.send` and `nodes.subagent` each
  read their input from the state and write what they get back to the field
  `output`. A node run again (a crash, a retried attempt) gets the same task
  id from LangGraph, so it joins the call, the workflow or the wait it
  started rather than start another.

  ```ts
  const graph = new StateGraph(State)
    .addNode('approve', nodes.waitForSignal('approval', { input: (s) => s.refund, output: 'approved' }))
    .addNode('ship', nodes.workflow(shipping, { input: (s) => s.order, output: 'receipt' }));
  ```

- **Restate's tools** in a `ToolNode`, or LangChain's `createAgent`:
  `langgraph.tools([...])` makes `tool()`s and Restate's tools (`call`,
  `send`, `workflow`, `subagent`, `signal`) LangChain tools. Restate's make
  their calls once per tool call, as the model's reply with the call's id is
  checkpointed before the tools run; LangChain's tools are passed through.

Both take the handler's context from the graph's run: `langgraph.agent({
graph })` gives it, and a handler of your own passes it as the run context
(`invoke(input, { context: ctx, durability: 'sync' })`, with a
`SqlCheckpointSaver(ctx.db)`). A node refuses to run without it, a
checkpointer, or `durability: 'sync'`.

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
  it, it fails for good. So do LangGraph's other errors that a retry would
  meet again: an invalid state update, and a run with no input
  ([`errors.ts`](errors.ts)).
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
- [`test/langgraph-graph.test.ts`](../../test/langgraph-graph.test.ts): a
  graph of your own: its thread across turns, a run a crash cut off,
  `interrupt()` as signals (a retried attempt joins the same wait), the
  structured response, what closed a failed run, and the graphs refused;
  [`langgraph-nodes.test.ts`](../../test/langgraph-nodes.test.ts), the
  prebuilt nodes and `tools()`, through crashes;
  [`storage/langgraph-prune.test.ts`](../../test/storage/langgraph-prune.test.ts),
  the checkpointer's `prune` and `metadata`.
- [`test/langgraph.test.ts`](../../test/langgraph.test.ts):
  each point above, with crashes that stop an attempt in a tool call, or
  at any of its state requests; the
  system prompt; arguments that do not fit a tool; the recursion limit; and
  `messages`.
- [`test/langgraph.ts`](../../test/langgraph.ts): the
  bank agent, through crashes in [the crash test](../../../e2e/crash.ts)
  (`pnpm --filter e2e crash`): every message moves money exactly once.
