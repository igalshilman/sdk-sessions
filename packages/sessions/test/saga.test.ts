// A saga written as a session object, run on the wire (`side.ts`): its
// progress lives in `ctx.db`, every attempt resumes from what is stored, and a
// cancellation or a terminal failure compensates the steps that may have
// happened, in reverse, with idempotency keys of their own.
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import { CancelledError, TerminalError } from '@restatedev/restate-sdk';
import { serveSession } from '../src/handler.ts';
import { commits, outcome, pause, restateSide, run, TYPE, type Made, type SideOptions } from './side.ts';

/** An order's row: how far the saga got, and, once it compensates, what it undoes. */
interface Order {
  status: 'started' | 'reserved' | 'charged' | 'compensating' | 'compensated';
  undo: string | null;
}

/** Each step, and the call that undoes it. */
const UNDO: Record<string, { service: string; handler: string }> = {
  reserve: { service: 'Inventory', handler: 'release' },
  charge: { service: 'Payments', handler: 'refund' },
};

/** The steps that may have happened by `status`, last first. */
const HAPPENED: Record<string, string[]> = {
  started: ['reserve'],
  reserved: ['charge', 'reserve'],
  charged: ['charge', 'reserve'],
};

/** Work the handler does outside Restate between its two steps; a test can hold it there. */
const outside = { work: (): Promise<void> => Promise.resolve() };

/** What `place` caught, by class, on each attempt: a test reads it. */
const caught: string[] = [];

const orders = restate.sessionObject({
  name: 'Orders',
  schema: ['CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT NOT NULL, undo TEXT)'],
  handlers: {
    place: async (ctx: restate.SessionContext, id: string) => {
      // The same on every attempt: a repeated call reaches the invocation the
      // first attempt started.
      const call = (service: string, handler: string, step: string) =>
        ctx.rpc({ service, key: id, handler, input: id, idempotencyKey: `${ctx.request.id}/${step}` });
      const read = () => ctx.db.get<Order>('SELECT status, undo FROM orders WHERE id = ?', [id]);
      const record = (status: Order['status']) =>
        ctx.db.execute('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
      /** A step whose call failed terminally did not happen, and has nothing to undo. */
      let didNotHappen: string | undefined;
      const step = async (name: string, service: string, handler: string) => {
        try {
          await call(service, handler, name);
        } catch (error) {
          if (error instanceof TerminalError && !(error instanceof CancelledError)) didNotHappen = name;
          throw error;
        }
      };
      /**
       * Undo, from what is stored: a retry that finds the saga compensating
       * goes on with the same list, and calls again with the same keys.
       */
      const compensate = async () => {
        const order = await read();
        if (order === undefined || order.status === 'compensated') return;
        let undo = order.undo ?? '';
        if (order.status !== 'compensating') {
          undo = HAPPENED[order.status]!.filter((s) => s !== didNotHappen).join(',');
          await ctx.db.execute("UPDATE orders SET status = 'compensating', undo = ? WHERE id = ?", [undo, id]);
        }
        for (const s of undo.split(',').filter(Boolean)) await call(UNDO[s]!.service, UNDO[s]!.handler, `undo-${s}`);
        await record('compensated');
      };

      try {
        let order = await read();
        if (order === undefined) {
          await ctx.db.transaction((tx) => tx.execute("INSERT INTO orders (id, status) VALUES (?, 'started')", [id]));
          order = { status: 'started', undo: null };
        }
        if (order.status === 'compensating' || order.status === 'compensated') {
          throw new TerminalError(`order ${id} was cancelled`);
        }
        if (order.status === 'started') {
          await step('reserve', 'Inventory', 'reserve');
          await outside.work();
          await record('reserved');
          order.status = 'reserved';
        }
        if (order.status === 'reserved') {
          await step('charge', 'Payments', 'charge');
          await record('charged');
        }
        return 'charged';
      } catch (error) {
        caught.push(error instanceof CancelledError ? 'CancelledError' : (error as Error).name);
        // A cancellation is a TerminalError; the attempt's end (a shutdown) is
        // not, and the next attempt resumes: nothing to compensate.
        if (!(error instanceof TerminalError)) throw error;
        await compensate();
        throw error;
      }
    },
  },
  views: {
    status: async (ctx: restate.ViewContext, id: string) =>
      (await ctx.db.get<Order>('SELECT status, undo FROM orders WHERE id = ?', [id])) ?? null,
  },
});

/** The stored row of order `id`, read by a view on `state`. */
async function stored(state: Map<string, Uint8Array>, key: string, id: string): Promise<Order | null> {
  const ended = await run(orders, 'status', state, key, id);
  if (ended === undefined || !('value' in ended)) throw new Error(`status ended with ${JSON.stringify(ended)}`);
  return JSON.parse(ended.value) as Order | null;
}

/** A call as the test compares it: target, and idempotency key. */
const target = (c: Made) => `${c.service}/${c.handler} ${c.idempotencyKey}`;

/** Start `place` for order `id` on `key`, with Restate's side `options`. */
function placing(state: Map<string, Uint8Array>, key: string, id: string, options: SideOptions = {}) {
  const r = restateSide(state, { idPerCall: true, ...options });
  const serving = serveSession(orders, 'place', r.stream);
  r.start(key, id);
  const settling = r.settle();
  return { r, done: Promise.all([serving, settling]) };
}

/** Whether `r` has called `t` (`Service/handler`). */
const hasCalled = (r: ReturnType<typeof restateSide>, t: string) =>
  r.calls.some((c) => `${c.service}/${c.handler}` === t);

/** The invocation's end with a cancellation, as Restate is told it. */
const CANCELLED = { code: 409, message: 'Cancelled' };

describe('a saga in a session object', () => {
  it('a: without a cancellation, reserves and charges once each, and ends charged', async () => {
    const state = new Map<string, Uint8Array>();
    const { r, done } = placing(state, 'sa', 'o1');
    await done;
    expect(outcome(r.sent())).toEqual({ value: '"charged"' });
    expect(r.calls.map(target)).toEqual(['Inventory/reserve inv_test/reserve', 'Payments/charge inv_test/charge']);
    expect(r.cancels).toEqual([]);
    expect(await stored(state, 'sa', 'o1')).toEqual({ status: 'charged', undo: null });
  }, 30_000);

  it('b: cancelled while reserve is pending: it is cancelled, released, and the invocation ends cancelled', async () => {
    const state = new Map<string, Uint8Array>();
    const { r, done } = placing(state, 'sb', 'o1', { hold: ['Inventory/reserve'] });
    await r.until(() => hasCalled(r, 'Inventory/reserve'), 'the reserve call');
    r.cancel();
    await done;
    expect(outcome(r.sent())).toMatchObject(CANCELLED);
    expect(r.calls.map(target)).toEqual([
      'Inventory/reserve inv_test/reserve',
      'Inventory/release inv_test/undo-reserve',
    ]);
    // The cancel command names the reserve call's invocation.
    expect(r.cancels).toEqual([r.calls[0]!.id]);
    expect(await stored(state, 'sb', 'o1')).toEqual({ status: 'compensated', undo: 'reserve' });
  }, 30_000);

  it('c: cancelled while charge is pending: refunds, then releases', async () => {
    const state = new Map<string, Uint8Array>();
    const { r, done } = placing(state, 'sc', 'o1', { hold: ['Payments/charge'] });
    await r.until(() => hasCalled(r, 'Payments/charge'), 'the charge call');
    r.cancel();
    await done;
    expect(outcome(r.sent())).toMatchObject(CANCELLED);
    expect(r.calls.map(target)).toEqual([
      'Inventory/reserve inv_test/reserve',
      'Payments/charge inv_test/charge',
      'Payments/refund inv_test/undo-charge',
      'Inventory/release inv_test/undo-reserve',
    ]);
    expect(r.cancels).toEqual([r.calls[1]!.id]);
    expect(await stored(state, 'sc', 'o1')).toEqual({ status: 'compensated', undo: 'charge,reserve' });
  }, 30_000);

  it('d (known limitation): a signal on the commit of `reserved` is carried to the charge call, which is issued, rejects, and is not cancelled', async () => {
    // The commit that records `reserved` is under way when the signal comes:
    // it lands, and the cancellation is carried to the next await, the
    // `charge` call. That call is still issued — it is on the wire — and its
    // result rejects with the cancellation at once, but no cancel command is
    // sent for it, so the charge may run. The saga then compensates both
    // steps, so a charge that did run is refunded.
    // On a fresh key the attempt's commits are the schema's, `started`'s and
    // `reserved`'s: the signal goes in with the third.
    const state = new Map<string, Uint8Array>();
    const { r, done } = placing(state, 'sd', 'o1', { cancelOnCommit: 3 });
    await done;
    const sent = r.sent();
    expect(outcome(sent)).toMatchObject(CANCELLED);
    // The premise: before the signal, three commits and the reserve call;
    // the first command after it is the charge call.
    expect(commits(sent.slice(0, r.signalledAt))).toBe(3);
    const after = sent.slice(r.signalledAt).find((m) => m.type >= 0x0400 && m.type < 0x8000);
    expect(after?.type).toBe(TYPE.call);
    expect(r.calls.map(target)).toEqual([
      'Inventory/reserve inv_test/reserve',
      'Payments/charge inv_test/charge',
      'Payments/refund inv_test/undo-charge',
      'Inventory/release inv_test/undo-reserve',
    ]);
    // The stray charge: no cancel command for it, nor for anything.
    expect(r.cancels).toEqual([]);
    expect(await stored(state, 'sd', 'o1')).toEqual({ status: 'compensated', undo: 'charge,reserve' });
  }, 30_000);

  it('e: cancelled while working outside Restate: the next ctx.db call is refused, and it compensates from `started`', async () => {
    const state = new Map<string, Uint8Array>();
    const gate = Promise.withResolvers<void>();
    let working = false;
    outside.work = () => {
      working = true;
      return gate.promise;
    };
    caught.length = 0;
    try {
      const { r, done } = placing(state, 'se', 'o1');
      await r.until(() => working, 'the work between the steps');
      r.cancel();
      await pause(20); // the attempt takes the signal in; nothing waits for it
      const before = r.sent().length;
      gate.resolve();
      await done;
      expect(outcome(r.sent())).toMatchObject(CANCELLED);
      expect(caught).toEqual(['CancelledError']);
      // The refused `reserved` wrote nothing: the first command after the
      // signal is the write of `compensating`'s commit, whose row says
      // `started` was the last step recorded.
      expect(r.calls.map(target)).toEqual([
        'Inventory/reserve inv_test/reserve',
        'Inventory/release inv_test/undo-reserve',
      ]);
      expect(r.cancels).toEqual([]);
      expect(before).toBe(r.signalledAt);
      // After the signal, two commits: `compensating`'s and `compensated`'s.
      expect(commits(r.sent().slice(r.signalledAt))).toBe(2);
      expect(await stored(state, 'se', 'o1')).toEqual({ status: 'compensated', undo: 'reserve' });
    } finally {
      outside.work = () => Promise.resolve();
    }
  }, 30_000);

  it('f: a crash in the middle of compensating: the retry of the cancelled invocation finishes it, with the same keys', async () => {
    const state = new Map<string, Uint8Array>();
    const first = placing(state, 'sf', 'o1', { hold: ['Inventory/reserve', 'Inventory/release'] });
    await first.r.until(() => hasCalled(first.r, 'Inventory/reserve'), 'the reserve call');
    first.r.cancel();
    await first.r.until(() => hasCalled(first.r, 'Inventory/release'), 'the release call');
    // `compensating` was committed before `release` was called.
    first.r.shutDown();
    await first.done;
    expect(outcome(first.r.sent())).toBeUndefined();
    expect(await stored(state, 'sf', 'o1')).toEqual({ status: 'compensating', undo: 'reserve' });

    const second = placing(state, 'sf', 'o1', { cancelAtStart: true });
    caught.length = 0;
    await second.done;
    // Its first await, the read of the stored state, got the cancellation.
    expect(caught).toEqual(['CancelledError']);
    expect(outcome(second.r.sent())).toMatchObject(CANCELLED);
    expect(second.r.calls.map(target)).toEqual(['Inventory/release inv_test/undo-reserve']);
    expect(second.r.calls[0]!.idempotencyKey).toBe(first.r.calls[1]!.idempotencyKey);
    expect(await stored(state, 'sf', 'o1')).toEqual({ status: 'compensated', undo: 'reserve' });
  }, 30_000);

  it('g: a step that fails terminally: only the step before it is undone, and the invocation ends with that failure', async () => {
    const state = new Map<string, Uint8Array>();
    const { r, done } = placing(state, 'sg', 'o1', { fail: { 'Payments/charge': { code: 402, message: 'declined' } } });
    await done;
    expect(outcome(r.sent())).toEqual({ code: 402, message: 'declined' });
    expect(r.calls.map(target)).toEqual([
      'Inventory/reserve inv_test/reserve',
      'Payments/charge inv_test/charge',
      'Inventory/release inv_test/undo-reserve',
    ]);
    expect(r.cancels).toEqual([]);
    expect(await stored(state, 'sg', 'o1')).toEqual({ status: 'compensated', undo: 'reserve' });
  }, 30_000);

  it('h: shut down while reserve is outstanding: no compensation, and the next attempt resumes with the same key', async () => {
    const state = new Map<string, Uint8Array>();
    caught.length = 0;
    const first = placing(state, 'sh', 'o1', { hold: ['Inventory/reserve'] });
    await first.r.until(() => hasCalled(first.r, 'Inventory/reserve'), 'the reserve call');
    first.r.shutDown();
    await first.done;
    // The await failed with the attempt's end, which is no TerminalError.
    expect(caught).toEqual(['AttemptShutDown']);
    expect(outcome(first.r.sent())).toBeUndefined();
    expect(first.r.calls.map(target)).toEqual(['Inventory/reserve inv_test/reserve']);
    expect(await stored(state, 'sh', 'o1')).toEqual({ status: 'started', undo: null });

    const second = placing(state, 'sh', 'o1');
    await second.done;
    expect(outcome(second.r.sent())).toEqual({ value: '"charged"' });
    expect(second.r.calls.map(target)).toEqual([
      'Inventory/reserve inv_test/reserve',
      'Payments/charge inv_test/charge',
    ]);
    expect(second.r.calls[0]!.idempotencyKey).toBe(first.r.calls[0]!.idempotencyKey);
    expect(await stored(state, 'sh', 'o1')).toEqual({ status: 'charged', undo: null });
  }, 30_000);
});
