// A session object across deployments, against a real Restate server: v1 and
// v2 of `Notes` share each key's database, v2 adding a column and a step of
// data that fills it. Each version is its own process (a process holds one
// definition of an object), started from this file: `PORT=9191 node versions.ts serve v1`.
//
// Checks:
// - An invocation runs on the deployment it was pinned to, and invocations
//   queued behind it on the key are pinned as they start: after v2 is
//   registered, they run on v2.
// - v2's step runs once per key, as v2 first opens it, and v2 reads what v1
//   committed. A v2 view of a key that only v1 wrote reads it with the step
//   applied, in its own session.
// - Rolled back to v1, its code works on the database v2 widened (the step
//   only added), and rolled forward again, v2's step does not run twice: rows
//   v1 wrote meanwhile keep the column empty.
//
//   pnpm --filter e2e versions   (RESTATE_SERVER=/path/to/restate-server to use another)
import * as restate from '@restatedev/sessions';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { RESTATE_SERVER as SERVER } from './restate-server.ts';

const INGRESS = 'http://127.0.0.1:8080';
const ADMIN = 'http://127.0.0.1:9070';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A note, as a view returns it: `version` is the column v2 adds (null in v1, or where v1 wrote it). */
interface Note {
  id: string;
  text: string;
  version?: number | null;
}

/** The services of `version`: a journaled helper that waits, and `Notes`. */
function services(version: 'v1' | 'v2') {
  const helper = restate.service({
    name: 'Helper',
    handlers: {
      wait: async (ctx: restate.Context, ms: number) => ctx.sleep(ms),
    },
  });
  const v1Steps: restate.Step[] = ['CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL)'];
  const v2Steps: restate.Step[] = [
    ...v1Steps,
    'ALTER TABLE notes ADD COLUMN version INTEGER',
    // Data: the notes so far are v1's.
    (tx) => tx.execute('UPDATE notes SET version = 1'),
  ];
  const add = async (ctx: restate.SessionContext, { id, text }: { id: string; text: string }) => {
    await (version === 'v1'
      ? ctx.db.execute('INSERT OR IGNORE INTO notes (id, text) VALUES (?, ?)', [id, text])
      : ctx.db.execute('INSERT OR IGNORE INTO notes (id, text, version) VALUES (?, ?, 2)', [id, text]));
    return version;
  };
  const notes = restate.sessionObject({
    name: 'Notes',
    schema: version === 'v1' ? v1Steps : v2Steps,
    handlers: {
      add,
      /** Hold the key for `ms` (a call to the helper), then add the note. */
      hold: async (ctx, { id, text, ms }: { id: string; text: string; ms: number }) => {
        await ctx.rpc(helper, { idempotencyKey: `${ctx.request.id}:wait` }).wait(ms);
        return add(ctx, { id, text });
      },
    },
    views: {
      list: async (ctx) => ({
        version,
        notes:
          version === 'v1'
            ? await ctx.db.query<Note>('SELECT id, text FROM notes ORDER BY id')
            : await ctx.db.query<Note>('SELECT id, text, version FROM notes ORDER BY id'),
      }),
    },
  });
  return [helper, notes];
}

/** Until `ok()` holds, or fail with `what` after 60 s. */
const until = async (what: string, ok: () => Promise<boolean>) => {
  for (const deadline = Date.now() + 60_000; !(await ok().catch(() => false)); await sleep(200)) {
    if (Date.now() > deadline) throw new Error(what);
  }
};

const post = async <T>(path: string, body: unknown = null): Promise<T> => {
  const r = await fetch(`${INGRESS}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

/** Start `path` without waiting: its invocation's id. */
const send = async (path: string, body: unknown) =>
  (await post<{ invocationId: string }>(`${path}/send`, body)).invocationId;

/** The answer of the invocation `id`, once it ends. */
const attach = async <T>(id: string): Promise<T> => {
  const r = await fetch(`${INGRESS}/restate/invocation/${id}/attach`, { signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`attach ${id}: ${r.status} ${text}`);
  return JSON.parse(text) as T;
};

/** The invocation `id`'s status and the deployment it is pinned to, if any. */
const invocation = async (id: string) => {
  const r = await fetch(`${ADMIN}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: `SELECT status, pinned_deployment_id FROM sys_invocation WHERE id = '${id}'` }),
  });
  const { rows } = (await r.json()) as { rows: { status: string; pinned_deployment_id: string | null }[] };
  return rows[0];
};

const list = (key: string) => post<{ version: string; notes: Note[] }>(`Notes/${key}/list`);

if (process.argv[2] === 'serve') {
  await restate.serve(...services(process.argv[3] as 'v1' | 'v2')); // on PORT
} else {
  await main();
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'restate-sessions-versions-'));
  const log = openSync(join(dir, 'log'), 'a');
  console.error(`logs in ${dir}`);
  const server = spawn(SERVER, ['--base-dir', join(dir, 'server')], {
    env: { ...process.env, RESTATE_BIND_IP: '127.0.0.1', RESTATE_LISTEN_MODE: 'tcp' },
    stdio: ['ignore', log, log],
  });
  const children: ChildProcess[] = [server];
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(1));
  process.on('exit', () => children.forEach((c) => c.kill('SIGKILL')));

  await until('restate-server did not start', () => fetch(`${ADMIN}/health`).then((r) => r.ok));

  /** Serve `version` on `port`, register it, and return its deployment's id. */
  const deploy = async (version: 'v1' | 'v2', port: number) => {
    children.push(
      spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', version], {
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', log, log],
      }),
    );
    let id = '';
    await until(`${version} on ${port} did not register`, async () => {
      const r = await fetch(`${ADMIN}/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uri: `http://127.0.0.1:${port}`, force: true }),
      });
      if (r.ok) id = ((await r.json()) as { id: string }).id;
      return r.ok;
    });
    return id;
  };

  let failed = 0;
  const check = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}: ${(e as Error).message}`);
    }
  };

  const v1 = await deploy('v1', 9191);
  await post('Notes/k/add', { id: 'a', text: 'by v1' });
  await post('Notes/j/add', { id: 'a', text: 'by v1' });

  // v1 holds k; two more invocations of k queue behind it; then v2 is registered.
  // Long enough for v2 to start and register on a slow machine, which the
  // check after the deploy confirms: otherwise the queued ones ran on v1.
  const held = await send('Notes/k/hold', { id: 'b', text: 'held', ms: 15_000 });
  await until('the hold did not start', async () => (await invocation(held))?.pinned_deployment_id === v1);
  const queued = [
    await send('Notes/k/add', { id: 'c', text: 'queued' }),
    await send('Notes/k/add', { id: 'd', text: 'queued' }),
  ];
  const v2 = await deploy('v2', 9192);
  assert.equal((await invocation(held))?.status, 'running', 'v1 still holds k once v2 is registered');

  await check('an invocation runs on the deployment it started on', async () => {
    assert.equal(await attach(held), 'v1');
    assert.equal((await invocation(held))?.pinned_deployment_id, v1);
  });
  await check('invocations queued behind it are pinned as they start: on v2', async () => {
    for (const id of queued) {
      assert.equal(await attach(id), 'v2', id);
      assert.equal((await invocation(id))?.pinned_deployment_id, v2, id);
    }
  });
  await check("v2's step ran once on k, and v2 reads v1's commits with it", async () => {
    assert.deepEqual(await list('k'), {
      version: 'v2',
      notes: [
        { id: 'a', text: 'by v1', version: 1 },
        { id: 'b', text: 'held', version: 1 }, // v1 wrote it before v2's step ran
        { id: 'c', text: 'queued', version: 2 },
        { id: 'd', text: 'queued', version: 2 },
      ],
    });
  });
  await check('a v2 view of a key only v1 wrote applies the step in its own session', async () => {
    assert.deepEqual(await list('j'), { version: 'v2', notes: [{ id: 'a', text: 'by v1', version: 1 }] });
    // and a v2 handler then applies it for good, once
    assert.equal(await post('Notes/j/add', { id: 'b', text: 'by v2' }), 'v2');
    assert.deepEqual((await list('j')).notes, [
      { id: 'a', text: 'by v1', version: 1 },
      { id: 'b', text: 'by v2', version: 2 },
    ]);
  });

  // A rollback: v1 again, as a new deployment.
  await deploy('v1', 9193);
  await check("rolled back, v1's code works on the database v2 widened", async () => {
    assert.equal(await post('Notes/k/add', { id: 'e', text: 'by v1 again' }), 'v1');
    const { version, notes } = await list('k');
    assert.equal(version, 'v1');
    assert.deepEqual(
      notes.map((n) => n.id),
      ['a', 'b', 'c', 'd', 'e'],
    );
  });

  // And forward again.
  await deploy('v2', 9194);
  await check(
    "rolled forward, v2's step does not run again: what v1 wrote meanwhile keeps the column empty",
    async () => {
      assert.equal(await post('Notes/k/add', { id: 'f', text: 'by v2 again' }), 'v2');
      const { notes } = await list('k');
      assert.deepEqual(
        notes.map((n) => [n.id, n.version]),
        [
          ['a', 1],
          ['b', 1],
          ['c', 2],
          ['d', 2],
          ['e', null],
          ['f', 2],
        ],
      );
    },
  );

  console.log(failed === 0 ? 'all passed' : `${failed} failed`);
  if (failed === 0) rmSync(dir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}
