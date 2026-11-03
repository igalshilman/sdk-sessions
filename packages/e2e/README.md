# End-to-end tests

The tests against a real Restate server: the release that
`@restatedev/restate-server` installs ([`restate-server.ts`](restate-server.ts)),
or the binary `RESTATE_SERVER` names. Each package's own tests, which need no
server, are in its `test/` directory (`pnpm test` at the root runs them all).

- [`crash.ts`](crash.ts): the agents of
  [`@restatedev/agents`'s tests](../agents/test) and the sessions of
  [`@restatedev/sessions`'s](../sessions/test) (the ledger and the shop), through
  crashes: the services abort at random, and the server is killed twice
  (`pnpm --filter e2e crash`). The agents' models are the scripted ones of
  [`@restatedev/agents/test/fakes`](../agents/test/fakes/fakes.ts).
  [`serve.ts`](serve.ts) serves them all, or some (`node serve.ts ledger shop`).
- [`versions.ts`](versions.ts): a session object across deployments: an
  invocation queued behind another runs on the deployment registered by the
  time it starts, a schema step runs once per key, and a rollback and a roll
  forward keep the database working (`pnpm --filter e2e versions`).
- [`concurrency.ts`](concurrency.ts): the context without journal replay
  (`pnpm --filter e2e concurrency`).
- [`restate-tools.ts`](restate-tools.ts): Restate's own agent tools, on a
  scripted model (`pnpm --filter e2e tools`).
- [`bench.ts`](bench.ts): SQL in sessions: latency, throughput and stored
  bytes, for databases up to 100 MB (`pnpm --filter e2e bench [out.json]`).
- [`packaging.ts`](packaging.ts): the packages as a user installs them,
  without a Restate server: packed, linted (publint, Are the Types Wrong?),
  and installed with npm into a project with pi alone, whose agent runs and
  type-checks (`pnpm --filter e2e packaging`).
