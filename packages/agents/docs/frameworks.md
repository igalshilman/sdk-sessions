# The frameworks

How each framework works today, what its library expects, and how it maps
onto the conversation store. This page is the research behind steps 4 to 8
of [the plan](plan.md); the store itself is in
[The conversation](conversation.md).

**References** are to this repository at `772682f` (v0.3.0 and one e2e
commit after it), as `file:line`, relative to `packages/agents/`. Library
facts are from the versions this package pins (its `package.json`), read
from `node_modules`. Research of this kind goes stale: check a reference
before relying on it.

## What every integration does

An integration is a thin layer between its framework's agent loop and the
turn. It has five jobs, each of which fails in its own way (the Python SDK
found most of its bugs in jobs 3 and 5):

| Job                                                                         | What goes wrong                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1. Translate messages: framework message ↔ stored item, and what each holds | a call is lost or misread after a reload              |
| 2. Store each step as it happens, from the framework's hooks                | a step is stored twice, or not at all, before a crash |
| 3. Resume: skip calls already made, don't ask again for a stored reply      | a tool runs twice, or the model is asked again        |
| 4. Wrap tools: schema, argument validation, errors back to the model        | a wrong schema, or bad arguments crash the turn       |
| 5. Classify errors: refusal (424), retry, or terminal                       | a bad key retried forever, or a blip fails the turn   |

What the core gives an integration, once ported:

- **`Items`**, the framework's items: `dump` and `load` (to store and read
  them), `prompt(text)`, `reply(text, agent?)`, `results(calls)` (to make
  them), `read(item)` (what an item says, the tool calls it makes, the
  results it holds), and optionally `summary(text)`.
- **`answerOnce(ctx, text, items, run, { window, budget, check })`**, which
  answers a prompt once. `run` gets the `Conversation`: `history()` is the
  model's input (on the turn projection), and `conversation.turn` is the turn
  to write.
- **`Turn`**: its writes (`append`, `appendReply`, `carry`, `drop`,
  `askAgain`) and its reads (`finalReply`, `openCalls`, `latestAsk`,
  `stored`).
- **Tools**, as today (`tool()`'s `run` gets `ctx` and the call's id), and
  `waitFor(ctx, callId, signal, input, { approval, rejoin })` for a
  framework's own durable wait.
- **The turn's signal** (`stopSignalOf`), refusals (`refusalOf`, `fromTool`),
  and publishing, which is the `chat` turn's (`chatTurn`), not the
  conversation's: in `answerOnce`'s run (`Conversation.hold`), `append` and
  `appendReply` make what the run makes after each write that commits,
  and a framework that copies its steps (`copyIn`) makes it once its
  transaction commits (`Turn.stepsCommitted`). A followed `chat` turn
  publishes there; a turn outside one (a handler of your own that calls
  `prompt()`) makes nothing, and no integration publishes by hand.
  `toolCallStarted` settles the call records before a tool makes its own.
  A call's record commits of its own only before the call is made; that
  it answered, and that it is forgotten, ride a commit of `ctx.db`
  (`rideCommit`: the one that stores the call's result, whichever framework
  makes it), and `answering` writes what is still pending as the turn ends.
  An answer rides only a commit that is under way (an urgent rider): if none
  is, it is written on its own at the end of that macrotask.
  OpenCode's transcript is in a database of its own, which a commit of
  `ctx.db` does not reach: its answer is written before the tool hands its
  result over (`native`, `src/opencode/index.ts`).
- **Steering**: `takeSteers(ctx, conversation)` at each step, or, for a
  framework that keeps its own history, `inboxOf(ctx).listen` and
  `tookSteers` as it copies the messages its own inbox placed
  ([Steering](#steering)); `chatHandler(answer, { steers: true })` says the
  framework takes them.

### Steering

A message steered to a turn ([Steering a turn](turns.md#steering-a-turn))
joins it at a step: after a reply's tool results, before the next model
request. Each integration puts the messages in that request, in place, and
stores them once in the turn:

|                                | Where it takes them                                                                                                    | How                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude                         | before the turn's first request, and after each round's results (`takeSteers`)                                         | the runner leaves the history to its caller once the messages are taken: its next request is `history()`, which has them after the results. Not after a paused reply, which goes back as the last message                                                                                                                                                                                  |
| LangGraph, built-in agent      | in the model node, before each request (`takeSteers`)                                                                  | they go in the request and stay in the run's state, with the id `steer:<id>` (`items.steered`)                                                                                                                                                                                                                                                                                             |
| LangGraph, a graph of your own | none: each is a turn of its own                                                                                        | the graph keeps its own state, which the turn cannot add to in place                                                                                                                                                                                                                                                                                                                       |
| pi                             | as a round of tool calls is done (pi-durable's `afterTools` hook)                                                      | each waiting message is submitted to pi's inbox (`whenBusy: 'steer'`, keyed `steer:<id>`, an entry of kind `restate.steer`), which pi places after the round's results (`steeringMode: 'all'`); the copy of pi's commit into the turn stores it, with `taken`                                                                                                                              |
| DeepSeek                       | at the step after it hears of it: a publish once a reply with tool calls, or a result, is stored                       | each waiting message goes to the harness's step inbox (`agent.steer`, a user message `steer:<id>`), which the harness places at its next step; the copy of its flush into the turn stores it, with `taken`. A message sent while a tool runs is heard of as its result is stored, which is as the next model request goes out: it joins at the step after that request's, in the same turn |
| OpenCode                       | as a tool call of a round returns (the tool's `execute.after` hook, which OpenCode awaits before it stores the result) | each waiting message is submitted to OpenCode (`delivery: 'steer'`, id `msg_steer_<id>`, with its steer id in `metadata.steer`), which places it at the round's next step, after the round's results; the call's result is copied as the tool returned it first, so that the copy's publish lists the message in time; the copy of what OpenCode placed stores it, with `taken`            |

`langgraph.chat` with options that a function gives decides per message,
as its turn starts, from the options it gives (once per attempt): a graph of
your own takes none. A pi round whose tool asks to end the run (`terminate`,
a handoff) submits no message: pi would end the round at its final
boundary, which starts a run of its own for a message placed there, outside
the turn; the message waits for the turn's end, and is a turn of its own.

A turn hears of the messages only at a publish (a tool call's start and
end), so a message sent while the model writes is taken at the step after
the next tool call, or, with none, answered as a turn of its own. A
background agent takes none.

### At a glance, the target

|                     | Claude                         | LangGraph (built-in agent)    | DeepSeek Harness                          | pi                                   | OpenCode                                                              |
| ------------------- | ------------------------------ | ----------------------------- | ----------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| The model's history | turn projection (`history()`)  | turn projection (`history()`) | its own (the harness's event log)         | its own (pi-durable's entries)       | its own (its database)                                                |
| An item             | a `BetaMessageParam`           | a LangChain `BaseMessage`     | a dsh-llm `Message`, with its harness seq | a pi-ai `Message`, with its entry id | an OpenCode message                                                   |
| Steps stored from   | the run loop, before tools run | the graph's nodes             | each flush, in its transaction            | each pi commit, in its transaction   | each OpenCode commit, copied after it, in a transaction of its own    |
| Long conversations  | our summaries (`compact`)      | our summaries (`compact`)     | `dsh-compaction-basic`, mounted           | pi's own compaction                  | OpenCode's own compaction                                             |
| A turn carries      | nothing                        | nothing                       | nothing (in its log)                      | nothing (in pi's documents)          | nothing (in its database)                                             |
| Order in the plan   | step 4                         | step 5                        | step 6                                    | step 7, after a spike                | step 8, after a spike: dropped, then back ([its return](opencode.md)) |

### What all five do today

- **A dead turn is finished, not closed.** Each finishes a prompt that an
  earlier invocation left unanswered before it answers its own: Claude's
  `for (;;)` (`src/claude/index.ts:248`), LangGraph's (`src/langgraph/index.ts:225`),
  DeepSeek's `CONTINUE` (`src/deepseek/index.ts:334-350`), OpenCode's
  `submit`, which waits for the last prompt to settle
  (`src/opencode/index.ts:361-374`), and pi's scheduler, which runs the dead
  run's tasks first. The finishing run's tools use the new invocation's
  idempotency keys (`src/tools.ts:94`, `:120`) and cannot see the dead
  invocation's call records (`src/calls.ts:63-79` keeps one invocation's),
  so a `call`, `send`, `subagent` or `workflow` the dead turn made can be
  made again. The bank tests pass only because the fake ledger dedups by
  transfer id (`test/bank.ts:37`). Tests that encode it:
  `test/claude.test.ts:344-352`, `test/langgraph.test.ts:187-195`,
  `test/deepseek.test.ts:228-236`, `test/opencode.test.ts:239-247`.
- **Each publish reads the whole conversation** to rebuild the transcript
  that `log.ts` keeps in step with (`transcribing`, `src/common.ts:543`),
  even in a retried attempt of an answered prompt.
- **How a stopped or refused turn shows to the next model differs:** Claude
  and LangGraph store a CANCELLED or UNANSWERED note; pi, DeepSeek and
  OpenCode store none, so the next model sees the prompt as still open
  (`test/pi.test.ts:192-212`: the next answer echoes the cancelled prompt).
- **`output` asks again with a second prompt** (`src/output.ts:67-80`, as
  `<id>:2`), a second turn in the new store.

## Claude

The Anthropic SDK's tool runner (`@anthropic-ai/sdk` 1.8.0, without the API's message thread).
[`src/claude/`](../src/claude).

### Today

- **Tables**, schema `restate-agents.claude` (`src/claude/conversation.ts:15-18`):
  `restate_claude_messages(seq PK, prompt, message)`, one `BetaMessageParam`
  as JSON per row, tagged with its prompt id; and
  `restate_claude_answers(prompt PK, answer)`.
- **Writes**, each one transaction: the prompt row before the run
  (`src/claude/index.ts:255`); a reply with `tool_use` before its tools run
  (`:155`); the results message once every tool of the round ran (`:159`,
  `:137` on resume); the final reply and the answer together (`:151`);
  `close`: the cut-off reply, an error result for each open `tool_use`, the
  note, and the answer (`conversation.ts:78-88`).
- **Once**: `nextPromptId`, then the answer by prompt id; else `pending()`,
  the prompt of the latest message without an answer (a `NOT IN` over the
  whole table, `conversation.ts:57-62`), finished first.
- **Resume**: a new runner from every stored message (`index.ts:118-128`);
  a cut-off reply's tools run again with their stored ids (`:132-141`); a
  stored reply is never asked for again; every call of a round runs again,
  as results are stored once per round.
- **Tool errors**: `failing()` (`index.ts:69-88`) keeps the first error a
  tool throws, and fails the attempt with it. That includes the SDK's own
  `ToolError`, which is meant for the model (its agent toolset throws it for
  a bash command that exits non-zero): such a call is retried for as long as
  Restate retries.
- **The model's input**: every stored message, on every request
  (`index.ts:125`, `conversation.ts:43-46`); no compaction, no
  `context_management`, no `cache_control`. Past the model's context window,
  the API answers 400, a `BadRequestError`, which `FOR_GOOD` takes for a
  refusal (`src/common.ts:350-355`): the turn is closed UNANSWERED (424), and
  every later message fails the same way until `clear`.
- **Endings**: stopped, `close(pending, CANCELLED)`; refused, UNANSWERED; stop
  reasons `max_tokens` and `refusal`, a "Cut off: …" or "Declined: …" note and
  a terminal error (`index.ts:145-149, 168-183`); `pause_turn` and
  `model_context_window_exceeded` are taken as the answer (`:150-153`); a
  `TerminalError` from an SDK tool stores nothing, so the prompt stays
  pending; a retry after a `max_tokens` close answers "Cut off…" as a
  success (`storedAnswer` knows only UNANSWERED).

### The library

- `BetaMessageParam` has the roles `user`, `assistant` and `system` (system
  messages carry `tool_addition` and `tool_removal` blocks). A response's
  content: text, thinking and redacted thinking, `tool_use`,
  `server_tool_use` with its result, the MCP pair, `container_upload`,
  `compaction`, and more. Stop reasons include `pause_turn`, `compaction`,
  `refusal` and `model_context_window_exceeded`.
- The runner keeps `params.messages` in memory, and persists nothing.
- Compaction: `compactBeforeNextTurn()` replaces the messages with one
  response; server-side `context_management` (a `compact_20260112` edit)
  returns a signed `compaction` block, which must be sent back as it came.
- What changes per attempt: message ids, `tool_use` ids (stable here, as a
  reply is stored before its tools run), the container id.
- Structured outputs: `output_config.format`, a JSON schema the API holds
  the final text reply to, without a beta header (Claude's 4.5 models and
  later, and Mythos Preview). The runner sends it with each request, so
  tool calls go on, and drops it only for a compaction request.
  `betaZodOutputFormat` (`helpers/beta/zod`) makes one of a zod schema, and
  moves into descriptions what the API does not take (string lengths,
  number bounds), and `enum` and `const` too, which it does. A declined
  reply, or one cut off at `max_tokens`, may not fit the schema; a schema
  too complex for the API is a 400.

### Target: the turn projection

- **Items**: an item is a `BetaMessageParam`, as JSON.
  - `prompt(text)`: `{ role: 'user', content: text }`.
  - `reply(text)`: `{ role: 'assistant', content: text }`. The API refuses an
    empty text block: an empty answer needs a reply it accepts (test it).
  - `results(calls)`: **one** user message with a `tool_result` for each
    call (`is_error: true`): the API wants every result of a reply in the
    next message.
  - `read`: user text is said by the user; a `tool_result` is a result
    (`is_error`); assistant text is said by the assistant, and each
    `tool_use` is a call; a `system` message says nothing. A server tool's
    blocks (`server_tool_use` and its result, the MCP pair) say nothing, so
    that they never leave an open call the API would refuse a result for.
  - `summary`: the default.
- **Run**: the runner's `messages` are `conversation.history()`. If the turn
  has a stored final reply (`turn.finalReply()`), that is the answer: the
  model is not asked again (in `answerOnce`'s run, the final reply is held
  and commits with the answer, so only a turn written otherwise has one).
  Otherwise the open calls (`turn.openCalls()`) run with their ids,
  and their results are appended; then each reply is appended
  (`appendReply`) before its tools run, and its results after.
- **Errors**: the SDK's `ToolError` is the tool's answer to the model, not
  an attempt's failure. `model_context_window_exceeded` is no answer (a
  terminal error); `pause_turn` stores the paused reply as a step and goes
  on.
- **Summaries**: `summarize` with the agent's own client and model.
- **Output**: a model with structured outputs is asked for `output`
  natively (`nativeOutput`): `output_config.format` on each request, and
  nothing in the system prompt or the prompt (no `reminder`); the check
  stays (D9), for what the API does not hold the reply to. Other models
  are asked in the prompt.
- **Goes**: `src/claude/conversation.ts` (both tables, `pending`, `close`,
  `cancel`, `since`), `transcribe`, `TRANSCRIPT`, `storedText`, the pending
  loop, the `transcribing` wiring (`index.ts:226-231`, `:247-286`,
  `:312-347`).
- **Risks**: earlier turns' tool calls leave the model's view (by design:
  the window); Anthropic's prompt cache breaks where a turn leaves the window
  (summaries limit it); thinking blocks must stay whole in the window's
  items. The fake's tool ids are `toolu_<messages.length>`
  (`test/fakes/claude.ts:43`), unique only while the model gets the whole
  conversation; once the history is bounded they repeat, and the bank's
  ledger dedups transfers by call id (`test/bank.ts:37`): give the fake ids
  unique in the conversation.
- **Tests** (`test/claude.test.ts`, 21 today): invert `:344-352` (a dead turn
  is closed, not finished); add a stored final reply not asked again
  (count the requests), earlier turns' tool calls not sent, a long
  conversation that no longer ends in 424, `settle`, a `ToolError` that
  reaches the model.

## LangGraph

`@langchain/langgraph` 1.7.3, `@langchain/langgraph-checkpoint` 1.2.2,
`@langchain/core` 1.4.0. [`src/langgraph/`](../src/langgraph).

### Today

- **The checkpointer** (`src/langgraph/checkpointer.ts`), schema
  `restate-agents.langgraph` (`:46-77`): `restate_langgraph_checkpoints`
  (one checkpoint, without its channel values), `restate_langgraph_channel_values`
  (one channel's value at one version), `restate_langgraph_writes` (one
  pending write of a task; no `task_path`, unlike the Python SDK's).
- **The built-in agent**: a `StateGraph` of its own, model → tools → model →
  answer (`index.ts:159-172`), compiled with
  `SqlCheckpointSaver(ctx.db, { history: 'latest' })` (`:216`), the thread
  being `ctx.key` (`:223`), `durability: 'sync'`. Its channels: `messages`,
  `prompt`, and `answers`, every prompt's answer, never trimmed (`:66-72`).
  There is no `createAgent` and no `graph` option; `SqlCheckpointSaver` is
  exported for graphs you run yourself, with no chat integration.
- **Once**: the `for (;;)` loop (`index.ts:225-256`): `getState`; a stored
  `answers[id]` is the answer; else a `prompt` without an answer is resumed
  (`invoke(null)`), an earlier invocation's too; else a run starts with
  `{ messages: [HumanMessage], prompt: id }`.
- **Resume**: LangGraph's own, from the latest checkpoint and its pending
  writes. ToolNode runs a reply's calls as one task (`Promise.all`), stored
  when all are done: a crash in one reruns every call of the reply, with the
  same ids. The first tool error fails the attempt (`index.ts:87-93`).
- **The model's input**: the whole `messages` state, at every step
  (`index.ts:163-165`); no trimming, no summary. `recursionLimit` is
  LangGraph's default, 25: past about 12 tool rounds a turn raises
  `GraphRecursionError`, which is neither terminal nor a refusal, so Restate
  retries it with a fresh 25 steps. The Python SDK sets about 10 000 and
  makes the error terminal.
- **Endings**: stopped, `close(CANCELLED)` (`:245-248`, `:266-286`, through
  `updateState` as the `answer` node); refused, `close(UNANSWERED)`. A
  `TerminalError` that is no refusal is thrown without a close (`:251-252`):
  the run stays open, the next message runs it again first, and meets the
  same error: the key is stuck until `clear`.
- **The transcript**: `transcribe` (`index.ts:319-331`) reads every channel
  of the latest checkpoint at each publish; a tool's output reaches the log
  one publish late (pending writes are not read).
- **The checkpointer's queries build one `OR` term per channel**:
  `#channelValues` (`checkpointer.ts:166-175`) and `dropEarlier` (`:117-122`,
  `NOT (… OR …)`). The database refuses an expression more than 100 deep: a
  probe failed reading a checkpoint of 96 channels and pruning one of 95.
  `dropEarlier` runs in every `put`, so such a graph fails every step, and
  is retried forever. Channels are the state's keys, `__start__`,
  `__pregel_tasks` and a `branch:to:<node>` per node: the built-in agent has
  8, a large graph of your own more than 95.
- **`history: 'latest'` loses a `DeltaChannel`'s history.** LangGraph JS has
  `DeltaChannel` (beta, with `MessagesDeltaValue`): a channel stored as its
  writes, and its whole value only now and then; it is rebuilt from the
  latest snapshot and the writes after it, read through the checkpoints'
  ancestors (`counters_since_delta_snapshot` in the metadata, as in Python).
  `dropEarlier` keeps only the checkpoint just written, so such a channel
  reloads empty, with no error. The conformance suite runs with `'all'` only
  (`test/storage/langgraph.test.ts:14`).

### The library

- A checkpoint's metadata is `{ source, step, parents, counters }`, built by
  the loop, which never merges `config.metadata`; the conformance suite wants
  it stored unaltered.
- The messages reducer gives a message without an id a random v4 id;
  `RemoveMessage` and `REMOVE_ALL_MESSAGES` remove messages.
- `interrupt()`: `invoke` returns `{ …, __interrupt__ }` rather than throwing,
  and `invoke(null)` runs the node again. An interrupt's id is a hash of its
  namespace, so two `interrupt()` calls in one task share it (the Python
  SDK's wait id `<invocation>:interrupt:<id>` would collide: add the task's
  count of resumes). Without a checkpointer `interrupt()` throws
  `GraphValueError: No checkpointer set`.
- `@langchain/openai` 1.7.0 uses Chat Completions unless the model is one it
  routes to Responses; the Python SDK forces the Responses API for OpenAI's
  models.

### Target: the built-in agent on the turn projection

- **No checkpointer** for the built-in agent: the store is its state.
- **Items**: an item is a LangChain `BaseMessage`.
  - `dump`: `JSON.stringify(message.toDict())`; `load`:
    `mapStoredMessagesToChatMessages([JSON.parse(stored)])[0]` (which keeps
    `tool_calls`, `additional_kwargs`, `response_metadata`).
  - `prompt(text)`: a `HumanMessage`; `reply(text)`: an `AIMessage`;
    `results(calls)`: a `ToolMessage` per call (`status: 'error'`).
  - `read`: a human message is said by the user; an AI message by the
    assistant (its text), with its `tool_calls` as calls; a tool message is
    a result (an error if `status === 'error'`).
  - `summary`: the default.
- **Graph**: the model node appends its reply (`turn.appendReply`) before it
  returns; the tools node appends the round's `ToolMessage`s in one write
  once its tools ran (`toolsNode`; a crash before runs the round again, as
  the Python SDK commits a step's results together), then publishes; START goes to the tools node
  if the turn has open calls; a stored final reply returns at once. The input
  is `{ messages: conversation.history() }`.
- **Errors**: a `recursionLimit` of about 10 000, and LangGraph's own
  errors that a retry would meet again terminal (`GraphRecursionError`,
  `InvalidUpdateError`, `EmptyInputError`: `errors.ts`, as the Python SDK's
  `_errors.py`); a `TerminalError` closes the turn as failed (`answerOnce` does).
- **Summaries**: `summarize` with the agent's own model.
- **Goes**: the `prompt` and `answers` channels, the `answer` node, `close()`,
  the `for (;;)` loop, `transcribe`.
- **The checkpointer stays** for graphs of your own: its queries match lists
  of rows, `(channel, version) IN (VALUES (?, ?), …)`, and `'latest'` keeps
  what a `DeltaChannel` is rebuilt from, the latest checkpoint's ancestors
  back to each delta channel's snapshot (Python's `_kept` in
  [`_checkpointer.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/langgraph/_checkpointer.py)),
  counting only the channels the checkpoint holds. After the merge, a `put`
  finds them from those its parent needed, as the `put` before kept them in
  memory: a child needs some of its parent's, so a thread's steps read none
  back (Python's reads them at each `put`).
- **A graph of your own** (`agent({ graph })`, `graph.ts`, as the Python
  SDK's `_graph.py`): framework-owned history, its checkpoints in the key's
  database; the messages after the run's input copied by id (a step's tool
  messages in one write, as Python's `_copied`), the prompt's id
  `prompt:<turn>`, a window of 1, a closed turn's closing record as the
  run's input; `interrupt()` as Restate signals. Unlike Python's, the run's
  prompt is stamped on its checkpoints by the saver (`metadata`), since the
  loop does not merge `config.metadata`; and an interrupt's wait id adds the
  count of resume values stored, since a node's interrupts share one id.
- **Tests** (`test/langgraph.test.ts`, 15 today): invert `:187-195`; add a
  stored final reply not asked again, counting model calls (the Python SDK's
  `langgraph-reask-stored-reply` mutant survived its crash tests, and would
  here too: the scripted model answers the same when asked again); a
  terminal error that closes the turn; the recursion limit. The checkpointer:
  a graph of more than 100 channels (read and pruned), and a
  `MessagesDeltaValue` graph under `'latest'` that keeps its messages across
  runs.

## DeepSeek Harness

`@deepseek-ai/dsh-*` 0.2.2-rc.2 (with `dsh-tool-executor-native`), `@deepseek-ai/cordis` 4.1.0.
[`src/deepseek/`](../src/deepseek).

### Today

- **Tables**, schema `restate-agents.deepseek` (`src/deepseek/persistence.ts:37-40`):
  `restate_deepseek_sessions(id PK, header, inherited)`, one session, whose id
  is `ctx.key` (`index.ts:306`); `restate_deepseek_events(session, seq, event)`,
  one harness `SessionEvent` per row, its seq contiguous from 0.
- **Writes**: events go to an in-memory list; a flush stores them in one
  transaction (`persistence.ts:243-276`). Flushes come from the harness's
  checkpoint policy (before each model request, before each tool's body, at
  each pre-step) and from the integration (after the harness goes idle,
  `index.ts:347-348`; on cancel, `:363-367`). After `abandon()` a failed
  attempt stores nothing more.
- **Once**: the harness's user message for a prompt has the id
  `prompt:<id>` (`index.ts:149`, `:346`). Every attempt boots a fresh harness
  and resumes the session, reading the whole log. `answered()`
  (`index.ts:334-350`) walks the log to the prompt's turn end; if the latest
  prompt (this one's, or an earlier invocation's) has none, it follows up
  `CONTINUE` ("Continue: your last turn was interrupted. Finish the
  request.", id `continue:<n>`), else the prompt.
- **Resume**: `resumeWith` closes the interrupted harness turn with
  deterministic events (a `TOOL_OUTCOME_UNKNOWN` error for a call that
  started, `TOOL_NOT_STARTED` for one only requested, then `step/end` and
  `turn/end{interrupted}`); it never continues it. Our `CONTINUE` starts a
  new harness turn, in which the model makes the call again under a new id.
  Restate's tools then rejoin the earlier call by tool and input (within one
  invocation only). Every resume costs a model request, also a suspended
  `signal` wait's. A final text reply is stored only by the integration's
  flush after idle.
- **The model's input**: `deriveMessages()` of the whole session, CONTINUE
  messages and made-up results included: unbounded, as no compaction is
  mounted (`boot`, `index.ts:129-144`). `dsh-session-checkpoint-policy` is the
  flush schedule and `dsh-session-projection` a registry of client
  read-models: neither is compaction. Compaction is `dsh-compaction-basic`
  (surface `replace` events and `compaction/*` events; the raw events stay).
- **A context overflow is no refusal** (`refused()`'s patterns,
  `src/common.ts:362-368`, do not match it), so it fails the attempt, and is
  retried forever.
- **Endings**: stopped, `agent.cancel({ kind: 'user' })`: the running tool
  gets `Error: Cancelled`, calls not dispatched get made-up results, the turn
  ends `aborted{user}`; the text CANCELLED is never stored nor shown to the
  model (`answerOf` derives it). Refused: `turn/end{error}`, a 424; the
  model later sees the refused prompt with no reply after it.
- **The transcript**: `transcribe` (`index.ts:436-447`) reads and parses
  every stored event at each publish.

### The library

- **Event-sourced**: a session is an append-only log of
  `{ type, seq, time, data }` events: `turn/start|end`, `step/start|end`,
  `system|developer|user|assistant/message`, `assistant/attempt`,
  `tool/call`, `tool/result`, `request/header`, and plugins' own
  (`approval/*`, `compaction/*`, `agent/inbox/spliced`, …). It is validated
  as it loads: contiguous seqs, events that refer to others by seq.
- **Persistence** is a seam this package implements (create, open, stat,
  list, flush; no delete); a write is durable once flushed.
- What changes per attempt: each event's `time`, random message ids, the
  model's tool call ids, and a full `request/header` logged by each loop
  instance (every invocation logs the tools' schemas again). None breaks a
  resume: the harness never replays.
- Approvals (`dsh-user-approval`: `approval/asked|decided`) are mounted
  with the `approval` option ([Approvals](#approvals)); subagents, forks
  and background jobs are not.

### Target: framework-owned history

- **The harness keeps its log**, as DeepSeek's state; the model's input stays
  the harness's, bounded by mounting `dsh-compaction-basic`.
- **Items**: a dsh-llm `Message`, with its harness seq (so that copying is
  idempotent). `read`: an assistant message says its text blocks, and its
  tool-call blocks are calls (arguments parsed); a tool message is a result
  (`isError`). The harness's own copy of the prompt (`prompt:<id>`),
  `CONTINUE` and runtime context are not copied.
- **Copy**: in `SqlSessionPersistence.#write`, in the flush's own
  transaction: the new message events of the running turn, as its items.
- **One turn**: the harness turns of one prompt (a resumed attempt's
  `CONTINUE`) are steps of one turn.
- **Asking again** (`output`'s check): the harness is asked the turn's latest
  ask (`prompt:<id>:again`), and its reply to that is the answer; its events
  are copied from there.
- **Dead turns**: never `CONTINUE` another invocation's prompt. `settle`
  writes the closing record in the store; the next boot's `resumeWith` closes
  the harness's turn; the next harness turn is given the closing note
  (`agent.inject()`: verify the model sees the closers and the note, once).
- **Stopped, refused**: the CANCELLED or UNANSWERED note in the store, and
  given to the harness's next turn.
- **Errors**: a context overflow is terminal (or a refusal), not retried
  forever.
- **Goes**: `transcribe` and `storedEvents`, `answerOf` and `lastPrompt`'s
  scans, finishing dead prompts.
- **Risks**: the harness reads its whole log at every attempt, so a turn's
  reads are not bounded for DeepSeek; rejoining a call by its input stays
  essential (keep it, with the match by id and tool); whether `abandon()`
  always wins against a flush of a tool's error result is not verified.
- **Tests** (`test/deepseek.test.ts`): invert `:228-236`; the copy across
  crashes (`crashedAnywhere`); `CONTINUE` not in the views; a dead turn closed
  with its calls' outcomes; compaction mounted; an overflow classified.
- **Compaction, mounted (after the merge)**: `boot` mounts
  `dsh-token-meter`, `dsh-compaction-tool-result-pruner` and
  `dsh-compaction-basic`, whose settings are the `compaction` option. Its
  summary is no `assistant/message` event, so the copy leaves it out; its
  request is the teller's in the tests, on a small window: the model's input
  holds the summary in place of the oldest messages, the views every
  message, and a crash at any state request of the turn that condenses is
  answered once.

### Approvals

**The harness.** A `tools/pre-execute` policy decides a call: `allow`,
`deny`, `cancel` or `ask`. On `ask`, the tool runtime asks `ctx.approval`
(`dsh-user-approval`'s `ApprovalService`) for a decision, which logs
`approval/asked`, puts the question to the `approval/request` waterfall (the
answerers), and logs `approval/decided`: `allowed-once` runs the call; a
`rejected`, `cancelled` or `unavailable` (no answerer) denies it, with the
harness's own reason (`the user rejected tool "x"`). The request names the
tool and the call id, not the arguments; the call's `tool/call` event is
appended before the policy runs, and stored by the checkpoint before the
tool body, after the decision. Each call of a parallel group is decided
before the next one starts.

**Before.** Nothing asked: no policy of this composition answers `ask`, and
without `ApprovalService` an `ask` is denied (`requires approval (not yet
supported)`). A harness tool that asks itself (the sandboxed bash tool, a
`run_code` escalation) is not mounted.

**Now.** The `approval` option (tool names, or a function of a call)
mounts `ApprovalService`, and the agent's scope gets a `tools/pre-execute`
policy that answers `ask` for the calls it names (once the other policies
allow them), and an `approval/request` answerer: a wait for the signal
`approval`, `waitFor(ctx, callId, 'approval', { tool, args }, { approval:
true, rejoin: true })`. Its value decides (`true`, `{ approved: true }`, or
a text such as `approved` or `yes` allows; anything else rejects, as the
Python SDK's `approval_of`, though the denial's reason cannot reach the
model). Before it waits, it forgets the calls whose results are stored
(`toolCallStarted`, which publishes nothing). An error of the wait fails the attempt,
and its ask never settles, so the harness stores no decision.

- **The wait rejoins.** The session is not flushed before the wait: a crash
  or a suspension while it waits leaves the log at the model request, and
  the resume has the model asked again (`CONTINUE`). Stored first, the call
  (its `tool/call` already appended) would get a result saying its outcome
  is unknown, which tells the model not to retry blindly. The model makes
  the call again under a new id: with the same tool and input it joins the
  earlier attempt's wait, so the person is asked once. A call with other
  arguments (a transfer retried with `retryOf`) asks anew. A rejected
  call's record stays until the invocation ends (its result is the
  harness's error, which `Turn.stored` does not count), so a later attempt
  of the same invocation that makes the same call again is rejected again,
  without asking.
- **An approval is not the call** (`approval: true`): a turn stopped while
  an approved tool runs closes its call as cancelled, not as done.
- **The model's input** gets the approval service's runtime context ("Approval
  policy: ask. …"), after the prompt, on the first request: only with
  `approval`.
- **Tests** (`test/deepseek.test.ts`, "the DeepSeek Harness agent's
  approvals"): approved (the tool runs after the wait, not before), denied
  (never runs; the model gets the denial), the values that decide, a crash
  while it waits (one wait, joined; the tool runs once), a crash at any
  state request (one wait for each call made), and a turn cancelled while it
  waits, or while the approved tool runs. Without `rejoin` the two crash
  tests fail; without `approval: true` the last one does.

## pi

`@earendil-works/pi-durable` 1.5.2, `pi-ai` 1.5.2, `chord` 1.5.2.
[`src/pi/`](../src/pi).

### Today

- **pi-durable's own storage**, its tables prefixed `restate_pi_`, over
  `ctx.db` ([`src/pi/storage.ts`](../src/pi/storage.ts)): by default
  (`commits: 'each'`) each pi commit is one `ctx.db.transaction`; with
  `commits: 'effects'` the commits between two effects (a model request, a
  tool call) share one, each a savepoint in it (see the pi README, "One write
  for each effect"). pi applies its own
  migrations (through chord, recorded in `restate_pi_durable_schema`).
- **Tables**: `durable_metadata`, `record_ids`, `conversations`, `entries`
  (kinds `pi.user`, `pi.assistant`, `pi.system`, `pi.tool-result`,
  `pi.reset`, `pi.compaction`), `tasks`, `submissions`, `documents` and
  `document_revisions` (`pi.agent`, `pi.provider`, `pi.usage`, …). Nothing is
  ever deleted.
- **One prompt's commits**: the user entry with its submission and a
  generation task; system entries; partial replies every 100 ms; the
  assistant entry with a tool task per call; each tool's intent; each tool's
  result; the next generation; the answer entry, with the submission done.
- **Once**: the prompt id is pi's `requestId` (`index.ts:264-266`), and
  admission dedups on it; a retried attempt opens the harness (running tasks
  become pending again), finds the submission, and waits for it.
- **Resume**: a request in flight is made again (a partial reply that was
  committed becomes an `aborted` entry); a stored reply is never asked for
  again; a cut-off tool call runs again only if its policy says
  `replay: 'safe'` (`tool()`s are, `index.ts:131-141`; pi's coding tools and
  users' `defineTool`s are not: the model is told "Tool X was interrupted and
  may have partially run"). A tool's error cancels the run and fails the
  attempt (`index.ts:226-249`). A model error is retried inside pi (3 times,
  2 s apart), then fails the turn for good (`index.ts:180-189`): an outage
  longer than that is terminal.
- **The model's input**: pi's context, from its newest head marker, bounded
  by pi's own compaction, on by default (blocking above the window less
  16 384 tokens, in the background 32 768 below that, keeping about 20 000
  recent tokens). `withPi` gives the harness itself (`compact`, `reset`, and
  more), which tutorial lesson 16 uses.
- **Endings**: stopped, `root.abort()`: tools get "Tool X was aborted"
  results, the run ends unanswered, with no closing reply; refused or failed,
  an `error` entry the model never sees. Killed: the next input waits behind
  the dead run, which pi finishes first, with tools built on the new
  invocation's context (new idempotency keys; no test covers it).
- **The transcript**: `transcribe` (`index.ts:339-364`) pages through every
  entry; the views show aborted replies, compaction summaries and reset
  handoffs.

### Target: framework-owned history, pi-durable kept

- **pi keeps its store** and its context; its compaction, `withPi`, and
  lesson 16 keep working.
- **Items**: a pi-ai `Message`, with its entry id. `read`: a user message is
  said; an assistant message (not `aborted`, `error` or `deferred`) says its
  text, with its tool calls; a tool result is a result; a system message
  says nothing. `reply(text)` makes an `AssistantMessage` (the current api,
  provider and model, no usage, `stopReason: 'stop'`), for the store only.
- **Copy**: after each pi commit, in the storage adapter's own transaction
  (with `commits: 'effects'`, in the savepoint of the batch it joins); never from `afterResponse`, which runs before pi's
  commit. Entries made between turns (a `withPi` compaction or reset) are
  not copied.
- **A spike first**, on three questions: can a dead run be aborted before
  the harness resumes it (`abort()` resumes tasks first: check the order)?
  How does a closing note (CANCELLED, UNANSWERED, ENDED) reach pi's context?
  How does a pi run's end map onto the turn's?
- **Errors**: a provider's outage fails the attempt (Restate retries), not
  the turn: lower pi's own retries, or take `model_error` as retryable unless
  it is a refusal.
- **Goes**: `transcribe`, `TRANSCRIPT`, the `transcribing` wiring.
- **Risks**: the conversation is stored twice; pi's tables grow without
  bound; the views no longer show summaries and handoffs (the README says
  they do); `withPi` code that reads `entries()` sees pi's, not the store's.
  pi's `onYield` (a run that continues with a user message) and
  `beforeCompact` (the summary supplied) are seams for asking again and for
  summaries.
- **Tests** (`test/pi.test.ts`, `test/pi-bank.test.ts`, `test/harness.test.ts`,
  the storage conformance suite): add a dead turn closed, not finished;
  the stop and refusal notes in the next model's context; the copy across
  crashes.

### The spike's findings (step 7)

- **A dead run can be aborted before pi resumes it.** `Harness.open` loads
  live tasks and turns surviving `running` ones back to `pending`, but
  dispatches nothing: scheduling starts paused, until a call that asks for
  progress. `Conversation.abort()` commits its abort marks first, so the
  dead run's tasks run their abort handlers, never their progress. The
  integration aborts the root conversation when it has a live input of
  another invocation (`harness.inspect`), as `withPi` opens, before its
  work, whatever that is (a prompt, a compaction, a wait), can have pi
  schedule anything; and, as a prompt starts, a live input of another of
  the invocation's prompts (one that failed, say). pi's own writes (a
  background compaction's) and a retried attempt's own input go on. Tests
  check the dead run's transfer is not made again under the new
  invocation, by a prompt or by a handler that only waits for pi.
- **The closing note** reaches pi as the start of the next prompt's input
  (`(<note>)` then the prompt), as for DeepSeek; the views show the prompt
  as asked. No pi extension is needed.
- **A pi run's end is its submission's**: `done` with its answer entry
  (the turn's answer), or `unanswered` (a cancellation, a refusal, a
  failure), which `answerOnce` closes. Asking again within the turn is a
  second submission, `<prompt id>:again`.
- **The copy**: each pi commit is one transaction of the storage facade
  (`SqlKvDatabase`; with `commits: 'effects'`, one savepoint of the transaction
  a batch of commits shares), whose `onCommit` copies, in it, the root
  conversation's entries after the turn's user entry (its submission's
  `entry`) and after the last copied: `pi.assistant` and `pi.tool-result`,
  each item keeping its entry id.
- **A commit of steps is published once it is done**: pi commits a tool's
  result after the tool returns, so publishing as the tool returned had a
  follower read the call without its output until the next publish. The
  storage facade's `afterCommit` publishes once a commit that copied a reply
  with tool calls, or results, is done, and only then: a tool call's start
  publishes nothing (DeepSeek's persistence does the same after a flush,
  `flushed`; OpenCode after each copy).
- **A provider's outage** no longer ends the turn: pi-durable retried a
  failed request 3 times, then settled the submission `unanswered` for good.
  A new request id per attempt would have asked again, but with the prompt
  twice in pi's context. pi retries without limit instead (`retry`'s
  `maxRetries`, by default `Infinity`), each retry committed with when it is
  due, 2 s and then twice as long each time, a minute apart at most; a
  refusal is never retried, and ends the turn.

## OpenCode

`@opencode/core`, `sdk`, `server` and `plugin` 2.2.7, with `effect` 4.1.0,
pinned exactly; OpenCode needs Node 24. [`src/opencode/`](../src/opencode).
The research behind it (what OpenCode does, the alternatives weighed, the
spike, the steps) is in [OpenCode's return](opencode.md).

### Before

- **0.3.0** (`@opencode/*` 2.0.32) ran OpenCode embedded, in a database of
  the key's own, and finished a dead turn: every boot of OpenCode resumes
  every claimed turn (a synthetic "The server restarted while you were
  working. Continue …", each running tool part failed, a new step), under
  the next invocation's idempotency keys.
- **Step 8's spike** found no public call that ends a claimed turn
  (`session.interrupt` releases nothing in a process that does not run the
  turn): so OpenCode left the package (D6), with its tests, its e2e agent and
  the examples that used it.
- **It came back** once a dead turn could be closed in OpenCode's own store
  without the model: OpenCode's resume budget
  (`SessionRestart.layer({ maxAttempts: 0 })`, in `OpenCode.create`'s
  overrides) writes a failed idle marker and releases the claim
  ([The spike's findings](opencode.md#the-spikes-findings)).

### The library

- **Embedded**: `@opencode/sdk` hosts OpenCode's whole server in the
  process, with no HTTP listener. `db.ts` boots its workerd profile (no
  filesystem, shell or terminal; the local ones with a workspace) on the
  object's database, through `Database.configuredClient`, OpenCode's seam
  for an injected Effect `SqlClient`: each OpenCode transaction an SQL
  transaction, every statement refused once the attempt's fence closes.
- **Event-sourced**: durable events, whose projections are the session, its
  messages (an assistant message updated in place as it streams, its tool
  parts with it), the inbox and idle markers. OpenCode runs its own
  migrations, and boots only on a database that is empty or its own.
- **An execution claim** per running turn, which every boot sweeps
  (`SessionRestart`): it resumes each claimed turn, or, past the session's
  resume budget, closes it.
- **Prompts** wait in the session's inbox: `delivery: 'queue'` starts after
  the running turn, `'steer'` joins it at its next step.
- **Its own compaction**: near the window, on an overflow, or asked.

### As built: framework-owned history

- **OpenCode keeps its database** (`database(ctx.db, 'restate-agents.opencode')`),
  its model input and its compaction: `answerOnce` with `ownHistory`, so
  `window`, `budget` and summaries do not apply.
- **Items** are the integration's own: `user`, `assistant` (its text and
  tool calls) and `results`. Each copied from OpenCode has `from`, its
  OpenCode message id (and part id, for a result). OpenCode's synthetic
  messages, idle markers and compactions are not copied.
- **Copy**: after each of OpenCode's commits, in a `ctx.db` transaction of
  its own, idempotent by `from`, and caught up before each tool call, the
  answer and any close; a copy of a reply with tool calls, or of results,
  is published once committed. An assistant message with tool calls is copied once
  its stream ended and none of its calls still streams its input (a reply
  is stored before its tools run); one without, once OpenCode stored how
  its step ended (`finish`), and never if the step failed (`error`) or the
  model's output limit cut it off (`length`: OpenCode asks the model to go
  on); a result once its call completed or failed. A step a crash left
  without its end is never a reply either, so such a retry resumes the
  turn and the model is asked again.
- **Once**: a prompt's OpenCode message id is `msg_<prompt id>`; OpenCode
  boots lazily, as a turn runs, so an answered prompt's retry boots nothing,
  nor does one whose turn holds its final reply (it answers with it). A
  retry of the recorded prompt first boots a reader (`restart: 'none'`, no
  sweep) and copies what OpenCode stored: if that brings the final reply
  (stored before the attempt died, before its copy or before OpenCode's
  turn ended), it is the answer, and the boot that follows closes
  OpenCode's claim without the model rather than resume the turn, which
  would ask it again. So every retry of the recorded prompt boots twice.
- **Whose claim it is** comes from `ctx.db`: the last prompt submitted to
  OpenCode, recorded before its submit (`restate_agents_opencode`, one row).
  A boot for that prompt resumes its turn, with no limit
  (`maxAttempts: Infinity`: Restate's retry policy decides); a boot for any
  other closes it (`maxAttempts: 0`), and the sweep is awaited
  (`Host.swept`) before anything is submitted. Another prompt's input still
  in OpenCode's inbox (a prompt killed after OpenCode queued it, before its
  turn's claim) is cancelled.
- **Dead turns**: `Items.settleOwn`, which `answerOnce` calls before every
  close and `settle` before its own: OpenCode's close first, then the copy,
  then the store's (`ended`), the only order that stays consistent across a
  crash between the two stores. The budget leaves OpenCode's history saying
  only that the running calls were interrupted, so the next prompt's text
  starts with the closing note and the calls that did happen
  (`(Ended: … These calls did happen: …)`). A final reply OpenCode stored
  before the kill is kept in the turn, before the `Ended` note.
- **Stopped**: the copy, then `session.interrupt`, and nothing copied after
  (the store's result of a cut-off call is the cancel note) but the steered
  messages OpenCode placed as the turn stopped, which are the turn's (copied
  once the interrupt returns, in the copies' order, not once the fence
  closed). The turn closes cancelled whatever that copy does, and whatever
  the interrupt does in an attempt whose fence closed. The next prompt
  starts with the note.
- **Refused, failed**: a turn OpenCode ends unanswered is a terminal error;
  a refusal (by its message, OpenCode's error type, or a 401 or 403) a 424,
  never retried.
- **A provider's outage** never ends the turn: OpenCode's `session.retry`
  hook (`retryPlugin`) decides each retry, with pi's backoff and `retry`
  option (2 s, twice as long each time, a minute apart at most, without
  limit), never before the provider's `retry-after` (up to OpenCode's
  15 minutes, which `maxAgentDelayMs` does not shorten). OpenCode's own
  schedule retries a step 10 times at most, and stops at its 4th timeout in
  a step: an outage it would retry for the last time, or no longer retries,
  fails the attempt instead (not terminal; the hook proposes a wait that
  never ends while the attempt closes), and the next attempt resumes the
  turn, retrying afresh. With a finite `maxRetries`, a failure past it, or
  one OpenCode no longer retries, ends the turn.
- **Asking again** (`output`'s check): a second message,
  `msg_<prompt id>_again`, in the same turn.
- **Tools**: a tool's error fails the attempt and closes its fence; the
  resumed turn gives the cut-off call an "interrupted" result, and the model
  makes it again under a new id, which Restate's tools rejoin by tool and
  input. With a workspace, OpenCode's own tools stay, but its subagent and
  question tools (removed) and its shell's background jobs (refused).
- **`clear`**: `Items.erase`, OpenCode's database, then the store; not atomic.
- **A stalled turn** (neither running nor ended for 5 s) fails the attempt:
  the retry's boot resumes it.

### Approvals

**OpenCode.** With a workspace, its build agent's permission rules allow
every action but a few, which ask (a `read` of `*.env`). OpenCode awaits
the `permission.evaluate` hook before it asks, whose event has the action,
the resources and the source (a tool call's id). An ask OpenCode makes
waits in its memory for a client's reply (`permission.list` shows it):
embedded with nobody to reply, the turn never ends (the test "OpenCode
alone asks in memory"). OpenCode denies an ask nobody is present for (its
`Unattended` rules).

**Now.** `permissionPlugin` settles every ask in the hook; what the rules
allow or deny stays so. Without `approval`, an ask is denied, as OpenCode
denies one nobody is present for: the model gets the denial (`Permission
<action> needs approval, and nobody is present to give it`) as the tool's
error. With `approval: true`, an ask of a tool call waits for the signal
`approval`, `waitFor(ctx, callId, 'approval', { tool, args, action,
resources }, { approval: true, rejoin: true })`, the tool and arguments from
the call's `execute.before` hook. Its value decides (`true`,
`{ approved: true }`, or a text such as `approved` or `yes` allows;
anything else denies, and its text or `reason` reaches the model: `The user
denied tool "<tool>": <reason>`). An error of the wait fails the attempt,
and its ask never settles. An ask of no tool call is denied.

- **The wait rejoins.** OpenCode stores the call, running, before the tool
  asks; a crash or a suspension while it waits has the resumed turn give it
  OpenCode's "interrupted" result, and the model makes it again under a new
  id: with the same tool and arguments it joins the wait, so the person is
  asked once.
- **An approval is not the call** (`approval: true`): a stopped turn does
  not report its call as done because it was approved.
- **Limits**: the wait is the tool call's, so a call that asks more than
  once (a directory, then the file) has each ask answered by the first's
  answer; and the hook cannot tell an ask from a probe
  (`permission.allows`, which an edit's hint on a miss makes), so a probe
  that would ask waits too.
- **Tests** (`test/opencode.test.ts`, "the OpenCode agent's permission
  asks"): OpenCode alone (the ask stays in memory, the turn never ends),
  denied by default, approved (the tool runs after the wait, not before),
  denied by a person (never runs; the model is told why), a crash while it
  waits (one wait; the tool runs once), and a turn stopped while it waits
  (cancelled; the tool never runs).

### Left

- **A change of `model`** for a key whose session exists: the session is
  created with the model, and keeps it.
- **Background work**: OpenCode's child sessions and background shell jobs,
  once their recovery is mapped onto turns.
- **Risks**: two stores with no shared transaction (the copy lags a crash,
  for followers, never for the model); three copies of each conversation
  (OpenCode's events, its messages, the turn's items); an event log that
  grows without bound; a boot per attempt (about 100 ms; 2 s for a process's
  first import).
- **Tests** (`test/opencode.test.ts`): answered once, crashes in a tool call
  and at any state request, more resumes than OpenCode's own limit, a
  killed turn closed by the next message and by `settle` (with the calls
  that did happen), a prompt killed in OpenCode's inbox, a stop, a refusal,
  publishes, the views, `clear`, asking again, the system prompt,
  steering (a message placed as the turn stops included), a provider's
  outage (retried; past OpenCode's retries or at its 4th timeout, the
  attempt fails and the next answers; `retry-after`; a refusal at once; a
  stop while it waits), permission asks ([Approvals](#approvals-1)), and an
  attempt killed at a turn's end (the stored final reply answers, once);
  `test/opencode-spike.test.ts`, `db.ts` alone; the e2e crash test's
  `OpenCodeAgent`, kills included.

## agentlib

`@restatedev/agentlib` 0.2.0, on `@restatedev/restate-sdk-gen` 1.18.2.
[`src/agentlib/`](../src/agentlib). Not on the conversation of turns, nor
in a session object: it is the one integration on the classic Restate SDK.

### As built: a journaled object

- **The object**: a virtual object of the SDK that @restatedev/sessions
  pins (its `sdk`), named as the agent; `chat` runs agentlib's `run` with
  `execute(ctx, …)` of the generator SDK. Restate journals what the run
  does (each model call, a `run`; each tool's I/O; its calls and signals)
  and replays it after a crash, a suspension or a deployment: jobs 2 and 3
  are Restate's own, and the integration stores nothing for them.
- **The conversation**: agentlib's `Conversation`, in the object's state,
  agentlib's `LazyStateConversation` on a store of the invocation's state:
  its messages in chunks of 32 (`t/<n>`), loaded since its summary at each
  turn's start, and appended when the run saves its turn (at its end); a
  turn that ends without its save appends its message and a note itself.
  At a turn's start, past `history`'s bounds (64 messages or 64 000
  characters, by default), its `compact` summarizes the earliest with the
  agent's model, keeping the latest 12, and keeps the summary (`t/meta`):
  the model's input, and what a turn loads and journals, stay bounded. Beside them, the
  messages as clients read them, one key each (`c/<id>`), with the cursor
  of their last change, and `meta` (the counts, the cursor, the turn being
  answered). An invocation preloads `meta`, `taken` and `t/meta` alone: a view such
  as `status` is not sent the conversation. The turn being answered is written from the run's progress
  events (a tool call's start and end, a steered message) as they come,
  then rewritten from the messages the run saves, under the same ids, each
  with a new cursor: so `messages` by cursor scans back only to the first
  message of an ended turn that did not change.
- **The views**: shared handlers that ask the companion (`status`,
  `pending`, `signal`, `steer`, `watch`, `notifications`) or read the state
  (`messages`); `sync` calls `messages` as an invocation of its own, after
  the revision, so that its page has what the revision counts.
- **Steering**: the companion's inbox, as for every agent; the turn learns
  of messages at each publish (after a progress event that changed what
  clients read), and hands all those waiting to agentlib's
  `controls.steering`, as one update, through a channel of the generator
  SDK, at the run's next event once it asks for more. agentlib's
  `steering` event says which it took (`data.steer`): the turn keeps their
  ids in `taken`, which their own `steered` turn checks, and tells the
  companion (`taken`).
- **Tools**: the tools of `@restatedev/agents` carry what they do
  (`specOf`: a `call`'s typed target and options, a `tool()`'s `run`), and
  `toolsOf` makes each agentlib's own (`src/agentlib/tools.ts`), its calls
  the generator SDK's on the invocation's classic context: `call`,
  `subagent` and `workflow` (start and attach by invocation id, as
  `runWorkflow`) are journaled calls, which Restate cancels with the turn;
  `send` a journaled send; `signal` the companion's `wait`; a `tool()`'s
  `run` a journaled `run`, whose `ctx` has `key` and `request` alone (a
  `ctx.db` or `ctx.rpc` fails the turn, with agentlib's `RunFailedError`).
  No call records and no idempotency keys: the journal makes each call
  once. agentlib's `serviceTool` takes the generator SDK's descriptors,
  which a definition of the classic SDK is not: `call` is the typed way.
- **Approvals**: agentlib's `onHumanApproval`, which waits for the signal
  `approval` through the companion's `wait`, by agentlib's own name for the
  ask (`<agent>:approval:<call>:<n>`).
- **Endings**: a cancelled turn (`stop`), a refused one (a terminal error
  of the model's, made a 424 by the model's wrapper) or a failed one stores
  its message, the messages steered to it that it took, and a note
  (`Cancelled`, `Unanswered`, `Failed: …`) in the conversation, without
  the turn's tool calls, whose results may be missing; a killed turn is closed by the next message, `Ended`. A retried
  attempt's errors (anything but a terminal error) fail the attempt, and
  the replay goes on.
- **Models**: `openai/…` and `anthropic/…` are `aiModel` on the AI SDK's
  providers, loaded with the first message, with no retry limit of their
  own (`retry: {}`): an outage fails the attempt, and the object's retry
  policy (every agent's) retries it; a 4xx, or a missing API key, is a
  refusal (424). agentlib 0.1.0's `aiModel`
  asked for strict tools where the schema allowed, and Anthropic refuses strict
  tools with bounded numbers, so its tools' schemas go without them (0.2.0
  leaves strict mode to the AI SDK; the tools still check their input).
- **Tests**: [`e2e/agentlib.ts`](../../e2e/agentlib.ts), against a real
  server: a signal's wait, steering, `messages` by page, cursor and
  summary, `sync`, a denied approval, a stop, a refusal, `clear`, Restate's
  tools (`call`, `send`, `workflow` on services of the classic SDK, `tool()`,
  a `tool()` reaching for `ctx.db`), sub-agents both ways (a pi agent's, and of a pi agent: stopped with the turn), and
  the service killed mid-turn (the model asked once per step).
