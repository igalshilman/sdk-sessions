// RESTATE_SQL_L0_BYTES: how many bytes of packs a database keeps in Restate
// (L0) before a checkpoint moves them to the object store. This process has
// 0, so every checkpoint's pack goes to the object store, here a directory,
// however small the database; it is read at the process's first open, so it
// is set before any, and the page cache is off, so every session reads cold.
// Other values, and a change from one process to the next, run in processes
// of their own (object-store-process.ts), over a state kept in a file.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, test } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'sessions-l0-'));
process.env.RESTATE_SQL_OBJECT_STORE = `file://${dir}/packs`;
process.env.RESTATE_SQL_CACHE = 'off';
process.env.RESTATE_SQL_L0_BYTES = '0';
const { open } = await import('@restatedev/sessions/internal');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Stored values, every write synced at once. */
function memory() {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    store: {
      get: async (key: string) => stored.get(key),
      set: (key: string, value: Uint8Array) => void stored.set(key, Uint8Array.from(value)),
      clear: (key: string) => void stored.delete(key),
      sync: async () => {},
      keys: async () => [...stored.keys()],
    },
  };
}

/** Every file under `path`, relative to it. */
function files(path: string): string[] {
  try {
    return readdirSync(path, { recursive: true, encoding: 'utf8' }).filter((f) => statSync(join(path, f)).isFile());
  } catch {
    return [];
  }
}

/** The keys that hold no pack: the head, the tail's entries and the manifests. */
const NO_PACK = /^v22\/(head$|tail\/|manifest\/)/;

test('with RESTATE_SQL_L0_BYTES=0, a database far under 4 MiB keeps every pack in the object store', async () => {
  const { store, stored } = memory();
  const namespace = 'Ledger/small';
  const packs = join(dir, 'packs', '_4cedger_2fsmall');

  const hash = createHash('sha256');
  const db = await open(namespace, store);
  await db.execute('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)');
  await db.execute('CREATE TABLE counter (n INTEGER NOT NULL)');
  await db.execute('INSERT INTO counter VALUES (0)');
  // 2 MiB that does not compress, 64 KiB a commit: a checkpoint at each MiB
  // of tail.
  for (let i = 0; i < 32; i++) {
    const data = randomBytes(64 << 10);
    hash.update(data);
    await db.execute('INSERT INTO blobs VALUES (?, ?)', [i, data]);
  }
  // Then small commits: a checkpoint at each 128 of them, the second of
  // which drops the tail that held the blobs.
  for (let i = 0; i < 300; i++) await db.execute('UPDATE counter SET n = n + 1');
  await db.save();

  const l1 = files(packs);
  assert.ok(l1.length > 0 && l1.every((f) => f.startsWith('l1/')), `L1's packs: ${l1.join(', ')}`);
  const inL1 = l1.reduce((n, f) => n + statSync(join(packs, f)).size, 0);
  assert.ok(inL1 >= 2 << 20, `${inL1} bytes in the object store`);
  // Restate holds no pack, only the head, two manifests and the tail since
  // the checkpoint before the head's: here some 170 counter updates, a few
  // KiB in all.
  assert.deepEqual(
    [...stored.keys()].filter((key) => !NO_PACK.test(key)),
    [],
  );
  const inRestate = [...stored.values()].reduce((n, v) => n + v.length, 0);
  assert.ok(inRestate < 64 << 10, `${inRestate} bytes in Restate`);

  // A cold session reads every row from the object store, and the tail.
  const again = await open(namespace, store);
  const read = createHash('sha256');
  for (const [data] of await again.values('SELECT data FROM blobs ORDER BY id')) read.update(data as Uint8Array);
  assert.equal(read.digest('hex'), hash.digest('hex'));
  assert.deepEqual(await again.values('SELECT n FROM counter'), [[300]]);
  // So does a reader beside it.
  const reader = await open(namespace, store, { reader: true });
  assert.deepEqual(await reader.values('SELECT count(*), sum(length(data)) FROM blobs'), [[32, 32 * (64 << 10)]]);
  await reader.close();
  await again.close();
});

const child = fileURLToPath(new URL('object-store-process.ts', import.meta.url));

/**
 * A session of the database `namespace`, whose Restate state is the file
 * `state`, in a process of its own with `env` (an empty value unsets one):
 * the rows it read and checked, before adding `add`, or the open's error.
 */
async function session(state: string, namespace: string, add: number, env: Record<string, string>) {
  const { stdout } = await promisify(execFile)(process.execPath, [child, state, namespace, String(add)], {
    env: { ...process.env, ...env },
  });
  return JSON.parse(stdout) as { rows: number } | { error: string; again: string };
}

/** The keys of the Restate state the file `state` holds. */
function keys(state: string): string[] {
  return Object.keys(JSON.parse(readFileSync(state, 'utf8')) as Record<string, string>);
}

test('each process may open a database with a RESTATE_SQL_L0_BYTES of its own', async () => {
  const state = join(dir, 'ledger-b.json');
  const namespace = 'Ledger/b';
  const packs = join(dir, 'packs', '_4cedger_2fb');
  const inL0 = () => keys(state).filter((key) => key.startsWith('v22/pack/l0/')).length;
  const inL1 = () => files(packs).filter((f) => f.startsWith('l1/')).length;

  // The default, 4 MiB: 300 KiB stays in Restate.
  assert.deepEqual(await session(state, namespace, 300, { RESTATE_SQL_L0_BYTES: '' }), { rows: 0 });
  assert.ok(inL0() > 0, 'packs in L0');
  assert.equal(inL1(), 0);

  // 0: the next checkpoint moves all L0 holds to the object store, with its
  // own pack, and the one after it deletes L0's packs.
  assert.deepEqual(await session(state, namespace, 300, { RESTATE_SQL_L0_BYTES: '0' }), { rows: 300 });
  assert.equal(inL0(), 0);
  assert.ok(inL1() > 0, 'packs in L1');
  assert.deepEqual(
    keys(state).filter((key) => !NO_PACK.test(key)),
    [],
  );

  // Raised: checkpoints go to Restate again, and what they did not rewrite
  // stays in the object store, where it is read.
  assert.deepEqual(await session(state, namespace, 300, { RESTATE_SQL_L0_BYTES: '64MiB' }), { rows: 600 });
  assert.ok(inL0() > 0, 'packs in L0 again');
  assert.ok(inL1() > 0, 'packs in L1 still');

  // And back to the default, which reads both tiers.
  assert.deepEqual(await session(state, namespace, 0, { RESTATE_SQL_L0_BYTES: '' }), { rows: 900 });
});

test('a RESTATE_SQL_L0_BYTES that is not a size fails every open, with its message', async () => {
  // With an object store, or without one, where it would change nothing.
  const url = process.env.RESTATE_SQL_OBJECT_STORE ?? '';
  for (const [value, store] of [
    ['4MB', url],
    ['-1', url],
    ['1.5MiB', ''],
  ] as const) {
    const env = { RESTATE_SQL_L0_BYTES: value, RESTATE_SQL_OBJECT_STORE: store };
    const error = `RESTATE_SQL_L0_BYTES=${value}: not a size (bytes, or with KiB, MiB or GiB)`;
    assert.deepEqual(await session(join(dir, 'unopened.json'), 'Ledger/c', 1, env), { error, again: error });
  }
});
