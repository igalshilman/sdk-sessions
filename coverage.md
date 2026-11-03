# Test coverage: where it stands, and the plan

Status of `main` at 7eadb1c, run on 2 November 2026 (Node 24.22.2, Rust 1.97):
every suite passes. Lint 2m; TypeScript tests 1,015 (905 agents, 106 sessions,
4 examples) in 49s; Rust 144 in 1m (the 5 ignored are doc examples); e2e
`concurrency` 8s, `tools` 12s, `crash` 2m47s with the server killed twice and
the agents' process restarted up to 32 times.

## What is covered

| Layer                               | Where                          | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                               | Depth                                                                      |
| ----------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Storage and SQL engine (Rust)       | `native/src/{state,sql}/tests` | Two seeded campaigns: random SQL or state changes under random faults (errors before or after a request, cancellations, crashes keeping any prefix of the writes, an S3 that loses or delays writes), checked after every reopen against a model or a reference engine. Targeted tests for corruption, cancellation, races, readers beside a writer, a stale page cache with other writers, eviction, garbage collection, limits, failpoints | Strong. The campaigns run 12 and 4 seeds by default, and nothing runs more |
| The package (TypeScript, no server) | `packages/sessions/test`       | `ctx.db`, transactions, which errors are terminal and which retried, schema steps, views, other databases per key, `tx.send` through crashes, the promise selector (one randomized test)                                                                                                                                                                                                                                                     | Good                                                                       |
| Against a real server               | `packages/e2e`                 | `crash.ts`: 60 orders over 3 warehouses, a ledger and 4 sessions of each agent, with the services SIGKILLed at random state requests and the server killed twice; the books must balance and every prompt move money once. `concurrency.ts`: concurrent awaits, suspension, cancellation. `tools.ts`, `packaging.ts`                                                                                                                         | Good for 3 minutes and a few dozen keys                                    |
| Agents                              | `packages/agents/test`         | Every framework on scripted models; storage per framework                                                                                                                                                                                                                                                                                                                                                                                    | Good; real models are for examples, by design                              |

## Gaps

Ranked by what a failure would cost users, and by what no other layer catches.

1. **Versions.** No test registers a second deployment with a new schema step
   while invocations of the first are queued or running on the same key.
   The skill promises this works when steps only add tables and columns.
2. **Nothing runs long.** The longest run is 3 minutes, so memory and
   page-cache growth, checkpoints and garbage collection under sustained load,
   and rare crash timings are never exercised against a server.
3. **Few keys, and money moves inside one key.** The ledger is one key. No
   test moves state between keys while processes crash, and nothing runs
   thousands of keys in one process.
4. **The page cache is never evicted or wiped end to end.** The e2e data is a
   few MB against a 256 MiB cache; a wipe only happens together with a crash;
   nothing truncates or deletes the cache file under a live process; and each
   service is served by one process, so two warm caches never alternate on a
   key against a real server. Only the cache's file location is configurable.
5. **Views run only beside idle handlers in e2e.** `crash.ts` reads `status`
   and `report` after the handlers are done. A view polled while a handler
   commits many times, and a view that outlives the owner's checkpoints
   (fails with "is gone", retried) are covered in Rust only.
6. **Crashes are not reproducible.** `faults.ts` aborts on `Math.random()`;
   a CI failure of `crash.ts` cannot be replayed.
7. **Few campaign seeds in CI.** 12 and 4 by default; a nightly run with
   hundreds is cheap.
8. **One server and SDK version** (restate-server 1.8.0, SDK 1.18.1), and the
   selector depends on SDK internals. A breaking upgrade shows only after the
   bump.
9. **One platform.** The suites run on Linux x64; macOS and arm64 get the
   packaging smoke test only.
10. **No performance regression check.** `bench.ts` and the Rust benches exist
    but nothing runs or compares them.

## The plan

Small PRs, in this order. "PR CI" runs on every push; "nightly" is a new
workflow, on a schedule and on demand, with logs uploaded on failure.

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Checks                                                                           | Runs                   | Size   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------- | ------ |
| 1   | **A seed for `crash.ts`.** `ABORT_SEED` (default random, printed at the start) drives `faults.ts` and the client's choices; a failure names the seed to replay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Reproducibility of every later crash run                                         | PR CI                  | Small  |
| 2   | **Nightly campaigns.** `STATE_SEEDS=1000`, `SQL_CAMPAIGN_SEEDS=500`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rare interleavings in the storage engine                                         | Nightly                | Small  |
| 3   | **Two deployments.** In `e2e/versions.ts`: v1 holds key `k` in a long handler (awaiting a slow journaled `Helper`), several more invocations of `k` and of fresh keys are queued, v2 registers with one more schema step (a new table and a new column), then everything drains. Assert: every invocation completed on one deployment, the step ran once per key, v2 reads v1's commits, and a v1 invocation that ran after v2 on the same key (if Restate pins at creation) worked on the wider schema. The test pins down which deployment a queued invocation runs on, which the skill currently states loosely ("the deployment it started on") | Gap 1                                                                            | PR CI                  | Medium |
| 4   | **A bank across keys.** `Account` session object, one key per account; `transfer` moves money by calling the other key with an idempotency key and records the transfer id on both sides, in `crash.ts` beside the ledger. Assert: total money conserved, every transfer applied exactly once on both keys, no transfer applied on one side only                                                                                                                                                                                                                                                                                                    | Gap 3 (calls between keys under crashes; the harder half of "safe to run twice") | PR CI                  | Medium |
| 5   | **Cache settings.** `RESTATE_SQL_CACHE_MEMORY` and `RESTATE_SQL_CACHE_DISK` (bytes; `0` disables the cache) next to `RESTATE_SQL_CACHE_FILE`, documented in the native README. `crash.ts` gets a run with a 1 MiB cache so most reads miss and eviction happens under crashes                                                                                                                                                                                                                                                                                                                                                                       | Gap 4 (eviction end to end)                                                      | PR CI                  | Small  |
| 6   | **A wiped cache under a live process** (Rust). Delete and truncate the cache file, and fail its writes, under an open `PageCache` with sessions running. Reads stay correct (served from the store), the process never serves bad bytes or dies                                                                                                                                                                                                                                                                                                                                                                                                     | Gap 4 (fail safe)                                                                | PR CI                  | Small  |
| 7   | **Two processes per service.** `crash.ts` serves the ledger and the shop from two processes behind one deployment (Restate alternates), so a warm cache meets another writer's commits on a real server                                                                                                                                                                                                                                                                                                                                                                                                                                             | Gap 4 (the Rust `other_writers_never_leave_the_cache_stale` case, end to end)    | PR CI                  | Medium |
| 8   | **Views under load.** In `crash.ts`, a client polls `status` and `report` continuously while orders run; assert every answer is a committed state (monotone order status, books that balance at each read). Plus a view that sleeps across two checkpoints of its key: it fails with "is gone" and Restate retries it to a good answer                                                                                                                                                                                                                                                                                                              | Gap 5                                                                            | PR CI                  | Small  |
| 9   | **Soak mode.** `crash.ts` with `SOAK_MINUTES`, `KEYS` (thousands of orders and accounts), a server kill on a schedule, the tiny cache of #5 and the two processes of #7; RSS of every process logged every minute and asserted below a bound at the end; the same invariants checked at the end                                                                                                                                                                                                                                                                                                                                                     | Gap 2                                                                            | Nightly, 30-60 minutes | Medium |
| 10  | **Version matrix.** The e2e suites against the pinned restate-server and against the latest release (and the SDK's latest), allowed to fail, with a summary in the job                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Gap 8                                                                            | Nightly                | Small  |
| 11  | **Platform matrix.** The TypeScript sessions tests and `e2e/concurrency.ts` on macOS and arm64 Linux                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Gap 9                                                                            | Nightly                | Small  |
| 12  | **Benchmarks on a schedule.** `bench.ts` and `cargo bench` nightly, numbers published as a job artifact; thresholds only once a few weeks of numbers show the noise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Gap 10                                                                           | Nightly                | Small  |

Order of value: #1 and #2 first (an afternoon, and they make the rest
debuggable); #3 and #4 next (correctness users rely on); then #5 to #9 (the
cache and the soak, which build on each other); #10 to #12 when convenient.

## Review of the earlier proposal, and additions

Changes to what was proposed in conversation:

- **The versions test is more specific, and partly a question.** Under
  exclusivity, v2 cannot touch a key while a v1 invocation holds it, so "v1
  code on a v2 schema" happens only if Restate pins a queued invocation to a
  deployment at creation rather than at its first attempt. The test
  establishes which, and the skill's "Versions" row should then say it
  precisely.
- **The cache work is split in three** (#5 settings, #6 wipe, #7 two
  processes) instead of one, so each PR is reviewable, and the soak (#9)
  composes them rather than duplicating them.
- **The bank across keys records the transfer on both sides.** A transfer that
  is applied on one key and not the other is the bug worth finding; the
  invariant must look at both, not at the total alone.

Additions not in the earlier proposal:

- **Views under load and the "is gone" retry on a real server** (#8). The
  README promises the retry; nothing checks it end to end.
- **Cancellation and kill during crashes.** `concurrency.ts` cancels, but never
  while processes crash. #9 should cancel a random share of invocations
  mid-handler and kill some through the admin API, and assert the invariants
  still hold (a cancelled transfer either applied on both sides or neither).
- **A `TerminalError` after a commit, end to end.** The skill states the commit
  stays; a small case in #4 (a transfer that commits, then throws terminally)
  makes it a test.
- **A failing schema step.** I found no test of a step that fails midway on an
  existing key (bad SQL in step 3 of 3): the key must stay usable by the
  previous version, and a fixed step must apply once. A unit test in
  `schema.test.ts`, with #3.
- **A database grown to 100 MB under crashes.** `bench.ts` grows databases to
  100 MB but checks nothing; the soak (#9) should grow a few keys that far so
  checkpoints and compaction run under crashes against a server.
- **Idempotency retention.** A caller that resends after the retention
  (`idempotencyRetention` set to seconds in the test) starts a new invocation;
  the handler's own record of the business id must still make it a no-op.
  Small, in #4.

Not planned, on purpose: real models in tests (scripted models are the rule;
`crash.ts` covers the agents' durability), and tests of Restate itself (the
server's own guarantees are its project's to test; these tests check what the
package builds on them).
