// The calls of a session that the addon answers at once with their value, and
// the ones it answers with a promise, in every order the two can come: against
// the released engine every call is a promise, so a fake session of the addon
// makes each of them either, as the test scripts it. The package takes a value
// that is ready without a promise inside (`queryColumnsNow`, `callNow`), and
// the public calls return a promise all the same, and in call order.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { open, type Store } from '@restatedev/sessions/internal';
import { afterEach, describe, test } from 'vitest';
import { addon } from '../src/addon.ts';
import { sqlAttempt } from './support.ts';

type Mode = 'ready' | 'pending' | 'throw';

/** A session of the addon whose calls answer as scripted: the next of `script`, else ready. */
class Fake {
  script: Mode[] = [];
  /** What the addon was called with, in order: `values:SQL`, `begin`, `commit:withCommit`, `rollback`. */
  log: string[] = [];
  private readonly waiting: (() => void)[] = [];

  private answer<T>(what: string, value: T): T | Promise<T> {
    this.log.push(what);
    const mode = this.script.shift() ?? 'ready';
    if (mode === 'throw') throw new Error(`refused ${what}`);
    if (mode === 'ready') return value;
    return new Promise((resolve) => this.waiting.push(() => resolve(value)));
  }

  /** The oldest call that waits answers. */
  release(): void {
    this.waiting.shift()?.();
  }

  get waits(): number {
    return this.waiting.length;
  }

  queryColumns(sql: string) {
    return this.answer(`sql:${sql}`, { columns: ['sql'], rows: [[sql]] });
  }
  begin() {
    return this.answer('begin', undefined);
  }
  commit(_records: unknown, withCommit?: boolean) {
    return this.answer(`commit:${withCommit}`, undefined);
  }
  rollback() {
    return this.answer('rollback', undefined);
  }
  record() {
    return Buffer.alloc(0);
  }
  isUsable() {
    return true;
  }
  save() {
    return undefined;
  }
  async close() {}
}

const store: Store = { get: async () => undefined, set: () => {}, clear: () => {}, sync: async () => {} };

// The addon's `open` is a plain function of its module: it is put back as it was.
// oxlint-disable-next-line typescript/unbound-method
const original = addon.open;
let fake: Fake;
function fakeSession(): Fake {
  fake = new Fake();
  (addon as { open: unknown }).open = async () => fake;
  return fake;
}
afterEach(() => {
  (addon as { open: unknown }).open = original;
});

/** Whether `value` is a promise a caller can chain on. */
function assertPromise(value: unknown, what: string): void {
  assert.ok(value instanceof Promise, `${what} is a Promise`);
  for (const method of ['then', 'catch', 'finally'] as const) assert.equal(typeof value[method], 'function', what);
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a connection', () => {
  test('ready, pending and ready calls made in one tick complete in call order', async () => {
    const f = fakeSession();
    const db = await open('ready-1', store);
    f.script = ['ready', 'pending', 'ready'];
    const done: number[] = [];
    const calls = [1, 2, 3].map((n) => {
      const call = db.values(`q${n}`);
      assertPromise(call, `call ${n}`);
      return call.then((rows) => (done.push(n), rows));
    });
    // The first was answered at once; the third waits behind the second, which waits for the addon.
    assert.deepEqual(f.log, ['sql:q1', 'sql:q2']);
    await turn();
    assert.deepEqual(done, [1]);
    f.release();
    assert.deepEqual(await Promise.all(calls), [[['q1']], [['q2']], [['q3']]]);
    assert.deepEqual(done, [1, 2, 3]);
    assert.deepEqual(f.log, ['sql:q1', 'sql:q2', 'sql:q3']);
  });

  test('a ready call that throws is a rejection, and the call behind it runs', async () => {
    const f = fakeSession();
    const db = await open('ready-2', store);
    f.script = ['throw', 'ready'];
    let first: Promise<unknown> | undefined;
    assert.doesNotThrow(() => (first = db.values('bad')));
    assertPromise(first, 'the failed call');
    const second = db.values('good');
    await assert.rejects(first!, /refused sql:bad/);
    assert.deepEqual(await second, [['good']]);
    // And one that waits, then one that is ready.
    f.script = ['pending', 'throw', 'ready'];
    const [a, b, c] = [db.values('a'), db.values('b'), db.values('c')];
    f.release();
    assert.deepEqual(await a, [['a']]);
    await assert.rejects(b, /refused sql:b/);
    assert.deepEqual(await c, [['c']]);
  });

  test('ready calls in a transaction, which commits with or without withCommit work, or rolls back', async () => {
    const f = fakeSession();
    const db = await open('ready-3', store);
    const ran: string[] = [];
    const committed = db.transaction(async (tx) => {
      assertPromise(tx.values('t1'), 'tx call');
      assert.deepEqual(await tx.values('t2'), [['t2']]);
      return 'one';
    });
    assertPromise(committed, 'transaction');
    assert.equal(await committed, 'one');
    assert.deepEqual(f.log, ['begin', 'sql:t1', 'sql:t2', 'commit:false']);

    f.log.length = 0;
    await db.transaction(async (tx) => {
      await tx.execute('t3');
      tx.withCommit(() => ran.push('with'));
    });
    assert.deepEqual(f.log, ['begin', 'sql:t3', 'commit:true']);
    assert.deepEqual(ran, ['with']);

    f.log.length = 0;
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute('t4');
        tx.withCommit(() => ran.push('rolled back'));
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.deepEqual(f.log, ['begin', 'sql:t4', 'rollback']);
    assert.deepEqual(ran, ['with']);

    // Mixed inside one: ready, pending, ready; a failing ready call fails the body when it lets it.
    f.log.length = 0;
    f.script = ['ready', 'ready', 'pending', 'ready', 'throw'];
    const mixed = db.transaction(async (tx) => {
      const rows = [tx.values('m1'), tx.values('m2'), tx.values('m3')];
      await turn();
      assert.deepEqual(f.log, ['begin', 'sql:m1', 'sql:m2']);
      f.release();
      assert.deepEqual(await Promise.all(rows), [[['m1']], [['m2']], [['m3']]]);
      await tx.execute('m4');
    });
    await assert.rejects(mixed, /refused sql:m4/);
    assert.deepEqual(f.log.slice(-2), ['sql:m4', 'rollback']);
    assert.deepEqual(await db.values('after'), [['after']]);
  });

  test('a call behind a transaction runs after it, whether the transaction was answered at once or not', async () => {
    for (const script of [[], ['ready', 'pending'], ['pending']] as Mode[][]) {
      const f = fakeSession();
      const db = await open('ready-4', store);
      f.script = script;
      const held = db.transaction(async (tx) => tx.execute('inside'));
      const behind = db.values('behind');
      await turn();
      while (f.waits > 0) {
        f.release();
        await turn();
      }
      await held;
      assert.deepEqual(await behind, [['behind']]);
      assert.deepEqual(f.log, ['begin', 'sql:inside', 'commit:false', 'sql:behind'], script.join());
    }
  });
});

/** The attempt's database over a fake session, and the fake. */
async function attempt(run: (db: ReturnType<typeof sqlAttempt>['db'], f: Fake) => Promise<void>) {
  const f = fakeSession();
  const a = sqlAttempt({ map: new Map() });
  await a.end(() => run(a.db, f));
}

describe("an attempt's ctx.db", () => {
  test('every public call is a promise, ready or not, and they complete in call order', async () => {
    await attempt(async (db, f) => {
      assert.deepEqual(await db.values('warm'), [['warm']]);
      f.script = ['ready', 'pending', 'ready'];
      const done: number[] = [];
      const calls = [db.values('q1'), db.query('q2'), db.get('q3'), db.execute('q4')];
      for (const [i, call] of calls.entries()) {
        assertPromise(call, `call ${i + 1}`);
        void call.then(() => done.push(i + 1));
      }
      await turn();
      f.release();
      assert.deepEqual(await calls[0], [['q1']]);
      assert.deepEqual(await calls[1], [{ sql: 'q2' }]);
      assert.deepEqual(await calls[2], { sql: 'q3' });
      assert.equal(await calls[3], undefined);
      assert.deepEqual(done, [1, 2, 3, 4]);
    });
  });

  test('a query made right after a transaction runs after it, though its session was open and answered at once', async () => {
    await attempt(async (db, f) => {
      await db.values('warm');
      f.log.length = 0;
      const held = db.transaction(async (tx) => tx.execute('inside'));
      const behind = db.values('behind');
      assertPromise(behind, 'the query');
      await held;
      assert.deepEqual(await behind, [['behind']]);
      assert.deepEqual(f.log, ['begin', 'sql:inside', 'commit:false', 'sql:behind']);
    });
  });

  test('a ready call that throws is a rejection that the next call does not share', async () => {
    await attempt(async (db, f) => {
      await db.values('warm');
      f.script = ['throw', 'ready'];
      let bad: Promise<unknown> | undefined;
      assert.doesNotThrow(() => (bad = db.values('bad')));
      const good = db.values('good');
      await assert.rejects(bad!, /refused sql:bad/);
      assert.deepEqual(await good, [['good']]);
    });
  });
});
