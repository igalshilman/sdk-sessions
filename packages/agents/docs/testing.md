# Testing: past bugs, brought back

How the agents are tested, and how well: each bug the history fixed, brought
back on today's code, to see which tests notice. It follows the Python SDK's
[`testing.md`](https://github.com/restatedev/sdk-python/blob/9ec3c6076db8a6b96cd84c74d481aa1644c88c97/docs/agents/testing.md)
and its `scripts/resurrect.py`, whose mutants of the conversation's core
apply here too.

## Running the tests

- **The package's tests:** `pnpm test` in `packages/agents` (`vitest run`),
  without a Restate server. A handler runs as an attempt over its object's
  state in memory, through crashes ([`test/support.ts`](../test/support.ts)),
  on a scripted model for each framework ([`test/fakes/`](../test/fakes)).
  The core is tested with a made-up framework
  ([`test/fakes/items.ts`](../test/fakes/items.ts)), as the Python SDK's is.
- **Against a Restate server:** the scripts of [`packages/e2e`](../../e2e),
  such as `pnpm --filter e2e tools` (Restate's own tools, `sync`, `clear`)
  and `pnpm --filter e2e crash` (every framework through crashes).
- **The mutants:** `node scripts/resurrect.ts` in `packages/agents`. It edits
  the code, and restores it after each mutant (and on Ctrl-C), so run it in a
  worktree of its own; the one mutant that needs a server starts one
  (`--unit` leaves it out).

## The mutants

[`scripts/resurrect.ts`](../scripts/resurrect.ts) holds one mutant per bug:
a text of today's code, found exactly once in its file, and what it becomes
to bring the bug back, with the tests that must fail. The bugs are:

- **the fixes of #10 after review** and **the follow-ups of #11**, each a
  commit of its own on `claude/sdk-sessions-conversation-store-son85g`
  (the PRs were squashed: `84cefaf` and `1371e59` list them);
- **the fixes of v0.3.0's bugs that steps 1 and 2 of [the plan](plan.md)
  port** from the Python SDK (the call records; LangGraph's checkpointer);
- **the fixes since**: `lastOf` from the ends of the tables (`2bd66aa`,
  [Access patterns](access-patterns.md));
- **durability mutants**, of no fix: the Python SDK's that apply here
  (a call made again after a crash, a call record kept or forgotten at the
  wrong time, a stored reply asked for again).

For each, the runner applies the edit, runs the test files that use the code
it changes (or a script of `packages/e2e`), restores the code, and says what
failed:

- **killed:** the tests that guard it failed, those its fix added; "and N
  more" when other tests failed too, so the suite would have seen the bug
  without them;
- **not by its own:** other tests failed, but not those the mutant names;
- **SURVIVED:** no test failed. The bug can come back unnoticed.

The tests that fail without any edit (the baseline) are left out. A mutant
whose text no longer matches the code (found 0 times, or more than once)
fails the run before it edits anything: update it with the code. So does a
survivor, or a mutant killed by other tests than its own. `--check` only
checks the texts; `--list` lists the mutants; names run some:

```sh
node scripts/resurrect.ts lastof-scans pi-outage-ends-turn
```

Every future fix should add a mutant.

## The run of 9 November 2026

On `65c5b26`, with Node 22.23 and, for the one e2e mutant, Restate 1.8.0:
the baseline (every test file, 1,054 tests) passes in 21 s, and the 59
mutants take about 14 minutes, 2 to 30 s each. "And N more" counts the tests that
failed beside the mutant's own.

| Mutant                             | Fix        | Bug brought back                                                                                        | Verdict             |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- | ------------------- |
| `call-matched-by-id-alone`         | 3b4af36    | an approval and its tool call's own Restate call share one record                                       | killed, and 1 more  |
| `wait-rejoins-another-call`        | 3b4af36    | a framework's new call with an earlier attempt's input joins its wait, and gets its answer unasked      | killed              |
| `approval-is-the-calls-outcome`    | 3b4af36    | an approval that returned is reported as its tool call done, a denied one too                           | killed, and 2 more  |
| `input-keys-in-order`              | 3b4af36    | the same input with its keys in another order is another call                                           | killed              |
| `langgraph-values-or-chain`        | 57cf2d9    | a checkpoint's values are read with an `OR` of each channel: a graph of about 95 channels can't be read | killed              |
| `langgraph-prune-or-chain`         | 57cf2d9    | `history: 'latest'` prunes with an `OR` of each kept version                                            | killed              |
| `langgraph-delta-history-dropped`  | 57cf2d9    | `history: 'latest'` keeps only the latest checkpoint: a delta channel loses its messages                | killed, and 1 more  |
| `claude-tool-calls-say-nothing`    | e10c084    | a reply of tool calls only is no message of its own (and one per framework, four in all)                | killed              |
| `close-unfenced`                   | ebfd4f9    | a stopped turn's run stores a tool's result after the close's note                                      | killed              |
| `close-before-writes-under-way`    | ebfd4f9    | a stop while a reply is stored closes the turn without results for the reply's calls                    | killed              |
| `close-in-two-commits`             | ebfd4f9    | a crash between a close's note and its answer closes the turn again, with a second note                 | killed              |
| `copy-into-closing-turn`           | ebfd4f9    | a framework's copy into a turn being closed takes the close's positions                                 | killed              |
| `framework-refusal-closed-failed`  | b517f54    | a framework's own 424 closes its turn failed, and a retry answers it                                    | killed              |
| `retry-answers-closed-turn`        | b517f54    | a retry of a turn closed failed, cancelled or ended answers its note as a success                       | killed, and 6 more  |
| `calls-of-another-prompt`          | 457f5a8    | an invocation's second prompt rejoins its first's call, and never makes its own                         | killed              |
| `outcomes-of-another-prompt`       | 457f5a8    | a closing turn reports another prompt's call, with the same id, as its own                              | killed              |
| `another-frameworks-items`         | d7331b4    | an agent answers with another framework's items than its view's                                         | killed              |
| `claude-paused-reply-ends-turn`    | 2e79f25    | a paused reply (`pause_turn`) ends the turn with its partial text                                       | killed              |
| `deepseek-asks-the-prompt-again`   | abff4c4    | a DeepSeek turn that asks again answers with the first reply                                            | killed              |
| `pi-dead-run-resumed`              | 994a23c    | a `withPi` handler that is no prompt resumes a gone invocation's run                                    | killed              |
| `pi-aborts-its-own-run`            | 994a23c    | a prompt aborts its own retried run beside a write of pi's                                              | killed              |
| `pi-cancelled-work-succeeds`       | 2234efe    | a cancelled `withPi` whose work is no prompt succeeds                                                   | killed              |
| `pi-tool-error-refusal`            | 8d28383    | a pi tool that fails as a provider does ends the turn refused                                           | killed              |
| `claude-empty-reply-sent`          | d5d2191    | an empty reply is sent back as it came, which the API refuses (and LangGraph's)                         | killed              |
| `sync-page-before-revision`        | 7542b07    | `sync` reads its page as of before its wait, and misses the change                                      | killed by e2e       |
| `limit-zero-reads-all`             | 9643d05    | `messages({ limit: 0 })` gives the latest messages, not none                                            | killed              |
| `summarize-without-turns`          | 48ce18e    | `summarize` without the conversation of turns sends `compact` to no handler                             | killed              |
| `positions-taken-before-commit`    | c73249c    | a turn's write takes its position before it waits for the database                                      | killed              |
| `answer-seq-taken-before-commit`   | c73249c    | a turn's answer takes its seq before it waits for the database                                          | killed              |
| `pi-outage-ends-turn`              | ecd0d00    | pi gives up on a provider's outage after 3 retries, and ends the turn                                   | killed, and 1 more  |
| `deepseek-no-compaction`           | 535ee64    | DeepSeek's input grows until a request overflows the model's window                                     | killed              |
| `pi-tool-end-before-stored`        | 08a9bd6    | a tool call's end is published before its result is stored (and DeepSeek's)                             | killed              |
| `pi-prompt-id-retried`             | de77173    | pi's `prompt(text, id)`, as 0.3.0 took it, fails with a TypeError, retried forever                      | killed              |
| `reminder-stored`                  | 3573fda    | `output`'s reminder is stored with the prompt, and `messages` shows it                                  | killed              |
| `wrong-again-stored-answered`      | db2ea3d    | a reply still wrong after asking again fails the prompt, but its turn is stored answered                | killed              |
| `page-back-reads-to-the-end`       | d71b790    | a page back reads every turn to the end of the conversation                                             | killed              |
| `pi-reads-whole-history`           | 2b2adf5    | pi's prompts read the window's and the budget's turns (and DeepSeek's)                                  | killed              |
| `langgraph-latest-reads-back`      | 67a8122    | `history: 'latest'` reads back the checkpoints a delta channel needs at every step                      | killed              |
| `lastof-scans`                     | 2bd66aa    | `lastOf` scans both tables at every turn                                                                | killed              |
| `unreadable-row-retried`           | 9d49193    | a row the framework cannot load (another framework's) fails with its error, retried forever             | killed, and 12 more |
| `claude-loads-any-row`             | 9d49193    | Claude's load takes another framework's row (DeepSeek's) for a message of its own                       | killed              |
| `pi-loads-any-row`                 | 9d49193    | pi's load takes another framework's row, which fails later, retried forever                             | killed, and 1 more  |
| `deepseek-loads-any-row`           | 9d49193    | DeepSeek's load reads LangGraph's and pi's rows as empty messages                                       | killed, and 1 more  |
| `langgraph-invalid-update-retried` | 8a389b5    | LangGraph's `InvalidUpdateError` is retried, to the same update, forever                                | killed              |
| `graph-run-unnamed`                | 0ef2c47    | a graph's checkpoints do not name their run's prompt: a retried attempt starts the run again            | killed              |
| `graph-interrupts-share-a-wait`    | 0ef2c47    | a node's second `interrupt()` gets its first's answer, without a wait of its own                        | killed              |
| `approval-asked-again-after-crash` | 70cc121    | DeepSeek's call made again after a crash, under a new id, has the person asked twice                    | killed, and 1 more  |
| `approval-is-a-done-call`          | d710936    | DeepSeek's approval is taken for its call's outcome: a stopped turn reports it done                     | killed              |
| `calls-new-id-not-matched`         | durability | a call cut off by a crash and asked again under a new id is made again                                  | killed, and 9 more  |
| `calls-settled-early`              | durability | a returned call is forgotten before its result is stored                                                | killed, and 3 more  |
| `calls-never-settled`              | durability | a call's record is never forgotten: the key's state grows with every call                               | killed, and 3 more  |
| `claude-reask-stored-reply`        | durability | after a crash, the model is asked again for a stored final reply (and LangGraph's)                      | killed              |

A bug that says "(and ...)" is a mutant per framework, each killed by its
own test: `langgraph-`, `deepseek-` and `pi-tool-calls-say-nothing`,
`langgraph-empty-reply-sent`, `deepseek-tool-end-before-stored`,
`deepseek-reads-whole-history` and `langgraph-reask-stored-reply` beside the
rows': 59 mutants in all.

What it says:

- **All 59 are killed, 47 by their own tests only.** As in the Python
  SDK, the suite records the bugs it met: a fix's test fails for its bug,
  and few other tests notice. Those that do are mostly the call records'
  (a turn's close reports its calls' outcomes), the frameworks' dead turns
  (`retry-answers-closed-turn`), and `loadItem`, which every load goes
  through.
- **`answer-seq-taken-before-commit` survived the first run.** `c73249c`
  takes the positions and seqs of a turn's writes inside their
  transactions, so that a framework's copy (pi's, DeepSeek's) committing
  while a write waits for the database takes positions of its own; its
  test made that write an ask again, never the turn's answer. With the
  answer's seq taken before it waits, the copy and the answer share a seq,
  and a follower whose cursor is at the copy's misses the answer. A test of
  the answer beside a copy's transaction (`turns.test.ts`) now kills it.
- **`sync-page-before-revision` is killed by `pnpm --filter e2e tools`
  only.** The unit tests' views read the database as it is, not as it was
  when their invocation started, as Restate's do: no unit test can see it.
