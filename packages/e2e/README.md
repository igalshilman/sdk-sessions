# End-to-end tests

The tests against a real Restate server: the release that
`@restatedev/restate-server` installs ([`restate-server.ts`](restate-server.ts)),
or the binary `RESTATE_SERVER` names. Each package's own tests, which need no
server, are in its `test/` directory (`pnpm test` at the root runs them all).

- [`crash.ts`](crash.ts): the agents of
  [`@restatedev/agents`'s tests](../agents/test) and the sessions of
  [`@restatedev/sessions`'s](../sessions/test) (the ledger, the shop, and the bank
  of one account per key), through crashes: the services abort at random, the
  server is killed twice, transfers are cancelled, some of the OpenCode
  agent's prompts are killed (their turns closed, never finished, their
  money moved at most once), and views are read all
  along (`pnpm --filter e2e crash`). The shop's services run in two processes
  behind one deployment, one with a small page cache, and take turns; the
  bank's, in two more behind another. Every random choice comes from a seed it
  prints (`ABORT_SEED`), and `SOAK_MINUTES=n` makes it a soak that also checks
  memory, where a process aborts at random only once it has run
  `SOAK_MIN_LIFE_MS` (default 2000). A request that gets no answer fails with
  what holds its key: the invocation that started, those queued behind it,
  and what the one that started waits for. The agents'
  models are the scripted ones of
  [`@restatedev/agents/test/fakes`](../agents/test/fakes/fakes.ts).
  [`serve.ts`](serve.ts) serves them all, or some (`node serve.ts ledger shop`).
- [`versions.ts`](versions.ts): a session object across deployments: an
  invocation queued behind another runs on the deployment registered by the
  time it starts, a schema step runs once per key, and a rollback and a roll
  forward keep the database working (`pnpm --filter e2e versions`).
- [`concurrency.ts`](concurrency.ts): the context without journal replay
  (`pnpm --filter e2e concurrency`).
- [`identity.ts`](identity.ts): a deployment that verifies request
  signatures, which every `connect` is. A signed invocation of a session
  object runs and answers, under a deployment prefix too; an unsigned one,
  one signed for another handler and one with an expired token are each
  refused with a 401 before the handler runs
  (`pnpm --filter e2e identity`).
- [`suspensions.ts`](suspensions.ts): what every suite here asks Restate at
  its end: whether it suspended an invocation on its cancel signal alone,
  which only a cancellation resumes. To force suspensions in a suite, give
  the server a short inactivity timeout:
  `RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT=40ms pnpm --filter e2e steering`.
- [`agentlib.ts`](agentlib.ts): agentlib agents, on a journaled virtual
  object with every agent's views, on a scripted model: a signal's wait and
  a message steered to its turn, `messages` by page, cursor and summary,
  `sync`, a denied approval, a stop, a refusal (424), `clear`, the tools of
  `@restatedev/agents` (`call`, `send`, `workflow` on services of the classic
  SDK, a `tool()`, one that `approval` names, one reaching for `ctx.db`), sub-agents both ways (of a pi
  agent and to one, stopped with the turn), and the service process killed
  mid-turn, after which the replayed turn asks the model, and runs a `tool()`,
  no second time (`pnpm --filter e2e agentlib`).
- [`restate-tools.ts`](restate-tools.ts): Restate's own agent tools, on a
  scripted model (`pnpm --filter e2e tools`).
- [`steering.ts`](steering.ts): a message steered to a turn (the `steer`
  view): taken by the turn at its next step, or answered as a turn of its
  own, in order, by an agent whose turns take none, with no turn running,
  and after a stopped turn (`pnpm --filter e2e steering`).
- [`bench.ts`](bench.ts): SQL in sessions: latency, throughput and stored
  bytes, for databases up to 100 MB (`pnpm --filter e2e bench [out.json]`).
- [`packaging.ts`](packaging.ts): the packages as a user installs them,
  without a Restate server: packed, linted (publint, Are the Types Wrong?),
  and installed with npm into a project with pi alone, whose agent runs and
  type-checks (`pnpm --filter e2e packaging`).
