// A cancellation of a session object's invocation, without a Restate server:
// each attempt has `ctx.db` over the object's state in memory, and the SDK
// cancels the session's request that is pending when a test says, as it does
// at Restate's cancel signal. The session adds nothing to Restate's
// cancellation: the call awaiting that request fails with the CancelledError,
// as any await does. What it keeps is a transaction's sends, made once if it
// committed, however the attempt ends.
import * as restate from '@restatedev/sessions';
import { open } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { memoryStore, sqlAttempt } from './support.ts';

type Send = restate.GenericSend<Uint8Array>;

const store = restate.object({
  name: 'Store',
  handlers: {
    reserve: async (_ctx: restate.ObjectContext, _item: string) => {},
  },
});

const decode = (s: Send) => JSON.parse(new TextDecoder().decode(s.parameter)) as unknown;
let namespaces = 0;

/** An object's state, and attempts over it, which record their sends. */
function object() {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    /** An attempt; with `crash`, its writes and sends are lost from the first send on. */
    attempt({ crash = false, shared = false } = {}) {
      const sent: Send[] = [];
      const fence = { closed: false };
      // Which request the SDK cancels: the nth sync from now, or the next request.
      let syncs: number | undefined;
      let next = false;
      const a = sqlAttempt({
        map,
        fence,
        shared,
        send: (s: Send) => {
          if (crash) {
            fence.closed = true;
            throw new Error('crashed');
          }
          sent.push(s);
        },
        onSync: async () => {
          if (syncs === undefined || --syncs > 0) return;
          syncs = undefined;
          throw new restate.CancelledError();
        },
        onAwait: async () => {
          if (!next) return;
          next = false;
          throw new restate.CancelledError();
        },
      });
      return {
        ...a,
        sent,
        /** Restate cancels the invocation: the SDK cancels the session's next request. */
        cancelNextRequest: () => {
          next = true;
        },
        /** Restate cancels the invocation while the nth commit from now waits for its sync. */
        cancelOnSync: (nth = 1) => {
          syncs = nth;
        },
      };
    },
    /** The keys of the sends in the stored outbox. */
    async outbox() {
      const db = await open(`outbox-${namespaces++}`, memoryStore(map));
      const record = await db.record('outbox');
      await db.close();
      if (record.length === 0) return [];
      const outbox = JSON.parse(new TextDecoder().decode(record)) as { id: string; sends: unknown[] }[];
      return outbox.flatMap(({ id, sends }) => sends.map((_, i) => `transaction/${id}/${i}`));
    },
    /** The balance's rows, as committed. */
    async rows() {
      const a = this.attempt();
      return a.end(() => a.db.values('SELECT v FROM balance ORDER BY rowid'));
    },
  };
}

type Attempt = ReturnType<ReturnType<typeof object>['attempt']>;

/** A debit, as one transaction with a send. */
const debit = (a: { db: restate.Database }, during?: () => void) =>
  a.db.transaction(async (tx) => {
    await tx.execute('CREATE TABLE IF NOT EXISTS balance (v INTEGER)');
    during?.();
    await tx.execute('INSERT INTO balance VALUES (5)');
    tx.send(store, 'a').reserve('book');
  });

/** The send of `debit`, made once, with a key of its transaction. */
const madeOnce = (a: Attempt) => {
  expect(a.sent.map(decode)).toEqual(['book']);
  expect(a.sent[0]!.idempotencyKey).toMatch(/^transaction\/[\w-]+\/0$/);
};

describe('a cancellation that reaches a transaction', () => {
  it.each([
    // Its SQL awaits nothing of Restate's: the signal reaches the commit's sync.
    ['while its body runs', (a: Attempt) => debit(a, a.cancelNextRequest)],
    ['while its commit syncs', (a: Attempt) => (a.cancelOnSync(1), debit(a))],
    ['while the commit that empties its outbox syncs', (a: Attempt) => (a.cancelOnSync(2), debit(a))],
  ])('%s fails it with the CancelledError; what it committed has its sends, made once', async (_when, run) => {
    const o = object();
    const a = o.attempt();
    await expect(a.end(() => run(a))).rejects.toBeInstanceOf(restate.CancelledError);
    madeOnce(a);
    expect(await o.outbox()).toEqual([]);
    expect(await o.rows()).toEqual([[5]]);
  });

  it('leaves the outbox empty when the handler catches it and returns', async () => {
    const o = object();
    const a = o.attempt();
    const result = await a.end(async () => {
      a.cancelOnSync(1);
      return debit(a).then(
        () => 'not cancelled',
        (e: unknown) => (e instanceof restate.CancelledError ? 'stopped' : Promise.reject(e)),
      );
    });
    expect(result).toBe('stopped');
    madeOnce(a);
    expect(await o.outbox()).toEqual([]);
  });

  it('leaves the calls after it working: the handler reads what committed, and compensates', async () => {
    const o = object();
    const a = o.attempt();
    await a.end(async () => {
      a.cancelOnSync(1);
      await expect(debit(a)).rejects.toBeInstanceOf(restate.CancelledError);
      // Made with the commit, before its await failed.
      madeOnce(a);
      // Whether it committed is in the database.
      expect(await a.db.values('SELECT v FROM balance')).toEqual([[5]]);
      await a.db.execute('INSERT INTO balance VALUES (-5)');
    });
    expect(await o.rows()).toEqual([[5], [-5]]);
    madeOnce(a);
    expect(await o.outbox()).toEqual([]);
  });

  it('rolls it back when it reaches an await of its body that is not the session’s', async () => {
    const o = object();
    const a = o.attempt();
    await a.end(async () => {
      await a.db.execute('CREATE TABLE balance (v INTEGER)');
      const failed = a.db.transaction(async (tx) => {
        await tx.execute('INSERT INTO balance VALUES (5)');
        tx.send(store, 'a').reserve('book');
        throw new restate.CancelledError(); // a ctx.rpc of the body, which the SDK cancelled
      });
      await expect(failed).rejects.toBeInstanceOf(restate.CancelledError);
      expect(await a.db.values('SELECT count(*) FROM balance')).toEqual([[0]]);
    });
    expect(a.sent).toEqual([]);
  });
});

describe('a cancellation that reaches another call of ctx.db', () => {
  it('fails every call awaiting the session it ended; the next opens it again', async () => {
    const o = object();
    const a = o.attempt();
    await a.end(async () => {
      await a.db.execute('CREATE TABLE balance (v INTEGER)');
      a.cancelOnSync(1);
      // The second waits for the first, whose commit the signal reaches.
      const [first, second] = await Promise.allSettled([
        a.db.execute('INSERT INTO balance VALUES (5)'),
        a.db.execute('INSERT INTO balance VALUES (6)'),
      ]);
      expect(first.status === 'rejected' && first.reason instanceof restate.CancelledError).toBe(true);
      expect(second.status === 'rejected' && second.reason instanceof restate.CancelledError).toBe(true);
      // The first committed: its writes came before its sync's await.
      expect(await a.db.values('SELECT v FROM balance ORDER BY rowid')).toEqual([[5]]);
    });
  });

  it('fails the first call with one that reached the open as the attempt started', async () => {
    const o = object();
    const a = o.attempt();
    await a.end(async () => {
      a.cancelNextRequest();
      a.openNow();
      await expect(a.db.execute('CREATE TABLE balance (v INTEGER)')).rejects.toBeInstanceOf(restate.CancelledError);
      await a.db.execute('CREATE TABLE balance (v INTEGER)');
    });
    expect(await o.rows()).toEqual([]);
  });

  it('fails a view’s read; the next read works', async () => {
    const o = object();
    const setup = o.attempt();
    await setup.end(() => setup.db.execute('CREATE TABLE balance (v INTEGER); INSERT INTO balance VALUES (5)'));
    const view = o.attempt({ shared: true });
    await view.end(async () => {
      view.cancelNextRequest(); // the open's first read
      await expect(view.db.values('SELECT v FROM balance')).rejects.toBeInstanceOf(restate.CancelledError);
      expect(await view.db.values('SELECT v FROM balance')).toEqual([[5]]);
    });
  });
});

describe('a retry of a cancelled invocation', () => {
  it('fails its first call, and makes the sends a crash left unmade as it ends', async () => {
    const o = object();
    const crashed = o.attempt({ crash: true });
    await expect(debit(crashed)).rejects.toThrow('crashed'); // committed; the sends are lost
    crashed.abort();
    const lost = await o.outbox();
    expect(lost).toHaveLength(1);
    // Restate retries it, and its signal comes at the retry's first await:
    // a read of the open, which so makes nothing. No attempt follows this one.
    const retry = o.attempt();
    retry.cancelNextRequest();
    await expect(retry.end(() => retry.db.values('SELECT v FROM balance'))).rejects.toBeInstanceOf(
      restate.CancelledError,
    );
    expect(retry.sent.map((s) => s.idempotencyKey)).toEqual(lost);
    expect(await o.outbox()).toEqual([]);
    expect(await o.rows()).toEqual([[5]]);
  });
});
