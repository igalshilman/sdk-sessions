# The plan: one conversation of turns, for every framework

How `@restatedev/agents` moves to the conversation model of the Python SDK
([restatedev/sdk-python#296](https://github.com/restatedev/sdk-python/pull/296)):
the decisions, the steps in order, what must hold afterwards, the tests that
define it, and how each step is reviewed. The model itself is in
[Turn semantics](turns.md) and [The conversation](conversation.md); each
framework's research in [The frameworks](frameworks.md).

## Why

Today each framework keeps its own conversation in its own tables, and
`restate_agent_log` is a copy of it that clients read, kept in step at every
publish. Research of the five integrations ([The frameworks](frameworks.md))
found what that costs:

1. **A dead turn is finished under the next invocation**, in every
   framework, with that invocation's idempotency keys and without the dead
   invocation's call records: a `call`, `send`, `subagent` or `workflow` it
   made can be made again.
2. **The model's input is unbounded** for Claude, LangGraph and DeepSeek. A
   long Claude conversation ends in a 400 taken for a refusal, so the key
   answers 424 until `clear`; a DeepSeek overflow is retried forever;
   LangGraph's default recursion limit (25) cuts long turns.
3. **Every publish reads the whole conversation**, to keep the log in step.
4. **Endings differ by framework**: pi, DeepSeek and OpenCode give the next
   model no note of a stopped or refused turn; a LangGraph turn that failed
   for good stays open, and the next message runs into it again.
5. **Smaller bugs**: call records matched by id alone, with no approvals;
   LangGraph's checkpointer fails past about 95 channels and loses a
   `DeltaChannel`'s history; Claude retries a `ToolError` meant for the model;
   `output` asks again as a second turn.

The store fixes 1 to 4 for every framework at once, and the steps below fix
the rest on the way.

## Ground rules

- **The branch and the PR.** All work lands on this PR's branch, one step
  (or a few commits) at a time, in the order below. Each commit leaves the
  repository green: `pnpm lint`, and the tests of every package it touches.
- **Breaking changes are fine.** `@restatedev/agents` is unannounced: change
  APIs, tables and behaviour freely, and say so in the commit message. No
  migration of v0.3.0 data (D1).
- **Shared with the Python SDK, exactly** (D2): the conversation's tables and
  schema steps, the call records' table, the companion's handler names and
  wire shapes, the views' wire shapes, the constants' texts, the defaults.
  When in doubt, do what the Python SDK does, and read its code and tests at
  `434bb6f` ([links](README.md#the-reference-the-python-sdk)).
- **Port the behaviour, not the idioms**: TypeScript's promises, the turn's
  `AbortSignal` (`stopSignalOf`), `ScopeKey` for per-attempt state, `Link`
  for what hangs on a definition, as the code does today.
- **Every fix and every rule has a test that fails without it.** Say in the
  commit message which tests those are, so that a review can revert the code
  and watch them fail. Never skip, weaken or delete a test to get green; a
  test that encodes today's behaviour on purpose (finishing a dead turn,
  say) is rewritten to the new behaviour, in the same commit.
- **The house style**: comments say why, in plain words, as the code around
  them does; names as the codebase has them; `oxfmt` and `oxlint` clean.
- **The docs move with the code.** A step that finds a page here wrong fixes
  the page in the same commit, and says so. Tick the step in
  [Status](#status) as it lands.
- **Spikes report before they port.** Steps 7 and 8 start with a spike,
  whose findings go in the PR (a comment, and a note in
  [The frameworks](frameworks.md)) before the port goes on.

## Build and test

At the repository's root, with Node 24 or later (`node --version`; in a
container whose default `node` is older, put Node 24 first on `PATH`), pnpm
11 and Rust (for the SQL addon):

```sh
pnpm install && pnpm build                 # once: the dependencies, and @restatedev/sessions' addon
pnpm --filter @restatedev/agents test      # the agents' tests, no server (905 at the start, about 30 s)
pnpm --filter @restatedev/agents test claude   # one file's
pnpm lint                                  # types, oxlint, oxfmt (pnpm format fixes formatting)
pnpm test                                  # every package's tests, and the addon's Rust tests
pnpm --filter e2e crash                    # agents and sessions through crashes, against a real Restate server (about 4 minutes)
```

The agents' tests run without a Restate server: `test/support.ts` runs a
handler's attempts over an in-memory store, crashes them at a chosen state
request (`conversation(...).attempt(id, prompt, crashAt)`), sweeps every
crash point (`crashedAnywhere`), and fakes the companion and a bank ledger;
the companion's own handlers are tested on a fake context
(`test/signals.test.ts`). The e2e crash test (`packages/e2e/crash.ts`) runs
every framework's agent (`test/<framework>.ts`) in processes it kills at
random, and checks that every prompt is in `messages` once and moved money
once.

## Decisions

Proposed defaults: the PR's review may change any of them, and D5 and D6 most
of all.

| #   | Decision                                                                                                                                                                                                                                                                                            | Why                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **New databases only.** No migration from v0.3.0's tables, no `DROP TABLE`, no compatibility code. A key that v0.3.0 wrote keeps its old tables, unused (no name collides).                                                                                                                         | Unannounced; the Python SDK did the same (its D1).                                                                                          |
| D2  | **Parity with the Python SDK** for what is shared: `restate_agents.turns` (its steps, in order), `restate-agents.calls`, the companion's handlers and shapes, `messages` and `sync`, `CANCELLED`, `UNANSWERED`, `ENDED`, `RETURNED_UNRECORDED`, `SUMMARY`, `SUMMARIZE`, `window` 1, `budget` 32 000 | One layout and one wire format for both SDKs: a deployment's `signals` serves both, and a client or tool reads either.                      |
| D3  | **Snapshots are not ported.** Their table is created (the schema's steps stay Python's), and nothing writes it.                                                                                                                                                                                     | No framework here takes a list of items and compacts it itself.                                                                             |
| D4  | **Two ways to give the model its history**: the turn projection (Claude, LangGraph's built-in agent), and framework-owned history (DeepSeek, pi, OpenCode).                                                                                                                                         | DeepSeek, pi and OpenCode are durable engines with their own stores, which cannot be handed a list of messages ([why](frameworks.md)).      |
| D5  | **pi keeps pi-durable**, on framework-owned history, rather than the turn projection on pi-ai alone.                                                                                                                                                                                                | The other way drops pi-durable's harness, coding tools, compaction and `withPi`, which the README's default and tutorial lesson 16 rely on. |
| D6  | **OpenCode goes last, after a spike.** If a dead turn cannot be closed through OpenCode's public API (it resumes a claimed turn at every boot), OpenCode leaves the package for now.                                                                                                                | It is the riskiest port: a second database, messages changed in place, no shared transaction.                                               |
| D7  | **One framework per object.** An object's conversation holds its framework's items (from its `messages` view); `answerOnce` refuses another framework's items in the same object.                                                                                                                   | The rows are the framework's own items; two formats in one conversation can't be read.                                                      |
| D8  | **A dead turn is closed, never finished**, in every framework.                                                                                                                                                                                                                                      | Finishing it answers a prompt nobody waits for, under the wrong idempotency keys.                                                           |
| D9  | **`output` asks again within the turn** (`check`), once; a second reply that does not fit fails the turn, terminal, as today.                                                                                                                                                                       | Asking again is a step of the turn, not a turn of its own.                                                                                  |
| D10 | **The status type `Turn` is renamed `Answering`**; `Turn` is the conversation's turn. The wire format (`invocationId`, `since`) does not change.                                                                                                                                                    | As in the Python SDK.                                                                                                                       |
| D11 | **LangGraph's checkpointer keeps its schema name** (`restate-agents.langgraph`), though the Python SDK's is `restate_agents.langgraph`.                                                                                                                                                             | Its tables are a framework's, not the conversation's; a new name would make v0.3.0's databases fail, for nothing.                           |

## The steps

Each step lists its files, its design (what the docs leave open), its tests,
and when it is done. Steps 1 and 2 stand alone; 3 is the store; 4 to 8 move
one framework each; 9 removes what is left of the old way; 10 is the docs.

### Step 1: the call records

Port [`_calls.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/_calls.py)'s
rules to [`src/calls.ts`](../src/calls.ts) and
[`src/tools.ts`](../src/tools.ts)
([Tool calls, once](conversation.md#tool-calls-once-the-call-records)).

- `callOf(ctx, tool, input, callId, { rejoin = true, approval = false })`:
  find the record by the call's id **and** its tool; if none and `rejoin`,
  the record another attempt made with the same tool and input; else a new
  one, marked `approval` if it is one. The input is JSON with sorted keys.
  Only the records of the prompt being answered count (`forPrompt`, around
  `answerOnce`'s turn): a second prompt of the invocation that makes the
  first's call again makes its own.
- Restate's own tools (`call`, `send`, `workflow`, `subagent`, `signal`)
  rejoin; a framework's own wait does not.
- `outcomes(ctx, callIds, invocation?, prompt?)`: which of the calls
  returned, each with its terminal error or nothing, from this invocation's
  records or, read only, from `invocation`'s while they are still stored, of
  `prompt`'s turn if given; approvals left out.
  Step 3's `Turn.close` and `settle` use it.
- `waitFor(ctx, callId, signal, input?, { approval })` in `tools.ts`, as the
  Python SDK's `wait_for`: the companion's `wait`, as `<invocation>:<call
  id>`, recorded without rejoining; `pending` shows `input` only if given.
- `calls.ts`'s `settle` (forgetting the records whose results are stored)
  and step 3's `settle` (closing a dead turn) are different things: rename
  the first (`settleCalls`, say).

**Tests** (a new `test/calls.test.ts`, or `test/tools.test.ts`): a record is
found by its id and tool, so a tool call's approval and its own Restate call
keep a record each; a Restate tool rejoins another attempt's call by its
input, under a new id, with the same idempotency key; `waitFor` never
rejoins (a new call with the same input waits anew); an approval is never in
`outcomes`; `outcomes` reads an earlier invocation's records; concurrent
`waitFor`s in one attempt keep a record each.

**Done when** the tests pass, and every framework's tests still do.

### Step 2: LangGraph's checkpointer

[`src/langgraph/checkpointer.ts`](../src/langgraph/checkpointer.ts), for
graphs of your own; the built-in agent leaves it in step 5.

- `#channelValues` and `dropEarlier` match `(channel, version) IN (VALUES
  (?, ?), …)`, never an `OR` per pair (the database refuses expressions more
  than 100 deep).
- `history: 'latest'` keeps what a `DeltaChannel` is rebuilt from: the
  latest checkpoint's ancestors back to each delta channel's snapshot,
  counting only the channels the checkpoint holds (`_kept` in the Python
  SDK's
  [`_checkpointer.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/langgraph/_checkpointer.py)),
  and their writes and channel values.
- The schema keeps its name (D11).

**Tests** (`test/storage/`): a graph of more than 100 channels, read and
pruned; a `MessagesDeltaValue` graph under `'latest'` keeps its messages
across three runs; the conformance suite also with `'latest'` where it
applies.

**Done when** they pass, and fail with the old queries and prune.

### Step 3: the store, on a made-up framework

The core, ported from
[`_conversation.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/_conversation.py),
[`_messages.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/_messages.py),
the `settle` parts of
[`_signals.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/_signals.py)
and
[`_object.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/_object.py),
and `answering` of
[`_turn.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/python/restate/agents/_turn.py).
No framework moves yet: they keep `transcribing` and the log until their own
step, so both ways live side by side until step 9.

**`src/conversation.ts`** (new): the schema
([its steps](conversation.md#the-tables)), `startOf`, `lastOf`, `nextStart`,
`restart`, the window walk, `Turn`, `Conversation`, `answerIn`,
`answerOnce`, `settle`, `compact`. The shape:

```ts
export type Status = 'answered' | 'cancelled' | 'failed' | 'refused' | 'ended';
export interface Call {
  id: string;
  name: string;
  input: unknown;
}
/** A result is an error if `error`, or if its output starts with `Error: `. */
export interface Result {
  id: string;
  output: string;
  error?: boolean;
}
export interface Parsed {
  said?: ['user' | 'assistant', string];
  calls?: Call[];
  results?: Result[];
}

/** A framework's items: how the core stores, reads and makes them. */
export interface Items<I> {
  dump(item: I): string;
  load(stored: string): I;
  prompt(text: string): I;
  reply(text: string, agent?: string): I;
  results(results: [Call, string][]): I[];
  read(item: I): Parsed;
  /** The summary of the earliest turns in the framework's own form; by default a user's message and "Understood." */
  summary?(text: string): I[];
}

/** A framework's run: from the conversation, whose latest turn is the one to answer, to its answer. */
export type Run<I> = (conversation: Conversation<I>) => Promise<string>;

export function answerOnce<I>(
  ctx: restate.SessionContext,
  text: string,
  items: Items<I>,
  run: Run<I>,
  options?: { window?: Window; budget?: number; check?: Check },
): Promise<string>;
export function settle<I>(ctx: restate.SessionContext, items: Items<I>, invocationId: string): Promise<boolean>;
export function compact<I>(ctx: restate.SessionContext, items: Items<I>): Promise<boolean>;
```

- **Writes** go one after another through a promise chain per conversation
  (as `WRITING` in `common.ts`), so that tool calls in parallel each get
  positions of their own. One row is one statement; several are one
  transaction. Every write checks that its turn is the latest, without an
  answer, and that the conversation is not sealed.
- **`answerOnce`**, as the Python SDK's: the agent's `window` and `budget`
  unless given; `nextPromptId`; the answer by the prompt's id, which a retry
  returns (`storedAnswer`); else load, then `_answer` inside `answering`
  (below); after the answer, if the agent summarizes and the turns before the
  next window outgrow the budget, send the agent `compact` with the
  idempotency key `<prompt id>:compact`.
- **`_answer`**: a turn left without an answer by another prompt is closed
  `ended` first; then the turn is asked, or carried on. The run races the
  turn's stop signal (`stopSignalOf`). Its end:
  - `AttemptEnded`: thrown again, nothing written;
  - a `restate.CancelledError` (the stop's reason, or thrown): close
    `cancelled` with `CANCELLED`, seal the conversation, throw it again;
  - another `TerminalError`: close `failed` with `Error: <message>`, throw
    it again;
  - a refusal (`refusalOf`): close `refused` with `UNANSWERED`, throw the
    424;
  - anything else: thrown again (the attempt fails, and Restate retries);
  - an answer: with `check`, ask again once (`Turn.askAgain`), unless the
    turn's latest ask is already not its prompt; then `answered`.
- **`Turn.close`**: a result for each open call (`cutOffResult` of the
  call's `outcomes`, read for the invocation of the turn's prompt), the note
  as the turn's last reply, and the answer, with its status. A turn with an
  answer has nothing to close.
- **`settle`**: the latest turn's row; only if it has no status and its
  prompt is invocation `invocationId`'s, load with a window of 0, and close
  it `ended`.
- **`compact`**: as the Python SDK's, without snapshots: load the transcript
  from the summary's end whatever the budget; summarize those before the
  next window but the latest that half the budget holds; store the summary
  and its end in the start row. A summary that fails is logged.

**`src/messages.ts`** (new): `page(db, items, request)`, the full and summary
views, as the Python SDK's: a message's `seq` is the latest of its rows';
the full view renders from the earliest changed turn on; the summary view
reads the turn rows only (the prompt at `n` and `seq`, the answer at
`answered_at` and `answered_seq`); `first` is the start row's position when
it is not 0. `MessagesRequest` gains `view?: 'full' | 'summary'`.

**`src/common.ts`**:

- the constants `ENDED`, `RETURNED_UNRECORDED`, `cutOffResult`, `WINDOW`,
  `BUDGET`, `SUMMARY`, `SUMMARIZE`, the types `Window`, `Check`,
  `Summarize`, and `checkWindow`;
- `answering(ctx, stored, work)`: while `work` (a run) goes, each publish
  and its end forget the call records whose results the turn stored
  (`stored(callId, failed)`, the running turn's `stored`). `publish` and
  `toolCallStarted` use it when it is set, and the log's `transcribing`
  otherwise, until step 9;
- `chatHandler` starts a turn with `settles: true` when its agent is on the
  store (its `messages` view has `items`);
- the agent's settings (the `AGENT` link): `background`, `clear`, and now
  `items`, `window`, `budget`, `summarize`;
- the status type `Turn` is renamed `Answering` (D10), in `client.ts`,
  `object.ts`, `signals.ts` and the exports.

**`src/signals.ts`**, as the Python SDK's: `Started` (`Answering` and
`settles?`); `start` closes an earlier turn as gone; `closed(ctx, turn,
gone)` sends the agent `settle(turn)` (a generic send to `<agent>/<key>`,
the companion's key split at its first `:`) when the turn was gone and its
`start` said `settles`; a new private handler `ended(turn)`, which is
`closed(ctx, turn, true)`; `awaitTurn` sends `ended`, not `close`, when the
invocation failed; `status` shows `invocationId` and `since` only.

**`src/object.ts`**:

- a `messages` view on the store is the framework's, made with its `Items`
  (a function of this step, `conversationView(items)` say), and carries them,
  so that `sessionObject` finds them, as it finds `alsoClearing`'s clear;
- the private handlers `settle(invocationId)` (close the turn, then publish)
  and `compact()` (from the agent's settings), for an agent on the store;
  `settle` and `compact` become reserved names;
- `window` and `budget` options on the object, checked (`window` a whole
  number or `'all'`, `budget` a whole number);
- `erase`, for an agent on the store: ensure the schema, read `nextStart`,
  then `reset` and `restart` in one transaction (the log's `restart` too,
  until step 9);
- `sync` passes `view` to `messages`.

**Test support**: `test/fakes/items.ts`, the made-up framework of the Python
tests (`{ role, text }` messages, a reply's `calls`, `{ result, output }`
results); `test/support.ts`'s companion fake learns `start` with `settles`,
`ended`, and records the `settle` it would send.

**Tests**:

- `test/conversation.test.ts`: the 25 tests of
  [`agents_conversation.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/tests/agents_conversation.py)
  ([the list](#the-tests-that-define-it));
- `test/messages.test.ts`: the 6 of `agents_messages.py`;
- `test/signals.test.ts`: `ended` closes a failed turn, and sends `settle`
  only to a turn that said it settles; the next `start` closing a dead turn
  sends it too; `status` does not show `settles`;
- the call records' tests that need a turn (from `agents_snapshots.py` and
  `agents_tools.py`: a stopped turn reports a call that returned as done, not
  cancelled; an approval's return is not the call's; a returned call is kept
  until its result is stored, and forgotten once it is);
- a crash sweep over `answerOnce` on the made-up framework with the bank's
  transfer: crashed at every state request and retried, each prompt is
  answered once, moves money once, the model is not asked again for a stored
  reply (count the model's calls), and `messages` is the clean run's.

**Done when** those pass, every framework's tests still do (none has moved),
and `pnpm lint` is clean.

### Step 4: Claude

[`src/claude/`](../src/claude) onto the turn projection, as
[The frameworks](frameworks.md#target-the-turn-projection) designs it: its
`Items`, a run from `conversation.history()`, each reply appended before its
tools run, a stored final reply answered without asking the model, open
calls run again with their ids; the SDK's `ToolError` answers the model;
`model_context_window_exceeded` is terminal; `pause_turn` goes on;
`summarize` with the agent's own model; `claude.messages()` on the store;
`output` with `check` (D9). `src/claude/conversation.ts`, `transcribe` and
the pending loop go.

**Tests**: `test/claude.test.ts` and `test/output.test.ts` on the store:
invert the finished dead turn (`:344-352`) into one closed, with its calls'
outcomes, by the next message and by `settle`; a stored final reply is not
asked again (count the requests); earlier turns reach the model as prompt and
answer only; a long conversation is summarized, not refused; a `ToolError`
reaches the model; the fake's tool ids unique in the conversation;
`crashedAnywhere` as today. The e2e crash test's `ClaudeAgent` passes.

**Done when** those pass, and `pnpm --filter e2e crash` does.

### Step 5: LangGraph's built-in agent

[`src/langgraph/index.ts`](../src/langgraph/index.ts) onto the turn
projection, without a checkpointer, as
[The frameworks](frameworks.md#target-the-built-in-agent-on-the-turn-projection)
designs it: its `Items`, the graph's nodes appending as they go, a stored
final reply answered at once, a recursion limit of about 10 000 with
`GraphRecursionError` terminal, `summarize`, `langgraph.messages()` on the
store, `output` with `check`. The `prompt` and `answers` channels, the
`answer` node, `close()`, the `for (;;)` loop and `transcribe` go.
`SqlCheckpointSaver` stays, for graphs of your own.

**Tests**: invert `:187-195`; a stored final reply is not asked again
(count the model's calls: the TypeScript twin of the Python SDK's
`langgraph-reask-stored-reply`); a terminal error closes the turn and the
next message is answered; the recursion limit is terminal;
`crashedAnywhere` as today. The e2e crash test's `GraphAgent` passes.

**Done when** those pass, and `pnpm --filter e2e crash` does.

### Step 6: DeepSeek

[`src/deepseek/`](../src/deepseek) onto framework-owned history, as
[The frameworks](frameworks.md#target-framework-owned-history) designs it:
the harness keeps its log; `answerOnce` stores the prompt and the answer; each
flush copies the running turn's new messages into it, in the flush's
transaction; `CONTINUE` only for this invocation's own prompt, a step of its
turn, not copied; a dead turn closed in the store (`settle`, or the next
message), never continued, and its note given to the harness's next turn;
the CANCELLED and UNANSWERED notes given to it too; `dsh-compaction-basic`
mounted (not done: it is not a dependency yet, so the harness's input still
grows with the conversation); a context overflow terminal.

**Tests**: invert `:228-236`; the copy across crashes (`crashedAnywhere`):
each message once in `messages`; `CONTINUE` not in the views; a dead turn
closed with its calls' outcomes, and the next model sees its note; the e2e
crash test's `DeepSeekAgent`.

**Done when** those pass, and `pnpm --filter e2e crash` does.

### Step 7: pi

First a spike, on the three questions of
[The frameworks](frameworks.md#target-framework-owned-history-pi-durable-kept)
(aborting a dead run before pi resumes it; a closing note in pi's context; a
pi run's end as the turn's end), reported in the PR. Then pi onto
framework-owned history: pi-durable keeps its store (D5); each pi commit
copies the running turn's new messages into it, in the commit's
transaction; a dead run aborted, never finished; the notes in pi's context;
a provider's outage fails the attempt, not the turn; `pi.messages()` on the
store; `withPi` and lesson 16 still work.

**Tests**: `test/pi.test.ts`, `test/pi-bank.test.ts`, `test/harness.test.ts`
on the store: a dead turn closed, not finished; the next model sees a stop's
and a refusal's notes; the copy across crashes; the e2e crash test's
`Agent`.

**Done when** the spike's findings are in the PR, those tests pass, and
`pnpm --filter e2e crash` does.

### Step 8: OpenCode

First a spike (D6): can a dead turn be closed without OpenCode resuming it,
through its public API? Report it in the PR. If it can, OpenCode moves onto
framework-owned history as
[The frameworks](frameworks.md#target-framework-owned-history-after-a-spike)
designs it (the copy keyed by OpenCode's message ids, at each publish), with
the same tests as step 6 and the e2e crash test's `OpenCodeAgent`. If it
cannot, OpenCode leaves the package, with everything that uses it (listed
there), and the README says why.

**Done when** the spike's findings and the decision are in the PR, and
either OpenCode's tests pass on the store, or nothing in the repository uses
it; `pnpm --filter e2e crash` passes either way.

### Step 9: the old way goes

- `src/log.ts`, `Transcript`, `transcribing`, `Read`, `READING`, `WRITING`,
  `messagesHandler` and the log's `restart` in `erase` go; `publish` settles
  the call records through `answering` only.
- `output`'s second prompt goes: every framework asks again with `check`.
- `test/transcript.test.ts` goes (its cases are `test/messages.test.ts`'s).
- The exports: `Answering` and the view's request (`view`); an
  `@restatedev/agents/internal` subpath for integrations of your own
  (`answerOnce`, `Conversation`, `Turn`, `Items`, `waitFor`,
  `stopSignalOf`, `refusalOf`, `fromTool`) if the README's
  [Build your own](../README.md#build-your-own) wants it.

### Step 10: the docs, the examples, the template

- These pages describe the code: the status lines go, and each page is
  checked against the code. `TURN-SEMANTICS.md` goes;
  the README links here.
- The README: the `messages` section (ids are positions; `view`; "a
  compacted or reset conversation keeps…" changes), the tables named in
  [Your own session object](../README.md#your-own-session-object), `window`
  and `budget`, one framework per object (D7).
- Each framework's README; `coverage.md` (what the tests cover now).
- `packages/template/src/16_pi_durable.ts` and the examples, if their
  behaviour changed; and a note for `restatedev/modal-template`, whose
  TypeScript project pins 0.3.0 (its lesson 16 uses `withPi`'s `compact` and
  `reset`), for when it moves to the next release.

## What must hold afterwards

The guarantees of [Turn semantics](turns.md#guarantees-and-limits), each with
a test:

- [x] Every row belongs to one turn; only the latest turn, while it has no
      answer, is written, by its own run; closing a dead turn writes only its
      closing record. (`conversation.test.ts`: "is written only while it is being answered", "has open calls of its own")
- [x] At most one turn has no answer, and a new turn is refused while
      another has none. (`conversation.test.ts`: "is written only while it is being answered" (never overlap))
- [x] A turn ends once, with a status, and always with an assistant message
      (its last reply, the note that closed it, or its answer stored as its
      reply), whose position is `answered_at`. (`conversation.test.ts`: "answered with nothing to say", "that ends with a tool after a message"; `messages.test.ts`: the summary's ids)
- [x] A retried attempt of an answered turn reads only its answer, by the
      prompt's id; a retried attempt of an unfinished turn carries on from
      its stored steps, without asking the model again for a stored reply. (`conversation.test.ts`: "answers a prompt once", "asks again within itself, once across attempts"; each framework's "answers a stored final reply without asking the model again")
- [x] A turn on the turn projection reads a bounded part of the
      conversation: the transcript the budget holds, and the window. (`conversation.test.ts`: "loads the transcript, and only the latest turns whole", "reads only the turns its budget holds")
- [x] The window holds every turn its framework didn't answer (the one being
      answered, and any that another invocation ended), then the latest
      `window` answered turns. (`conversation.test.ts`: "keeps a turn another invocation ended in the window")
- [x] A dead turn is closed, never finished, by `settle` or the next
      message, with a result for each open call: the call's error, "done,
      but not recorded" if its Restate call returned, or the note; in every
      framework, the framework's own store included. (`conversation.test.ts`: "a turn left without an answer"; each framework's "closes a turn its gone invocation left"; `turns.test.ts`: settle)
- [x] Message ids are positions; `seq` only grows, and a client reading from
      a cursor gets each new or changed message once; `clear` keeps where
      ids and cursors got to. (`messages.test.ts`: cursors, drops, "goes on from its ids and cursors once cleared"; `turns.test.ts`: erase)
- [x] Each Restate call of a tool is made once per tool call; a framework's
      wait is its tool call's alone; an approval is never the call's outcome. (`calls.test.ts`; `turns.test.ts`: "a closed turn's calls")
- [x] Every framework's next model sees how a closed turn ended. (Claude, LangGraph: the closed turn in the window; DeepSeek, pi: the note (their tests))
- [x] The e2e crash test passes for every framework the package keeps. (`pnpm --filter e2e crash`, for pi, LangGraph, Claude and DeepSeek)

## The tests that define it

Port these as the specification. Each was checked, in the Python SDK, to fail
without the code it tests; check the same here. The names are the Python
SDK's (its `tests/`, at `434bb6f`).

**`agents_conversation.py`** → `test/conversation.test.ts`:

- `test_a_prompt_is_answered_once_and_a_retry_returns_the_stored_answer`
- `test_tool_calls_run_at_once_append_each_result_as_it_comes`
- `test_a_failed_run_is_closed_with_its_error_and_the_next_prompt_starts_afresh`
- `test_a_stopped_run_stores_nothing_more`
- `test_a_dropped_reply_takes_what_followed_it_and_each_item_is_read_once`
- `test_a_tools_error_of_a_built_in_type_is_marked_and_is_no_refusal`
- `test_a_reply_and_what_follows_a_prompt_are_read_by_position`
- `test_unanswered_calls_follow_appends_and_drops`
- `test_a_sealed_conversation_stores_nothing_more`
- `test_only_the_turn_being_answered_is_written_and_it_is_answered_once`
- `test_a_call_id_used_twice_is_logged_once`
- `test_calls_that_share_an_id_are_each_unanswered_until_a_result_has_it`
- `test_a_turn_loads_the_transcript_and_only_the_latest_turns_whole`
- `test_the_model_sees_the_latest_earlier_turns_that_the_budget_holds`
- `test_a_summary_stands_for_the_turns_before_the_transcript`
- `test_a_turn_left_without_an_answer_is_ended_by_the_next_and_carries_on_its_agent`
- `test_a_turn_without_a_summary_reads_only_the_turns_its_budget_holds`
- `test_a_turn_left_without_an_answer_gets_the_outcomes_of_its_calls`
- `test_settle_closes_only_the_turn_its_gone_invocation_left_and_only_once`
- `test_a_window_of_all_loads_every_turn_whole`
- `test_a_turn_another_invocation_ended_stays_in_the_window_as_an_unanswered_one_does`
- `test_a_turns_open_calls_are_its_own_and_not_an_earlier_turns`
- `test_a_turn_answered_with_nothing_to_say_is_answered_once`
- `test_a_turn_asks_again_within_itself_once_across_attempts`
- `test_a_turn_that_ends_with_a_tool_after_a_message_ends_with_its_answer`

**`agents_messages.py`** → `test/messages.test.ts`:

- `test_the_conversation_is_read_in_pages_and_from_a_cursor`
- `test_a_page_reads_back_only_as_many_prompts_as_it_shows`
- `test_an_error_output_is_marked_and_is_a_calls_result_only_if_it_is_its_own_error`
- `test_a_dropped_reply_is_replaced_under_its_ids_and_a_cursor_sees_the_replacement`
- `test_a_cleared_conversation_goes_on_from_its_ids_and_cursors`
- `test_the_summary_is_each_turns_message_and_answer_under_their_ids`

**`agents_signals.py`** → `test/signals.test.ts`:

- `test_a_turn_is_answered_until_it_closes_and_a_failed_one_is_closed_for_it`
- `test_a_turn_whose_invocation_is_gone_is_settled_by_its_agent_if_the_agent_settles`

**`agents_tools.py`** and **`agents_snapshots.py`** (its call-record tests;
not its snapshot ones) → `test/calls.test.ts` or `test/tools.test.ts`:

- `test_a_stopped_turn_reports_a_call_that_returned_as_done_not_cancelled`
- `test_a_returned_call_is_kept_until_its_result_is_stored_and_forgotten_once_it_is`
- `test_a_framework_waits_for_a_signal_for_its_own_tool_call_once`
- `test_waits_opened_at_once_each_keep_their_record`
- `test_a_stopped_turn_does_not_report_a_call_done_because_its_approval_returned`
- `test_a_stopped_turn_reports_a_call_done_once_the_result_it_waited_for_returned`
- `test_an_approval_and_the_restate_call_of_its_tool_call_keep_records_of_their_own`
- `test_a_wait_with_nothing_to_show_shows_no_input`
- `test_each_turns_row_has_the_time_it_was_asked`

**Per framework**, as each moves (the Python SDK's
`tests/agents_<framework>*.py` have the same cases): the answer and the full
view after it; a crash in a tool (the same call id, the model not asked
again); a stored answer not asked for again; refused (424, and the next
message is answered); stopped (409, and the next message starts afresh, with
the note in its model's context); `output`; several prompts in one handler; a
dead turn closed, never finished.

**Past bugs.** The Python SDK's
[`scripts/resurrect.py`](https://github.com/restatedev/sdk-python/blob/434bb6fe05ab17f3384709b48f060a47e68f5fb7/scripts/resurrect.py)
brings each past bug back, one at a time, to see which tests notice. Those
that apply here, each of which should have a test that fails for it:

| Bug brought back                | What it does                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `call-matched-by-id-alone`      | an approved tool's own Restate call shares its approval's record                                                      |
| `wait-rejoins-another-call`     | a framework's new call with the same input joins an earlier call's wait, and gets its approval or denial              |
| `approval-is-the-calls-outcome` | a turn stopped after a denial reports the denied call as done                                                         |
| `calls-new-id-not-matched`      | a call asked again under a new id makes its Restate call again                                                        |
| `calls-settled-early`           | a returned call is forgotten before its result is stored; after a crash, asked again under a new id, it is made again |
| `calls-never-settled`           | a call's record is never forgotten: the key's state grows with every call                                             |
| `langgraph-prune-or-chain`      | the prune matches the kept versions with an `OR` of each: a large graph fails every step                              |
| `langgraph-values-or-chain`     | a checkpoint of more than about 95 channels can't be read                                                             |
| `langgraph-reask-stored-reply`  | after a crash, the model is asked again for a stored final reply                                                      |

And this port's own, from the rules above: a dead turn finished rather than
closed; `settle` that closes a turn its invocation did not leave; a window
that leaves out an ended turn; a retry of an answered turn that loads the
conversation; a cancelled turn not sealed; a closed turn without its calls'
outcomes; a summary view whose ids are not the full view's; a framework copy
that is not idempotent across a crash.

## Review

The PR's author asks for a review after each step, or a few. The review:

1. reads the step's diff against these pages, and the Python SDK's code where
   the step ports it;
2. runs `pnpm lint`, the tests of each package the step touches, and, from
   step 4 on, `pnpm --filter e2e crash`;
3. reverts the step's key lines (the match by tool, the window rule, the
   answer read by id, the `settle` gate, the closing outcomes, the stored
   final reply, a framework's copy) and checks that the step's tests fail;
4. checks the schema's steps against the Python SDK's, and the views' wire
   format against today's (plus `view`);
5. checks that each box of [What must hold afterwards](#what-must-hold-afterwards)
   has its test.

## Out of scope

Not in this PR, on purpose: snapshots (D3); steps retention (the Python
SDK's `steps-retention.md`); a LangGraph graph of your own on framework-owned
history (`agent({ graph })`) and `interrupt()` as signals; durable approvals
for the frameworks that have them (DeepSeek's `approval/request`, OpenCode's
permission hook); steering; a port of `scripts/resurrect.py`; changes to
`@restatedev/sessions`, unless a step needs one (then in a commit of its
own).

## Status

- [x] Step 0: these pages
- [x] Step 1: the call records
- [x] Step 2: LangGraph's checkpointer
- [x] Step 3: the store, on a made-up framework
- [x] Step 4: Claude
- [x] Step 5: LangGraph's built-in agent
- [x] Step 6: DeepSeek
- [x] Step 7: pi (spike, then port)
- [x] Step 8: OpenCode (spike, then port or remove)
- [x] Step 9: the old way goes
- [x] Step 10: the docs, the examples, the template
- [x] Fixes after the review of the steps, each with a test that fails
      without it: each reply its own message in the views; a stopped run
      stores nothing after its turn's close, which is one transaction; a
      424 closes its turn refused, and a retry of a closed turn fails as it
      ended; call records kept per prompt; one framework per agent (D7)
      enforced; Claude goes on from a paused reply; DeepSeek answers an ask
      again; pi aborts a dead run as `withPi` opens (and only another
      prompt's input), fails with a cancellation its work ended, and never
      takes a tool's error for a refusal; an empty reply is sent back as
      `(no answer)`; the fakes' tool ids are unique; `sync` reads its page
      after its revision.
