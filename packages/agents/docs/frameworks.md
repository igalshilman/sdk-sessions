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
  `waitFor(ctx, callId, signal, input, { approval })` for a framework's own
  durable wait.
- **The turn's signal** (`stopSignalOf`), refusals (`refusalOf`, `fromTool`),
  and publishing (`toolCallStarted`, `toolCallEnded`), as today.

### At a glance, the target

|                     | Claude                         | LangGraph (built-in agent)    | DeepSeek Harness                          | pi                                   | OpenCode                                  |
| ------------------- | ------------------------------ | ----------------------------- | ----------------------------------------- | ------------------------------------ | ----------------------------------------- |
| The model's history | turn projection (`history()`)  | turn projection (`history()`) | its own (the harness's event log)         | its own (pi-durable's entries)       | its own (its database)                    |
| An item             | a `BetaMessageParam`           | a LangChain `BaseMessage`     | a dsh-llm `Message`, with its harness seq | a pi-ai `Message`, with its entry id | an OpenCode message                       |
| Steps stored from   | the run loop, before tools run | the graph's nodes             | each flush, in its transaction            | each pi commit, in its transaction   | each publish, after OpenCode's own commit |
| Long conversations  | our summaries (`compact`)      | our summaries (`compact`)     | `dsh-compaction-basic`, mounted           | pi's own compaction                  | OpenCode's own compaction                 |
| A turn carries      | nothing                        | nothing                       | nothing (in its log)                      | nothing (in pi's documents)          | nothing (in its database)                 |
| Order in the plan   | step 4                         | step 5                        | step 6                                    | step 7, after a spike                | step 8, after a spike (or dropped)        |

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

The Anthropic SDK's tool runner (`@anthropic-ai/sdk` 0.133.0).
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
  model is not asked again (new: today the reply and the answer are one
  write). Otherwise the open calls (`turn.openCalls()`) run with their ids,
  and their results are appended; then each reply is appended
  (`appendReply`) before its tools run, and its results after.
- **Errors**: the SDK's `ToolError` is the tool's answer to the model, not
  an attempt's failure. `model_context_window_exceeded` is no answer (a
  terminal error); `pause_turn` stores the paused reply as a step and goes
  on.
- **Summaries**: `summarize` with the agent's own client and model.
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

`@langchain/langgraph` 1.4.18, `@langchain/langgraph-checkpoint` 1.1.5,
`@langchain/core` 1.2.12. [`src/langgraph/`](../src/langgraph).

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
  returns; the tools node appends each `ToolMessage` as it lands (in
  `failing`, `index.ts:69-95`), then publishes; START goes to the tools node
  if the turn has open calls; a stored final reply returns at once. The input
  is `{ messages: conversation.history() }`.
- **Errors**: a `recursionLimit` of about 10 000, and `GraphRecursionError`
  terminal; a `TerminalError` closes the turn as failed (`answerOnce` does).
- **Summaries**: `summarize` with the agent's own model.
- **Goes**: the `prompt` and `answers` channels, the `answer` node, `close()`,
  the `for (;;)` loop, `transcribe`.
- **The checkpointer stays** for graphs of your own: its queries match lists
  of rows, `(channel, version) IN (VALUES (?, ?), …)`, and `'latest'` keeps
  what a `DeltaChannel` is rebuilt from, the latest checkpoint's ancestors
  back to each delta channel's snapshot (Python's `_kept` in
  [`_checkpointer.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/langgraph/_checkpointer.py)),
  counting only the channels the checkpoint holds.
- **Later, not in this port**: `agent({ graph })`, a graph of your own on
  framework-owned history (the Python SDK's `_graph.py`: the messages after
  the run's input copied by id, the prompt's id `prompt:<turn>`, a window of
  at least 1, a closed turn's closing record as the run's input), with
  `interrupt()` as Restate signals.
- **Tests** (`test/langgraph.test.ts`, 15 today): invert `:187-195`; add a
  stored final reply not asked again, counting model calls (the Python SDK's
  `langgraph-reask-stored-reply` mutant survived its crash tests, and would
  here too: the scripted model answers the same when asked again); a
  terminal error that closes the turn; the recursion limit. The checkpointer:
  a graph of more than 100 channels (read and pruned), and a
  `MessagesDeltaValue` graph under `'latest'` that keeps its messages across
  runs.

## DeepSeek Harness

`@deepseek-ai/dsh-*` 0.2.1-rc.2, `@deepseek-ai/cordis` 4.0.5.
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
- Approvals exist (`dsh-user-approval`: `approval/asked|decided`), not
  mounted; nor are subagents, forks or background jobs.

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

## pi

`@earendil-works/pi-durable` 1.4.0, `pi-ai` 1.4.0, `chord` 1.4.0.
[`src/pi/`](../src/pi).

### Today

- **pi-durable's own storage**, its tables prefixed `restate_pi_`, over
  `ctx.db` ([`src/pi/storage.ts`](../src/pi/storage.ts)): each pi commit is
  one `ctx.db.transaction` (`storage.ts:54-56`), and pi applies its own
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
  (`storage.ts:54-56`); never from `afterResponse`, which runs before pi's
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
  (`SqlKvDatabase`), whose `onCommit` copies, in it, the root
  conversation's entries after the turn's user entry (its submission's
  `entry`) and after the last copied: `pi.assistant` and `pi.tool-result`,
  each item keeping its entry id.
- **Not done**: a provider's outage still ends the turn (pi settles the
  submission `unanswered`, and a retry finds it settled): retrying it would
  take a new request id per attempt.

## OpenCode

`@opencode/*` 2.0.32, with `effect` 4.0.1. `src/opencode/` (removed in step 8).

### Today

- **A database of its own**: `database(ctx.db, 'restate-agents.opencode')`
  (`src/opencode/index.ts:111-112`, `:448`), a second SQL database of the
  key, in Restate's state, opened per attempt, which OpenCode reaches through
  an Effect `SqlClient` (`db.ts:81-147`); every statement is refused once the
  attempt's fence closes (`db.ts:54-63`). OpenCode runs its own migrations,
  and boots only on a database that is empty or its own.
- **Tables** (OpenCode's): `session_v2` (agent, model, permission rules,
  directory, title, usage, the execution claim `time_suspended`,
  `resume_attempts`), `session_message` (one row per message, updated in
  place: user, synthetic, system, assistant with its text, reasoning and tool
  parts, compaction, idle markers), `session_inbox`, instruction tables,
  `event` and `event_sequence`, project, workspace, permission and account
  tables.
- **Once**: the prompt's inbox and message id is `msg_<invocation>[_n]`
  (`index.ts:209`, `:463-464`); `submit` (`:361-374`) queues it unless it is
  there, after the latest prompt settled; `settled` (`:384-400`) reads the
  turn's end: its `idle` marker, or a later user message.
- **Resume**: each attempt boots OpenCode on the stored database
  (`db.ts:188-223`, with `SessionRestart.maxAttempts: Infinity`); it resumes
  each claimed session: a synthetic message ("The server restarted while you
  were working. Continue …"), each running tool part failed ("Tool execution
  interrupted"), and a new step, in which the model makes the call again
  under a new id. A tool call is committed before its tool runs, and its
  result as it returns; parallel calls run at once.
- **The model's input**: the messages since OpenCode's latest compaction;
  OpenCode compacts on its own (near the window, on an overflow, or asked).
  `system` is added per request by a hook, never stored (`index.ts:147-155`).
- **Endings**: stopped, `session.interrupt` (tools "interrupted", an `idle`
  marker); CANCELLED is never used. Refused: OpenCode retries, then a failed
  `idle` and a terminal error (424 if a refusal); any other failed turn is
  terminal. Killed: the claim stays, the tool part stays `running`, no
  `idle` marker; the next boot finishes the turn, and `submit` waits for it.
- **With a workspace**, OpenCode's own tools stay (`index.ts:165`): subagents
  (child sessions, background ones too), shell (background jobs), questions,
  web fetch. Its permission asks and question forms wait on in-memory
  promises that nothing answers.
- **The transcript**: `transcribe(host)` (`index.ts:526-541`) reads every
  message through OpenCode's own client, at each publish.

### Target: framework-owned history, after a spike

- **OpenCode keeps its database**, its model input and its compaction.
- **Items**: an OpenCode message. `read`: a user message is said; a
  synthetic one says nothing; an assistant message says its text, its tool
  parts are calls, and those completed or failed are results too, from the
  same item. `results(calls)` has no form of OpenCode's own (it has no tool
  result message): an assistant-shaped item with failed tool parts.
- **Copy**: at each publish, the messages since a cursor, an assistant
  message once its step ended, keyed by OpenCode's id; the turn ends at the
  `idle` marker. The two databases cannot share a transaction, so the copy
  is idempotent, and may lag a crash.
- **The spike decides** whether a dead turn can be closed without OpenCode
  resuming it: booting with `resume: false` (`db.ts:161-165`, `:179-182`),
  then failing its running tool parts and releasing its claim through a
  public API (none found so far). `settle` would boot OpenCode (about 100 ms,
  2 s for a process's first import).
- **If it cannot**, OpenCode leaves the package for now (D6 in
  [the plan](plan.md#decisions)): its subpaths (`./opencode`,
  `./opencode/db`), `src/opencode/`, its tests and fakes
  (`test/opencode*.ts`, `test/fakes/opencode*.ts`,
  `test/storage/opencode.test.ts`, its cases in `test/models.test.ts` and
  `test/fakes/fakes.ts`), the e2e agent (`OpenCodeAgent` in
  `packages/e2e/crash.ts`), the examples that use it
  (`examples/basic/opencode.ts`, `examples/intermediate/coding.ts`,
  `review.ts`, `team.ts`, `examples/advanced/factory/factory.ts`), its
  devDependencies, and its rows in the READMEs.
- **The spike's finding (step 8): it cannot.** A turn crashed in its
  transfer, then OpenCode booted with `resume: false`, and its public
  `session.interrupt` called: the call succeeds, but releases nothing (no
  turn of the session is active in that process). The next prompt's boot
  resumes the dead turn, and its transfer is made again under the new
  invocation's idempotency key (`inv2:call_…`). No other public call ends a
  claimed turn. So OpenCode left the package (D6): its subpaths, sources,
  tests, fakes, the e2e agent, the OpenCode-only examples (`basic/opencode.ts`,
  `intermediate/coding.ts`, `review.ts`); `team.ts`'s writer is a Claude
  agent now, and the factory's coder a pi one.
- **Risks**: three copies of each conversation (OpenCode's events, its
  messages, our items); drift when `withOpenCode` reverts, forks, compacts
  or switches models; messages updated in place against items appended once;
  `clear` across two databases is not atomic (`src/object.ts:156-166`).
