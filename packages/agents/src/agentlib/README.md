# agentlib

[agentlib](https://github.com/restatedev/agentlib) (`@restatedev/agentlib`)
is Restate's own agent library: an agent's loop as an operation of Restate's
generator SDK (`@restatedev/restate-sdk-gen`), with its tools, steering,
interruption, approvals, guardrails, compaction and limits. Restate journals
each model call and tool call it makes, and replays them.

Unlike the other frameworks here, an agentlib agent runs on the classic
Restate SDK, not in a session object: a virtual object whose `chat` handler
is journaled, and replayed after a crash, so that a model call or a tool
call that finished is not made again. Its conversation is in the object's
key/value state, not in a SQL database. It has the handlers and views of
every agent (`chat`, `messages`, `status`, `steer`, `stop`, `clear`, `sync`,
`signal`, `pending`, `notifications`, `watch`) and their companion, so that
a client (`@restatedev/agents/client`, `follow`) follows it as it follows
any other.

## Use

```ts
import { serve, tool } from '@restatedev/agents';
import * as agentlib from '@restatedev/agents/agentlib';
import { z } from 'zod';

const weather = tool({
  name: 'get_weather',
  description: 'The current weather in a city.',
  input: z.object({ city: z.string() }),
  run: ({ city }) => `Sunny and 21°C in ${city}`,
});

const assistant = agentlib.agent({
  name: 'assistant',
  system: 'Answer briefly.',
  tools: [weather],
});
await serve(assistant);
```

The same `weather` works in an agent of any framework here; agentlib's own
tools work too, beside it.

See [`examples/basic/agentlib.ts`](../../../examples/basic/agentlib.ts),
with a transfer that waits for an approval.

```sh
npm install @restatedev/agents @restatedev/agentlib@0.2.0 @restatedev/restate-sdk-gen@1.18.2 \
  @restatedev/restate-sdk@1.18.2 @ai-sdk/openai   # or @ai-sdk/anthropic
```

| Option        | What                                                                                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`       | `openai/model-id` or `anthropic/model-id` (with `@ai-sdk/openai` or `@ai-sdk/anthropic`), or else `MODEL`, or else `openai/gpt-6-sol`; or a model of agentlib (`aiModel` of `@restatedev/agentlib/provider` for any provider of the AI SDK, `journaledModel` for one of your own)        |
| `system`      | The instructions (the system prompt): a text, or agentlib's function of the run's context that gives one                                                                                                                                                                                 |
| `tools`       | The tools of `@restatedev/agents` (`tool()`, `call`, `send`, `workflow`, `signal`, `subagent`), as every agent takes them, and agentlib's own (`asyncTool`, `serviceTool`, `agentTool`, `handoff`, MCP's...) by the name the model calls them: `[weather, { transfer: asyncTool(...) }]` |
| `approval`    | The tools of `@restatedev/agents` that wait for a person's approval before they run: their names, or a function of a call ([Approvals and signals](#approvals-and-signals))                                                                                                              |
| `history`     | How the conversation the model gets stays short from turn to turn: `{ maxMessages, maxChars, retainMessages, model }`, or `false` ([A long conversation](#a-long-conversation))                                                                                                          |
| `output`      | A zod schema: the answer as data, which `chat` answers with                                                                                                                                                                                                                              |
| `description` | What it is, for the UI, and for a parent's model: `subagent(agent)` tells it                                                                                                                                                                                                             |
| `background`  | It works unwatched (a subagent, say): its turn tells its companion at its end only, and takes no steered messages                                                                                                                                                                        |
| `options`     | Options of the object, beside the ones set here (its `retryPolicy`, as every agent's; its state preloads only `meta` and `taken`)                                                                                                                                                        |

Every other option of agentlib's `agent()` goes to it as it is:
`maxSteps`, `maxToolCalls`, `maxOutputTokens`, `compaction`,
`contextWindow`, `toolResults`, `skills`, `finalize`, and the guardrails
`beforeRun`, `beforeStep`, `beforeTool`, `afterTool` and `afterRun`.

## Tools

An agentlib agent takes the tools of `@restatedev/agents`, as every agent
does, and makes each agentlib's own, its calls the generator SDK's on the
classic SDK's context of its invocation:

| Tool                                      | In an agentlib agent                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call(target, handler, …)`                | A call of the handler, by its typed definition (a session object's, an agent's, or any of the classic SDK's): journaled, so a crash replays its answer; stopping the turn cancels it              |
| `send(target, handler, …)`                | A send, journaled: made once                                                                                                                                                                      |
| `workflow(target, …)`                     | A run of the workflow, to its end: a workflow of its own per tool call, unless `key` gives its id; stopping the turn cancels it                                                                   |
| `signal(name, …)`                         | A wait for the signal, which `pending` lists and `signal` resolves                                                                                                                                |
| `subagent(agent)`                         | A task for an agent of any framework (a pi agent, another agentlib agent...), at its key `<this key>.<task name>`: the same name continues the task; stopping the turn stops the sub-agent's turn |
| `tool({ name, description, input, run })` | `run`, as a journaled step (agentlib's `asyncTool` is one too): a crash replays its result, and an error that is no terminal error fails the attempt, which Restate retries                       |

As in every agent, arguments that do not fit a tool's `input` are the
model's to fix, and a terminal error (the tool's own, or a handler's it
calls) is the tool's answer, which the model sees. A `tool()`'s `run` gets
`ctx.key` and `ctx.request`, its `callId` and `idempotencyKey`, but no
`ctx.db` (an agentlib agent has no SQL database) and no `ctx.rpc` or
`ctx.send`: its calls are Restate's tools above, or agentlib's own. A
`tool()` that reaches for them fails the turn, saying so. A `key` given
as a function gets that context too, as a journaled step.

An agent of another framework hands an agentlib agent a task with
`subagent(assistant)`, as any agent; `deliver` and `webhook` send it
messages as they send any agent's.

agentlib's own `serviceTool`, and the generator SDK's typed `client`, take
the generator SDK's descriptors (`iface`, `service`, `object`), which a
definition of the classic SDK (a session object, an agent) is not: for
those, `call` and `subagent` above.

## Through crashes

A crash, a restart, a deployment or a suspension replays `chat`'s journal:
each model call (`aiModel` journals it, as a `run`) and each tool call that
finished returns what it returned, without being made again, and the run
goes on from where it got to. A tool's own I/O is journaled as agentlib
journals it (`asyncTool`'s `execute` is a `run`, with `callId` for an
idempotency key). [`e2e/agentlib.ts`](../../../e2e/agentlib.ts) kills the
service mid-turn and checks that the model was asked once per step.

agentlib saves a turn's messages when its run ends; until then, `messages`
shows the turn as it goes: its message, its tool calls with their results,
and the messages steered to it. Once the turn ends, its messages are as the
run saved them (the model's text beside its tool calls, and its answer,
come then), under the same ids.

## Approvals and signals

`approval` names the tools of `@restatedev/agents` whose calls wait for a
person's approval before they run (or is a function of a call, `{ name,
args }`, that says whether it does), as the DeepSeek Harness's option does:

```ts
agentlib.agent({ name: 'assistant', tools: [weather, transfer], approval: ['transfer'] });
```

Such a call waits for the signal `approval`, as do agentlib's own tools
with `needsApproval`, its `humanApprovalTool`, and a tool's
`context.approve`: `pending` lists the wait, with the tool and its input,
and `signal` approves it (`true`, `{"approved": true}`, or a text such as
`approved`, `yes` or `ok`) or denies it (anything else), and the model is
told it was denied.

```sh
curl localhost:8080/assistant/alice/pending
# [{"id": "inv_1f…:assistant:approval:call_01:0", "name": "approval", "input": {"tool": "transfer", "input": {"to": "Bob", "euros": 50}}, "since": "…"}]
curl localhost:8080/assistant/alice/signal --json '{"name": "approval", "value": "approved"}'
```

## Steering and stopping

A message sent to `steer` while a turn runs reaches the run as agentlib's
steering (`controls.steering`) at the turn's next publish (a tool call's
start or end): agentlib places it after the current round of tool calls,
and the model answers it in the same turn. One that comes too late (the
model writes its final answer) is answered as a turn of its own, after the
turn. `stop` cancels the turn's invocation, as for every agent: the run
ends cancelled, with its open tool calls, and the next turn's model sees
the turn's message, the messages steered to it that it took, and that it
ended `Cancelled: …` (not its tool calls, whose results may be missing).

## Models

`openai/…` and `anthropic/…` are agentlib's `aiModel` on the AI SDK's
provider (`@ai-sdk/openai`, on OpenAI's Responses API, and
`@ai-sdk/anthropic`), loaded when the first message comes. Any other
provider of the AI SDK works as a model you give:

```ts
import { aiModel } from '@restatedev/agentlib/provider';
import { google } from '@ai-sdk/google';

agentlib.agent({ name: 'assistant', model: aiModel({ model: google('<model-id>') }) });
```

A provider's refusal that a retry does not change (a missing or wrong API
key, an unknown model, a request it rejects: an answer 4xx) ends the message
with HTTP 424, as for every agent, and the conversation shows it unanswered.
Any other failure of a model by name (an outage, a rate limit) fails the attempt, and Restate retries it, as
for every agent: the model has no retry limit of its own. A model you give
retries as you set it (`aiModel`'s `retry`; agentlib's default is 3
attempts, then the message fails, `Failed: …`). An `anthropic/…` model is
sent the tools' schemas without their numbers' bounds, which the tools still
check: agentlib 0.1.0 asked Anthropic for strict tools, which it refuses with
bounded numbers (agentlib's own `read_tool_result` has them).

## A long conversation

The model gets the conversation as agentlib's `LazyStateConversation` keeps
it: at a turn's start, once its messages since the last summary pass 64
(or 64 000 characters), the earliest are summarized by the agent's model,
and the latest 12 stay as they are, from a message of the user's on. The
summary is kept, and the turns after build on it, so the model's input
stays bounded, and so does what each turn loads. `history` sets it:

```ts
agentlib.agent({
  name: 'assistant',
  history: { maxMessages: 200, maxChars: 200_000, retainMessages: 40 },
});
agentlib.agent({ name: 'assistant', history: false }); // the whole conversation, every turn
```

`history`'s `model` summarizes with another model than the agent's (a
cheaper one, say). `messages` keeps every turn as it was said, whatever
the model gets. Within a turn, agentlib's own `compaction` and
`contextWindow` keep a long run within the model's window.

## State

The conversation is in the object's state: the model's, in chunks of 32
(`t/<n>`) with its count and summary (`t/meta`), and the messages as
clients read them, one key each (`c/<id>`), beside `meta`. An invocation
starts with `meta`, `taken` and `t/meta` alone, and reads the rest as it
needs it: `messages`, a page; `chat`, the messages since the summary. Each
read is journaled with what it read, as any state read of a journaled
handler is: a turn's journal has the conversation it loaded.

## Not here

- **`window`, `budget`, `summarize`, `schema`** (the conversation of turns,
  and tables of your own): there is no SQL database; `history` keeps a
  long conversation short ([A long conversation](#a-long-conversation)).
- **`ctx.db`, `ctx.rpc` and `ctx.send` in a `tool()`**: see [Tools](#tools).
- **A killed turn** (out of retries, or killed by an operator) is closed by
  the next message, `Ended: …`, not by the companion as it finds it gone.

## Packages

`@restatedev/agentlib` (0.1.x) and `@restatedev/restate-sdk-gen`
(1.18.2, the SDK @restatedev/sessions pins) are optional peer
dependencies, as are `@ai-sdk/openai` and `@ai-sdk/anthropic`. agentlib
runs on the copy of `@restatedev/restate-sdk` it finds, which must be
@restatedev/sessions' own (1.18.2): install `@restatedev/restate-sdk@1.18.2`
with it, as above, and npm installs one for all of them. On two copies (npm
puts a newer SDK beside sessions' own for agentlib, without it), an agent
refuses to start, saying so; `@restatedev/agents` asks for no SDK of its
own, so a project of another framework keeps whichever SDK it has.
