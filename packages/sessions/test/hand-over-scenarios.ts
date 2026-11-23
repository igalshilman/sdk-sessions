// SQL calls through the addon that are ready in their first poll, that wait
// and settle later, and a mix of both in one transaction: what they return,
// as a transcript that does not depend on which way each was answered, so that
// runs where the page cache holds everything and where it holds nothing (a call
// that has to read waits) can be compared (`hand-over.test.ts`).
import { randomUUID } from 'node:crypto';
import { open, type Store } from '../src/database.ts';
import { asDatabase } from '../src/session.ts';

/** A store over a map: what a connection needs of the SDK. */
function memory(): Store {
  const map = new Map<string, Uint8Array>();
  return {
    get: async (key) => map.get(key),
    set: (key, value) => void map.set(key, Uint8Array.from(value)),
    clear: (key) => void map.delete(key),
    sync: async () => {},
  };
}

/** A value as JSON text: bigints and bytes have none of their own. */
const show = (value: unknown): string => JSON.stringify(plain(value));

function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, plain(v)]));
  }
  return value;
}

/** The transcript of one run of the scenarios. */
export async function scenarios(): Promise<string[]> {
  const out: string[] = [];
  const note = (what: string, value: unknown) => out.push(`${what}: ${show(value)}`);
  const failure = async (what: string, call: Promise<unknown>) => {
    try {
      await call;
      note(what, 'did not fail');
    } catch (error) {
      note(what, { name: (error as Error).name, message: (error as Error).message });
    }
  };
  const connection = await open(`in-place-${randomUUID()}`, memory());
  const db = asDatabase(connection);

  // Values: integers past 2^53, blobs, NULL, reals, text, an empty result, column names.
  await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, big INTEGER, b BLOB, r REAL, s TEXT, n INTEGER)');
  await db.execute('INSERT INTO t VALUES(?, ?, ?, ?, ?, ?)', [
    1,
    2n ** 62n,
    Uint8Array.from([0, 255, 7]),
    -0.5,
    'héllo',
    null,
  ]);
  await db.execute('INSERT INTO t VALUES(?, ?, ?, ?, ?, ?)', [2, -(2n ** 63n), new Uint8Array(0), 1e300, '', 0]);
  await db.execute('INSERT INTO t VALUES(?, ?, ?, ?, ?, ?)', [
    3,
    2 ** 53,
    Uint8Array.from([1]),
    2 ** 53,
    'x'.repeat(5000),
    -1,
  ]);
  note('values', await db.values('SELECT * FROM t ORDER BY id'));
  note('rows', await db.query('SELECT id, big AS "Big Name", s FROM t ORDER BY id DESC LIMIT 2'));
  note('empty', await db.values('SELECT * FROM t WHERE id > 100'));
  note('no columns', await db.values('INSERT INTO t(id) VALUES(4)'));
  note('proto', await db.get('SELECT 7 AS "__proto__", 8 AS constructor'));
  const wide = Array.from({ length: 300 }, (_, i) => `${i} AS c${i}`).join(', ');
  note('wide', (await db.values(`SELECT ${wide}`))[0]!.length);
  note('wide object', Object.keys((await db.get(`SELECT ${wide}`))!).length);

  // Calls made back to back: ready ones, and one that waits (a text never seen, a long scan).
  const unseen = `SELECT ${Math.floor(Math.random() * 1e9)} + 1 AS unseen`;
  const together = await Promise.all([
    db.values('SELECT count(*) FROM t'),
    db.values(unseen),
    db.values(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 30000) SELECT count(*), sum(x) FROM c',
    ),
    db.execute('INSERT INTO t(id) VALUES(5)'),
    db.values('SELECT count(*) FROM t'),
  ]);
  note('together', [together[0], together[2], together[3], together[4]]);
  note('unseen is a number', typeof (together[1] as number[][])[0]![0]);

  // A transaction that mixes the two, and rolls back; then one that commits.
  await failure(
    'rolled back',
    db.transaction(async (tx) => {
      await tx.execute('INSERT INTO t(id) VALUES(10)');
      note('inside', await tx.values('SELECT count(*) FROM t'));
      await tx.values(`SELECT ${Math.floor(Math.random() * 1e9)} AS unseen`);
      await tx.execute('INSERT INTO t(id) VALUES(11)');
      throw new Error('abort');
    }),
  );
  note('after rollback', await db.values('SELECT count(*) FROM t'));
  await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO t(id) VALUES(20)');
    await tx.execute('SAVEPOINT a');
    await tx.execute('INSERT INTO t(id) VALUES(21)');
    await tx.values(`SELECT ${Math.floor(Math.random() * 1e9)} AS unseen`);
    await tx.execute('ROLLBACK TO a');
    await tx.execute('RELEASE a');
    await tx.execute('INSERT INTO t(id) VALUES(22)');
    note('in savepoint tx', await tx.values('SELECT id FROM t WHERE id >= 20 ORDER BY id'));
  });
  note('after savepoint', await db.values('SELECT id FROM t WHERE id >= 10 ORDER BY id'));

  // Failures are the same however they were answered.
  await failure('missing table', db.query('SELECT * FROM missing'));
  await failure('syntax', db.values('SELECT 1 +'));
  await failure('constraint', db.execute('INSERT INTO t(id) VALUES(1)'));
  await failure('twice', db.query('SELECT 1 AS a, 2 AS a'));
  await failure('params', db.query('SELECT ?', [{} as never]));
  note('usable', connection.isUsable());
  await connection.save();
  return out;
}

/**
 * A call that is outstanding as its session closes: it settles (it is not
 * left pending), the session is unusable, and the calls after fail.
 */
export async function closedWhilePending(): Promise<{
  settled: 'resolved' | 'rejected';
  usable: boolean;
  after: string;
}> {
  const connection = await open(`in-place-close-${randomUUID()}`, memory());
  await connection.execute('CREATE TABLE t(x)');
  const slow = connection.values(
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000000) SELECT count(*) FROM c',
  );
  const closed = connection.close();
  const settled = await slow.then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  );
  await closed.catch(() => {});
  let after = 'did not fail';
  try {
    await connection.values('SELECT 1');
  } catch (error) {
    after = (error as Error).constructor.name;
  }
  return { settled, usable: connection.isUsable(), after };
}
