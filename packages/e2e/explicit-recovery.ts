// A session object served on the explicit recovery VM, against a real Restate
// server: that the attempt runs there at all, that a commit's acked write is
// acked (the whole sync design rests on it), that nothing is journaled as a
// run, and that a handler working longer than the inactivity timeout finishes
// in one attempt rather than restarting forever.
//
//   pnpm --filter e2e explicit-recovery
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as restate from '@restatedev/sessions';
import { RESTATE_SERVER as SERVER } from './restate-server.ts';

const ADMIN = 'http://127.0.0.1:9070';
const INGRESS = 'http://127.0.0.1:8080';
const PORT = 9132;
/** Short, so that the heartbeat has something to beat inside a test's patience. */
const INACTIVITY = 3000;
/** Well inside it, as the default 20s is inside Restate's default minute. */
process.env.RESTATE_SESSIONS_HEARTBEAT = '750';

/** A plain journaled object, called by the session object: the SDK serves it. */
const callee = restate.object({
  name: 'Callee',
  handlers: {
    echo: async (_ctx: restate.ObjectContext, what: string) => what,
  },
});

const probe = restate.sessionObject({
  name: 'Recovery',
  schema: ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)'],
  handlers: {
    /** Writes, commits, and counts: the commit's sync must be acked for this to answer. */
    add: async (ctx: restate.SessionContext, body: string) => {
      await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', [body]);
      const row = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notes');
      return row!.n;
    },
    /**
     * Two calls awaited at once. This is what the selector existed to allow:
     * the SDK's own loop lets one promise wait on Restate at a time, so two
     * of these would fail the attempt with `awaitNext already pending`.
     * (Two `ctx.db` reads would not do: the database runs its calls one at a
     * time, so they never wait on Restate together.)
     */
    both: async (ctx: restate.SessionContext) => {
      const [a, b] = await Promise.all([
        ctx.rpc({ service: 'Callee', key: 'x', handler: 'echo', input: 'a' }),
        ctx.rpc({ service: 'Callee', key: 'y', handler: 'echo', input: 'b' }),
      ]);
      return `${String(a)}${String(b)}`;
    },
    /**
     * Works outside Restate for longer than the inactivity timeout, then
     * writes a row. Each attempt runs from the start, so the number of rows
     * is the number of attempts: one row means the heartbeat kept it alive.
     */
    slow: async (ctx: restate.SessionContext, ms: number) => {
      await sleep(ms);
      await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', ['slow']);
      const row = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notes');
      return row!.n;
    },
  },
});

const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
const log = join(dir, 'server.log');
const server = spawn(SERVER, ['--base-dir', join(dir, 'server')], {
  env: {
    ...process.env,
    RESTATE_BIND_IP: '127.0.0.1',
    RESTATE_LISTEN_MODE: 'tcp',
    RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT: `${INACTIVITY}ms`,
    RESTATE_WORKER__INVOKER__ABORT_TIMEOUT: `${INACTIVITY * 10}ms`,
  },
  stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')],
});
process.on('exit', () => server.kill('SIGKILL'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(1));

async function query<T>(sql: string): Promise<T[]> {
  const r = await fetch(`${ADMIN}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`query: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { rows: T[] }).rows;
}

const failures: string[] = [];
function check(what: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(what);
}

for (const deadline = Date.now() + 60_000; ; await sleep(200)) {
  if (
    await fetch(`${ADMIN}/health`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  if (Date.now() > deadline) throw new Error('restate-server did not start');
}

// This is the point: `sessions.serve` routes the session object's invocations
// to the explicit recovery VM, and the SDK keeps everything else.
process.env.PORT = String(PORT);
await restate.serve(probe, callee);

for (const deadline = Date.now() + 60_000; ; await sleep(200)) {
  const ok = await fetch(`${ADMIN}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: `http://127.0.0.1:${PORT}`, force: true }),
  }).then(
    (r) => r.ok,
    () => false,
  );
  if (ok) break;
  if (Date.now() > deadline) throw new Error('registration failed');
}

const call = async (path: string, body: unknown) => {
  const r = await fetch(`${INGRESS}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

// 1. The attempt runs on the VM, and its commit is durable: the acked write
//    that is a sync must come back, or `add` never answers.
const added = await call('Recovery/k1/add', 'first');
check(
  'a handler runs on the VM and its commit is acked (CommandAck on the negotiated protocol)',
  added.text === '1',
  added.text,
);

// 2. Nothing is journaled as a run, and a commit's head write carries its sync.
const id = (
  await query<{ id: string }>(
    `SELECT id FROM sys_invocation WHERE target_service_name = 'Recovery' AND target_handler_name = 'add' LIMIT 1`,
  )
)[0]?.id;
const journal =
  id === undefined
    ? []
    : await query<{ entry_type: string; name: string }>(
        `SELECT entry_type, name FROM sys_journal WHERE id = '${id}' ORDER BY index`,
      );
console.log('   journal:', journal.map((e) => `${e.entry_type}${e.name ? `(${e.name})` : ''}`).join(' '));
check('no entry is a run: no `sync` run, and no `work` run', !journal.some((e) => /run/i.test(e.entry_type)));
check(
  'the commit wrote the head with its own sync, and no `v22/sync` clear',
  journal.some((e) => e.name === 'v22/head') && !journal.some((e) => e.name === 'v22/sync'),
);

// 3. Two reads of Restate awaited at once, which the selector existed to allow.
const both = await call('Recovery/k1/both', null);
check('two calls awaited at once both answer', both.text === '"ab"', both.text);

// 4. Work longer than the inactivity timeout finishes in one attempt: the
//    heartbeat says the handler makes progress, as the working run did.
//
//    Each attempt runs the handler from the start and writes one row, so the
//    count it answers *is* the number of attempts it took. Reading Restate's
//    own retry count would pass vacuously when the row is already gone.
const slow = await call('Recovery/k2/slow', INACTIVITY * 2.5);
check(
  'work past the inactivity timeout answers in one attempt: the heartbeat kept it alive',
  slow.text === '1',
  `rows=${slow.text}, so that many attempts`,
);

console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} FAILED: ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
