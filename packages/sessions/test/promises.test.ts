// The contract of the database's public calls, whatever way the addon answers
// them: each returns a real promise (it has then, catch and finally), a failure
// is a rejection and never a throw, calls complete in the order they were made,
// and a call behind a transaction runs after it. Over a connection, over the
// `asDatabase` of one, and over an attempt's `ctx.db`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '@restatedev/sessions';
import { asDatabase, open, type Store } from '@restatedev/sessions/internal';
import { describe, test } from 'vitest';
import { sqlAttempt } from './support.ts';

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

/** A database to run `body` over, and the name of how it is reached. */
interface Surface {
  name: string;
  run: (body: (db: Database) => Promise<void>) => Promise<void>;
}

const surfaces: Surface[] = [
  {
    name: 'a connection',
    run: async (body) => {
      const connection = await open(`promises-${randomUUID()}`, memory());
      try {
        await body(asDatabase(connection));
      } finally {
        await connection.save().catch(() => {});
      }
    },
  },
  {
    name: "an attempt's ctx.db",
    run: async (body) => {
      const attempt = sqlAttempt({ map: new Map() });
      await attempt.end(() => body(attempt.db));
    },
  },
];

/** Whether `value` is a promise a caller can chain on. */
function assertPromise(value: unknown, what: string): void {
  assert.ok(value instanceof Promise, `${what} is a Promise`);
  for (const method of ['then', 'catch', 'finally'] as const) {
    assert.equal(typeof value[method], 'function', `${what} has ${method}`);
  }
}

/** `call`'s promise: it did not throw. */
function started<T>(call: () => Promise<T>, what: string): Promise<T> {
  let promise: Promise<T> | undefined;
  assert.doesNotThrow(() => {
    promise = call();
  }, `${what} does not throw`);
  assertPromise(promise, what);
  return promise!;
}

/** The error `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('it did not reject');
}

describe.each(surfaces)('over $name', ({ run }) => {
  test('every call returns a promise, on a session just opened and on a warm one', async () => {
    await run(async (db) => {
      // The first calls of the session (its cache and its engine are cold), then the same again warm.
      for (const round of ['cold', 'warm']) {
        const at = (what: string) => `${what} (${round})`;
        await started(
          () => db.execute('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, name TEXT)'),
          at('execute'),
        );
        await started(() => db.execute('INSERT OR REPLACE INTO t VALUES(?, ?)', [1, 'a']), at('execute with params'));
        assert.deepEqual(await started(() => db.query('SELECT id, name FROM t'), at('query')), [{ id: 1, name: 'a' }]);
        assert.deepEqual(await started(() => db.get('SELECT name FROM t WHERE id = 1'), at('get')), { name: 'a' });
        assert.equal(await started(() => db.get('SELECT name FROM t WHERE id = 2'), at('get of none')), undefined);
        assert.deepEqual(await started(() => db.values('SELECT id FROM t'), at('values')), [[1]]);
        assert.equal(await started(() => db.execute('DELETE FROM t WHERE id = 2'), at('execute of none')), undefined);
        const inside = await started(
          () =>
            db.transaction(async (tx) => {
              assertPromise(tx.execute('INSERT INTO t VALUES(2, ?)', ['b']), 'tx.execute');
              await started(() => tx.execute('UPDATE t SET name = ? WHERE id = 2', ['c']), 'tx.execute');
              assert.deepEqual(await started(() => tx.query('SELECT name FROM t WHERE id = 2'), 'tx.query'), [
                { name: 'c' },
              ]);
              assert.deepEqual(await started(() => tx.get('SELECT name FROM t WHERE id = 2'), 'tx.get'), { name: 'c' });
              assert.deepEqual(await started(() => tx.values('SELECT count(*) FROM t'), 'tx.values'), [[2]]);
              return 'done';
            }),
          at('transaction'),
        );
        assert.equal(inside, 'done');
        await started(() => db.execute('DELETE FROM t WHERE id = 2'), at('execute'));
      }
    });
  });

  test('a failure is a rejection with the same error class and message, ready or not', async () => {
    await run(async (db) => {
      const attempts: { name: string; message: string }[] = [];
      // The first fails on a session whose engine is cold, the next ones warm.
      for (let i = 0; i < 3; i++) {
        const failures: (() => Promise<unknown>)[] = [
          () => db.query('SELECT * FROM missing'),
          () => db.values('SELECT 1 +'),
          () => db.execute('SELECT 1; SELECT * FROM missing', undefined),
          () => db.query('SELECT 1 AS a, 2 AS a'),
          () => db.query('SELECT ?', [{} as never]),
          () => db.get('SELECT * FROM missing'),
        ];
        for (const [index, call] of failures.entries()) {
          const error = await rejection(started(call, `failure ${index}`));
          if (i === 0) attempts.push({ name: error.name, message: error.message });
          else
            assert.deepEqual(
              { name: error.name, message: error.message },
              attempts[index],
              `failure ${index}, round ${i}`,
            );
        }
      }
      assert.match(attempts[0]!.message, /no such table/);
      assert.match(attempts[3]!.message, /column a is named twice/);
      // None of them ended the session.
      assert.deepEqual(await db.values('SELECT 1'), [[1]]);
      // Inside a transaction the same: a rejection, then the body fails with it.
      const error = await rejection(
        db.transaction(async (tx) => {
          const failed = await rejection(started(() => tx.query('SELECT * FROM missing'), 'tx.query'));
          assert.equal(failed.message, attempts[0]!.message);
          throw failed;
        }),
      );
      assert.equal(error.message, attempts[0]!.message);
    });
  });

  test('calls made back to back complete in the order they were made', async () => {
    await run(async (db) => {
      await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER)');
      const order: string[] = [];
      const note = <T>(promise: Promise<T>, what: string) => promise.then((value) => (order.push(what), value));
      const calls = [
        note(db.execute('INSERT INTO t(n) VALUES(1)'), 'insert 1'),
        note(db.execute('INSERT INTO t(n) VALUES(2)'), 'insert 2'),
        note(db.values('SELECT n FROM t ORDER BY id'), 'read'),
        note(db.execute('INSERT INTO t(n) VALUES(3)'), 'insert 3'),
        note(db.query('SELECT count(*) AS c FROM t'), 'count'),
        note(
          db.query('SELECT * FROM missing').catch(() => 'failed'),
          'failure',
        ),
        note(db.values('SELECT n FROM t ORDER BY id'), 'last read'),
      ];
      const results = await Promise.all(calls);
      assert.deepEqual(order, ['insert 1', 'insert 2', 'read', 'insert 3', 'count', 'failure', 'last read']);
      assert.deepEqual(results[2], [[1], [2]]);
      assert.deepEqual(results[4], [{ c: 3 }]);
      assert.deepEqual(results[6], [[1], [2], [3]]);
    });
  });

  test('a call made behind a transaction runs after it, in the order it was made', async () => {
    await run(async (db) => {
      await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER)');
      const order: string[] = [];
      const held = db.transaction(async (tx) => {
        await tx.execute('INSERT INTO t(n) VALUES(1)');
        await new Promise((resolve) => setTimeout(resolve, 20));
        await tx.execute('INSERT INTO t(n) VALUES(2)');
        order.push('transaction body');
        return 'committed';
      });
      void held.then(() => order.push('transaction'));
      // Made while the body runs: neither runs inside it, both after it, one after the other.
      const read = db.values('SELECT n FROM t ORDER BY id').then((rows) => (order.push('read'), rows));
      const write = db.execute('INSERT INTO t(n) VALUES(3)').then(() => order.push('write'));
      const last = db.values('SELECT n FROM t ORDER BY id').then((rows) => (order.push('last'), rows));
      assert.equal(await held, 'committed');
      assert.deepEqual(await read, [[1], [2]]);
      await write;
      assert.deepEqual(await last, [[1], [2], [3]]);
      assert.deepEqual(order, ['transaction body', 'transaction', 'read', 'write', 'last']);
      // And it is queued behind a transaction that rolls back, too.
      const rolled = db.transaction(async (tx) => {
        await tx.execute('INSERT INTO t(n) VALUES(4)');
        throw new Error('abort');
      });
      const after = db.values('SELECT count(*) FROM t');
      await assert.rejects(rolled, /abort/);
      assert.deepEqual(await after, [[3]]);
    });
  });
});
