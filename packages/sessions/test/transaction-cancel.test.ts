// A transaction under a cancellation, on the wire (`side.ts`): wherever the
// signal lands, `transaction()` either resolves, and then its rows are
// committed and each of its sends went out once, or rejects with
// `CancelledError`, and then it committed nothing and sent nothing. And the
// handler sees one `CancelledError` for the one signal.
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import { serveSession } from '../src/handler.ts';
import { commits, outcome, pause, restateSide, run, said, seeded, TYPE, type Side, type SideOptions } from './side.ts';
import { REQUESTED_ACK } from './vm-support.ts';

/** What a handler's transactions saw, when its attempt cannot answer (a shutdown). */
const seen: string[] = [];
/** Whether each error `seen` has is a `TerminalError`, which a saga compensates on. */
const terminal: boolean[] = [];

/** Work a transaction's body does outside Restate; a test holds it there. */
const outside = { work: (): Promise<void> => Promise.resolve() };

/** One transaction that reads, inserts `body` and sends `body` to `Mail/notify`. */
const insertAndSend = (db: restate.SessionContext['db'], body: string) =>
  db.transaction(async (tx) => {
    await tx.get('SELECT count(*) AS n FROM rows');
    await tx.execute('INSERT INTO rows (body) VALUES (?)', [body]);
    tx.send({ service: 'Mail', key: body, handler: 'notify', input: body });
  });

/** The call each handler makes last: `Callee/echo`. */
const echo = (ctx: restate.SessionContext) => ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' });

const store = restate.sessionObject({
  name: 'Store',
  schema: ['CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT)'],
  handlers: {
    /** Opens the database, so that the schema's commit is behind the key. */
    seed: async () => 'seeded',
    /** One transaction, one statement, one call: how each ended. */
    sweep: async (ctx: restate.SessionContext) => {
      const tx = await said(() => insertAndSend(ctx.db, 'tx'));
      const statement = await said(() => ctx.db.execute("INSERT INTO rows (body) VALUES ('after')"));
      const call = await said(() => echo(ctx));
      return [tx, statement, call].join(',');
    },
    /** A transaction whose body awaits a call; it catches that call's failure if `catches`. */
    bodyCalls: async (ctx: restate.SessionContext, catches: boolean) => {
      let inBody = 'not reached';
      const work = () => ctx.rpc({ service: 'Slow', key: 'a', handler: 'work', input: 'W' });
      const tx = await said(() =>
        ctx.db.transaction(async (t) => {
          await t.execute("INSERT INTO rows (body) VALUES ('tx')");
          let called = 'ok';
          if (catches) called = await said(work);
          else await work();
          inBody = called;
          t.send({ service: 'Mail', key: 'tx', handler: 'notify', input: 'tx' });
        }),
      );
      const statement = await said(() => ctx.db.execute("INSERT INTO rows (body) VALUES ('after')"));
      return [inBody, tx, statement].join(',');
    },
    /** Two transactions, one after the other, then a statement. */
    two: async (ctx: restate.SessionContext) => {
      const first = await said(() => insertAndSend(ctx.db, 'first'));
      const second = await said(() => insertAndSend(ctx.db, 'second'));
      const statement = await said(() => ctx.db.execute("INSERT INTO rows (body) VALUES ('after')"));
      return [first, second, statement].join(',');
    },
    /** The sweep's transaction, noting how it ended where a test can read it. */
    noted: async (ctx: restate.SessionContext) => {
      try {
        await insertAndSend(ctx.db, 'tx');
        seen.push('ok');
      } catch (error) {
        terminal.push(error instanceof restate.TerminalError);
        seen.push(
          error instanceof restate.CancelledError
            ? 'CancelledError'
            : `${(error as Error).name}: ${(error as Error).message}`,
        );
      }
      return 'done';
    },
    /** A transaction whose body writes, works outside Restate, and throws. */
    throws: async (ctx: restate.SessionContext) => {
      const tx = await said(() =>
        ctx.db.transaction(async (t) => {
          await t.execute("INSERT INTO rows (body) VALUES ('tx')");
          t.send({ service: 'Mail', key: 'tx', handler: 'notify', input: 'tx' });
          await outside.work();
          await t.get('SELECT count(*) AS n FROM rows');
          throw new Error('the body failed');
        }),
      );
      const statement = await said(() => ctx.db.execute("INSERT INTO rows (body) VALUES ('after')"));
      const call = await said(() => echo(ctx));
      return [tx, statement, call].join(',');
    },
  },
  views: {
    rows: async (ctx: restate.ViewContext) =>
      (await ctx.db.query<{ body: string }>('SELECT body FROM rows ORDER BY id')).map((r) => r.body),
  },
});

/** The rows stored in `state`, read by a later attempt. */
async function rows(state: Map<string, Uint8Array>, key: string): Promise<string[]> {
  const ended = await run(store, 'rows', state, key);
  if (ended === undefined || !('value' in ended)) throw new Error(`rows ended with ${JSON.stringify(ended)}`);
  return JSON.parse(ended.value) as string[];
}

/** Run `handler` on `state` for `key` with Restate's side `options`, answering everything. */
async function attempt(
  handler: string,
  state: Map<string, Uint8Array>,
  key: string,
  options: SideOptions = {},
  input: unknown = null,
): Promise<Side> {
  const r = restateSide(state, { idPerCall: true, ...options });
  const serving = serveSession(store, handler, r.stream);
  r.start(key, input);
  await r.settle();
  await serving;
  return r;
}

/** The sends of `body` the attempt made, by idempotency key. */
const sendsOf = (r: Side, body: string) => r.sends.filter((s) => s.input === JSON.stringify(body));

/** The types of the commands the attempt sent before its first send. */
function writesBeforeSend(r: Side): number[] {
  const sent = r.sent();
  return sent
    .slice(
      0,
      sent.findIndex((m) => m.type === TYPE.oneWayCall),
    )
    .filter((m) => m.type >= 0x0400 && m.type < 0x8000 && m.type !== TYPE.input)
    .map((m) => m.type);
}

/** The text of the handler's output, which these handlers end with. */
function returned(r: Side): string {
  const ended = outcome(r.sent());
  if (ended === undefined || !('value' in ended)) throw new Error(`the handler ended with ${JSON.stringify(ended)}`);
  return JSON.parse(ended.value) as string;
}

/** What the sweep's run asks for, in order, by what the acks are of. */
const ACKS = [
  "the transaction's commit (head out, ack outstanding)",
  "the outbox's flush, after the transaction's commit",
  "the statement's commit, after the transaction",
];

/** What was outstanding when the signal went in at the `n`-th ask of `r`. */
function phase(r: Side, n: number): string {
  const ask = r.asks[n - 1]!;
  if (ask !== 'ack') return ask;
  return ACKS[r.asks.slice(0, n).filter((a) => a === 'ack').length - 1] ?? 'ack';
}

/** One N of the sweep: what was outstanding when the signal went in, and what the handler saw. */
interface Swept {
  n: number;
  outstanding: string;
  outcomes: string;
  rows: string[];
  sends: number;
}

/** Run `noted` on a seeded key until its commit asks for its ack, then shut the attempt down. */
async function shutAtAck(key: string) {
  const state = await seeded(store, 'seed', key);
  seen.length = 0;
  terminal.length = 0;
  // Started with every key, the attempt asks for nothing before the ack of
  // its transaction's commit: the first thing it asks for.
  const r = restateSide(state, { idPerCall: true, withholdAnswer: 1 });
  const serving = serveSession(store, 'noted', r.stream);
  r.start(key, null);
  const settling = r.settle();
  await r.until(() => r.asks.length >= 1, 'the commit asking for its ack');
  expect(r.asks[0]).toBe('ack');
  r.shutDown();
  await Promise.all([serving, settling]);
  return { r, state };
}

describe('a transaction under a cancellation either committed or did nothing, and says which', () => {
  it('1: a sweep of the signal over every answer the attempt waits for', async () => {
    const table: Swept[] = [];
    const violations: string[] = [];
    let reads = 0;
    for (let n = 1; ; n++) {
      const key = `sweep${n}`;
      // Seeded under another key, so another namespace of the page cache:
      // the sweep's attempt starts cold, and reads its pages from Restate.
      const state = await seeded(store, 'seed', `${key}-seed`);
      const r = await attempt('sweep', state, key, { lazy: true, cancelBeforeAnswer: n });
      // Past the last thing a run asks for, the signal never goes in.
      if (r.signalledAt === undefined) break;
      reads += r.asks.filter((a) => a.startsWith('read')).length;
      // The labels' premise: the transaction's send is made between its
      // commit's head write and that write's ack, so it lies between the
      // first and the second command that asks for an ack.
      const acked = r.sent().flatMap((m, i) => ((m.flags & REQUESTED_ACK) !== 0 ? [i] : []));
      const send = r.sent().findIndex((m) => m.type === TYPE.oneWayCall);
      expect(send).toBeGreaterThan(acked[0]!);
      expect(send).toBeLessThan(acked[1]!);
      const outcomes = returned(r);
      const [tx, statement, call] = outcomes.split(',');
      const stored = await rows(state, key);
      const sends = sendsOf(r, 'tx');
      const keys = new Set(sends.map((s) => s.idempotencyKey));
      table.push({ n, outstanding: phase(r, n), outcomes, rows: stored, sends: sends.length });
      const wrong = (what: string) =>
        violations.push(
          `N=${n} (${r.asks[n - 1]}): ${what}; ${outcomes}, rows ${JSON.stringify(stored)}, sends ${sends.length}, wire ${r
            .sent()
            .map((m) => m.type.toString(16))
            .join(' ')}`,
        );
      if (tx === 'ok') {
        if (!stored.includes('tx')) wrong('resolved, but its row is not stored');
        if (sends.length !== 1 || keys.size !== 1) wrong('resolved, but its send did not go out once');
      } else if (tx === 'CancelledError') {
        if (stored.includes('tx')) wrong('rejected with CancelledError, but its row is stored');
        if (sends.length !== 0) wrong('rejected with CancelledError, but its send went out');
      } else wrong(`ended with ${tx}`);
      if ((statement === 'ok') !== stored.includes('after')) wrong('the statement said one thing, the rows another');
      const cancelled = [tx, statement, call].filter((o) => o === 'CancelledError').length;
      // The call is the handler's last await: a signal that comes after its
      // answer has nothing left to fail.
      const lastAsk = r.asks.lastIndexOf('call Callee/echo') + 1;
      const owed = n <= lastAsk ? 1 : 0;
      if (cancelled !== owed) wrong(`${cancelled} CancelledError for one signal, ${owed} owed`);
      if (n > 200) throw new Error('the sweep did not end');
    }
    console.table(table.map((t) => ({ ...t, rows: t.rows.join(' ') })));
    expect(violations).toEqual([]);
    // The premise: the sweep covered reads that reached Restate, acks and
    // the call's answer.
    expect(reads, 'no read reached Restate: the page cache answered them all').toBeGreaterThan(0);
    expect(table.map((t) => t.outstanding)).toEqual(expect.arrayContaining([...ACKS, 'call Callee/echo']));
  }, 120_000);

  it('2: the body awaits a call when the signal comes: the call is cancelled, and the transaction rolls back', async () => {
    const key = 'body1';
    const state = await seeded(store, 'seed', key);
    const r = restateSide(state, { idPerCall: true, hold: ['Slow/work'] });
    const serving = serveSession(store, 'bodyCalls', r.stream);
    r.start(key, false);
    const settling = r.settle();
    await r.until(() => r.calls.length > 0, 'the call in the body');
    r.cancel();
    await Promise.all([serving, settling]);
    // The body did not get past its call; the transaction rejected.
    expect(returned(r)).toBe('not reached,CancelledError,ok');
    expect(await rows(state, key)).toEqual(['after']);
    expect(r.sends).toEqual([]);
    expect(r.cancels).toEqual([r.calls[0]!.id]);
  }, 30_000);

  it('2b: the body catches the cancellation and goes on: the transaction commits, with its send', async () => {
    const key = 'body2';
    const state = await seeded(store, 'seed', key);
    const r = restateSide(state, { idPerCall: true, hold: ['Slow/work'] });
    const serving = serveSession(store, 'bodyCalls', r.stream);
    r.start(key, true);
    const settling = r.settle();
    await r.until(() => r.calls.length > 0, 'the call in the body');
    r.cancel();
    await Promise.all([serving, settling]);
    // The body saw the one cancellation, so the transaction and the
    // statement after it work.
    expect(returned(r)).toBe('CancelledError,ok,ok');
    expect(await rows(state, key)).toEqual(['tx', 'after']);
    expect(sendsOf(r, 'tx')).toHaveLength(1);
    expect(r.cancels).toEqual([r.calls[0]!.id]);
  }, 30_000);

  it('3: a carried cancellation refuses the transaction before it begins; the next one commits', async () => {
    const key = 'carried';
    const state = await seeded(store, 'seed', key);
    const r = await attempt('two', state, key, { cancelAtStart: true });
    expect(returned(r)).toBe('CancelledError,ok,ok');
    expect(await rows(state, key)).toEqual(['second', 'after']);
    expect(sendsOf(r, 'first')).toEqual([]);
    expect(sendsOf(r, 'second')).toHaveLength(1);
    // The refused one put nothing on the wire: up to the first send, the
    // attempt wrote what one transaction writes, as a run without the
    // cancellation does up to its first transaction's send.
    const control = await attempt('two', await seeded(store, 'seed', 'carried-control'), 'carried-control');
    expect(returned(control)).toBe('ok,ok,ok');
    expect(writesBeforeSend(r)).toEqual(writesBeforeSend(control));
    expect(
      commits(
        r.sent().slice(
          0,
          r.sent().findIndex((m) => m.type === TYPE.oneWayCall),
        ),
      ),
    ).toBe(1);
  }, 30_000);

  it("4: shut down while the commit's ack is outstanding: not CancelledError, and the next attempt finds rows and send agreeing", async () => {
    const key = 'shut';
    const { r, state } = await shutAtAck(key);
    // The attempt's end, which is neither a cancellation nor terminal.
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe('CancelledError');
    expect(seen[0]).toMatch(/^AttemptShutDown/);
    expect(terminal).toEqual([false]);
    expect(outcome(r.sent())).toBeUndefined();

    // A plain retry: its open makes what the outbox holds.
    const again = await attempt('seed', state, key);
    expect(returned(again)).toBe('seeded');
    const stored = await rows(state, key);
    const sends = [...sendsOf(r, 'tx'), ...sendsOf(again, 'tx')];
    // A stored row has its send, made by one attempt or both, always with
    // the one key, so Restate makes it once; no row, no send at all.
    expect(new Set(sends.map((s) => s.idempotencyKey)).size).toBe(stored.includes('tx') ? 1 : 0);
  }, 30_000);

  // The commit's wait is the store's, in the addon: it fails with the
  // attempt's end, as an await of the driver's does (saga.test.ts, h), so a
  // handler tells a shutdown from an error of its own.
  it("4b: the commit's wait fails with AttemptShutDown, as a call's await does", async () => {
    await shutAtAck('shut2');
    expect(seen).toEqual([
      'AttemptShutDown: Restate shut the attempt down; a new attempt will run the handler from the start',
    ]);
  }, 30_000);

  it('5: a body that throws, with the signal arriving during it: no row, no send, and one CancelledError after it', async () => {
    const key = 'throws';
    const state = await seeded(store, 'seed', key);
    const gate = Promise.withResolvers<void>();
    let working = false;
    outside.work = () => {
      working = true;
      return gate.promise;
    };
    try {
      const r = restateSide(state, { idPerCall: true });
      const serving = serveSession(store, 'throws', r.stream);
      r.start(key, null);
      const settling = r.settle();
      await r.until(() => working, 'the body working outside Restate');
      r.cancel();
      await pause(20); // the attempt takes the signal in; nothing waits for it
      gate.resolve();
      await Promise.all([serving, settling]);
      // The body's own error, then the cancellation at the next await.
      expect(returned(r)).toBe('Error,CancelledError,ok');
      expect(await rows(state, key)).toEqual([]);
      expect(r.sends).toEqual([]);
    } finally {
      outside.work = () => Promise.resolve();
    }
  }, 30_000);

  it('5b: a body that throws, with the signal carried into it: refused before it begins, and nothing else fails', async () => {
    const key = 'throws2';
    const state = await seeded(store, 'seed', key);
    const r = await attempt('throws', state, key, { cancelAtStart: true });
    expect(returned(r)).toBe('CancelledError,ok,ok');
    expect(await rows(state, key)).toEqual(['after']);
    expect(r.sends).toEqual([]);
  }, 30_000);
});
