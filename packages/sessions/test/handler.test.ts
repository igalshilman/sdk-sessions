// A session object's handler served on the explicit recovery VM
// (`src/handler.ts`), with Restate's side played by wire bytes: no SDK
// endpoint, and a real `ctx.db` over the object's state.
//
// The assertions name what only this path does — the state read and written
// in the addon, a commit whose head write carries its own sync, and no run in
// the journal.
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import { database, HEAD_KEY, start } from '@restatedev/sessions/internal';
import { CancelledError } from '@restatedev/restate-sdk';
import { serveSession, servedHere } from '../src/handler.ts';
import { commits, pause, restateSide, said, seeded as seededBy, text, TYPE } from './side.ts';
import { decode } from './wire.ts';
import { REQUESTED_ACK, V8 } from './vm-support.ts';

/**
 * The state an earlier invocation of `key` left: its schema is applied. On a
 * key never written, an attempt's first commit is the schema's, made as the
 * session opens, and that is the one `cancelOnCommit` would land on. After
 * this, it is the handler's own.
 */
const seeded = (key: string) => seededBy(notes, 'add', key, 'seed');

/** What `cleansUp` saw once its attempt was shut down: nothing such an attempt returns is written. */
const afterShutDown: string[] = [];
/** Lets `cleansUp` go on, once it is waiting. */
let goOn: (() => void) | undefined;

const notes = restate.sessionObject({
  name: 'Notes',
  schema: ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)'],
  handlers: {
    add: async (ctx: restate.SessionContext, body: string) => {
      await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', [body]);
      const row = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notes');
      return row!.n;
    },
    /** Starts a call and returns without awaiting its result, as `start` does. */
    starts: async (ctx: restate.SessionContext) => {
      return await start(ctx, { service: 'Callee', key: 'k', handler: 'echo', input: 'x' });
    },
    /** Commits, and says what its failure was if it did not. */
    commits: async (ctx: restate.SessionContext) => {
      try {
        await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', ['x']);
        return 'committed';
      } catch (error) {
        return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
      }
    },
    /**
     * A commit, work outside Restate long enough for a cancellation to land
     * with nothing waiting, then two reads: of pages the commit left in the
     * session, so they ask Restate nothing.
     */
    commitThenReads: async (ctx: restate.SessionContext) => {
      const commit = await said(() => ctx.db.execute('INSERT INTO notes (body) VALUES (?)', ['a']));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const read = () => ctx.db.get('SELECT count(*) AS n FROM notes');
      return `${commit},${await said(read)},${await said(read)}`;
    },
    /**
     * Works outside Restate until the test lets it go on, then cleans up with
     * its database and a call, and notes how each ended.
     */
    cleansUp: async (ctx: restate.SessionContext) => {
      await new Promise<void>((resolve) => (goOn = resolve));
      const db = await said(() => ctx.db.execute('INSERT INTO notes (body) VALUES (?)', ['x']));
      const call = await said(() => ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' }));
      afterShutDown.push(`${db},${call}`);
      return 'unwritten';
    },
    /** A commit, then a call: which of the two a cancellation failed. */
    commitThenCall: async (ctx: restate.SessionContext) => {
      const commit = await said(() => ctx.db.execute('INSERT INTO notes (body) VALUES (?)', ['x']));
      const call = await said(() => ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' }));
      return `${commit},${call}`;
    },
    /** Two commits, each reporting whether it failed and how. */
    twice: async (ctx: restate.SessionContext) => {
      const once = async () => {
        try {
          await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', ['x']);
          return 'ok';
        } catch (error) {
          return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
        }
      };
      return `${await once()},${await once()}`;
    },
    /**
     * A commit, work outside Restate long enough for a cancellation to land
     * with nothing waiting, then another commit.
     */
    twoCommits: async (ctx: restate.SessionContext) => {
      const commit = async (body: string) => {
        try {
          await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', [body]);
          return 'ok';
        } catch (error) {
          return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
        }
      };
      const first = await commit('a');
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A transaction, so the commit has sends of its own: they are made in
      // the hook between its head write and the wait for that write's ack.
      try {
        await ctx.db.transaction(async (tx) => {
          await tx.execute('INSERT INTO notes (body) VALUES (?)', ['b']);
          tx.send({ service: 'Shipping', key: 'b', handler: 'ship', input: 'b' });
        });
        return `${first},ok`;
      } catch (error) {
        return `${first},${error instanceof CancelledError ? 'CancelledError' : (error as Error).name}`;
      }
    },
    /**
     * The same, with calls of Restate instead of the database: a carried
     * cancellation has to reach the call's result, which is what a handler
     * awaits, rather than the invocation id it makes first.
     */
    callTwice: async (ctx: restate.SessionContext) => {
      // The signal has to land with nothing in flight, or the first call is
      // rejected where it waits and the carry is never exercised.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const once = async () => {
        try {
          return String(await ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' }));
        } catch (error) {
          return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
        }
      };
      return `${await once()},${await once()}`;
    },
    /** A send first, which makes an invocation id and nothing else: it must
     * not swallow the carried cancellation that the call after it is owed. */
    sendThenCall: async (ctx: restate.SessionContext) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ctx.send({ service: 'Callee', key: 'a', handler: 'echo', input: 'S' });
      try {
        return String(await ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' }));
      } catch (error) {
        return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
      }
    },
    /** A database of its own, beside the object's: its keys are named apart. */
    beside: async (ctx: restate.SessionContext) => {
      const own = database(ctx.db, 'notes2');
      await own.execute('CREATE TABLE IF NOT EXISTS n (id INTEGER PRIMARY KEY)');
      await own.execute('INSERT INTO n (id) VALUES (1)');
      const row = await own.get<{ n: number }>('SELECT count(*) AS n FROM n');
      return row!.n;
    },
    /** A send with a delay given as a `Duration`, not milliseconds. */
    sends: async (ctx: restate.SessionContext) => {
      ctx.send({ service: 'Callee', key: 'k', handler: 'echo', input: 'x', delay: { seconds: 30 } });
      return 'sent';
    },
    /**
     * Two calls awaited at once, each waiting on Restate. This is the
     * selector's reason to exist: the SDK's own loop lets one promise wait on
     * the server at a time. Two `ctx.db` reads would not show it — the
     * database runs its calls one at a time, so they never wait together.
     */
    both: async (ctx: restate.SessionContext) => {
      const [a, b] = await Promise.all([
        ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' }),
        ctx.rpc({ service: 'Callee', key: 'b', handler: 'echo', input: 'B' }),
      ]);
      return `${String(a)}${String(b)}`;
    },
  },
  views: {
    /** A view reads beside the handlers, in its own session, and writes nothing. */
    count: async (ctx: restate.ViewContext) => {
      const row = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notes');
      return row?.n ?? -1;
    },
  },
});

/**
 * Run `cleansUp` on `key` until Restate shuts its attempt down, after a
 * cancellation that nothing was waiting for if `cancelFirst`; what its
 * clean-up saw.
 */
async function shutDown(key: string, cancelFirst: boolean): Promise<string | undefined> {
  goOn = undefined;
  const r = restateSide();
  const serving = serveSession(notes, 'cleansUp', r.stream);
  r.start(key, null);
  const settling = r.settle();
  // The session opened, and the handler is working outside Restate.
  await pause(50);
  expect(goOn, 'the handler is waiting').toBeDefined();
  if (cancelFirst) {
    r.cancel();
    await pause(20); // nothing waits: the cancellation is carried
  }
  r.shutDown();
  await pause(20); // the attempt is over
  goOn!();
  await serving;
  await settling;
  return afterShutDown.pop();
}

describe('a session object served on the explicit recovery VM', () => {
  it('serves only the protocol versions the VM accepts', () => {
    expect(servedHere({ 'content-type': V8 })).toBe(true);
    expect(servedHere({ 'content-type': 'application/vnd.restate.invocation.v7' })).toBe(true);
    expect(servedHere({ 'content-type': 'application/vnd.restate.invocation.v6' })).toBe(false);
    expect(servedHere({})).toBe(false);
  }, 30_000);

  it('runs a handler, commits its database, and answers', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'add', r.stream);
    r.start('k1', 'first');
    await r.settle();
    await serving;

    expect(r.head?.status).toBe(200);
    expect(r.ended).toBe(true);
    const sent = r.sent();
    const output = sent.find((m) => m.type === TYPE.output);
    expect(output).toBeDefined();
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('1');
    expect(sent.at(-1)?.type).toBe(TYPE.end);

    // What only this path does: the state never crosses into JavaScript. The
    // addon reads and writes it as the VM's own commands, and a commit is the
    // tail, then the head written *with* its sync — one acked write, and no
    // `v22/sync` clear, which is how a store in JavaScript asks for the same.
    const acked = sent.filter((m) => m.type === TYPE.setState && (m.flags & REQUESTED_ACK) !== 0);
    expect(acked.map((m) => text(m.fields.get(1)![0] as Uint8Array))).toEqual(['v22/head', 'v22/head']);
    expect(sent.some((m) => m.type === TYPE.clearState)).toBe(false);
    expect(sent.some((m) => m.type === TYPE.run)).toBe(false);

    // The database landed in the object's state.
    expect([...r.state.keys()].some((k) => k.startsWith('v22/'))).toBe(true);
  }, 30_000);

  it('a cancellation does not fail a commit already under way: its head is out, and it lands', async () => {
    // The signal arrives while the commit waits for the ack of its head
    // write. Failing that wait reported a commit as cancelled that landed, so
    // a handler could not tell from `CancelledError` whether its write
    // happened. The commit runs to its end and says so; the cancellation is
    // owed to the handler's next await, and this handler has none.
    const state = await seeded('k5');
    const r = restateSide(state, { cancelOnCommit: true });
    const serving = serveSession(notes, 'commits', r.stream);
    r.start('k5', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"committed"');
    expect(state.has(HEAD_KEY)).toBe(true);
    // The premise: the attempt made one commit, the handler's, so that is
    // the one the signal landed on.
    expect(commits(r.sent())).toBe(1);
    // And what it committed is there to read: the seed's row, and this one.
    const after = restateSide(state);
    const reading = serveSession(notes, 'add', after.stream);
    after.start('k5', 'third');
    await after.settle();
    await reading;
    const count = after.sent().find((m) => m.type === TYPE.output);
    expect(text(decode(count!.fields.get(14)![0] as Uint8Array).get(1)![0] as Uint8Array)).toBe('3');
  }, 30_000);

  it('a cancellation that lands on a commit in flight is delivered once, to the await after it', async () => {
    // One signal, and the handler sees one `CancelledError`. The driver and
    // the addon once each decided whether to carry it: the addon failed the
    // commit, the driver carried its own to the call, and the handler saw
    // two.
    const r = restateSide(await seeded('k6'), { cancelOnCommit: true });
    const serving = serveSession(notes, 'commitThenCall', r.stream);
    r.start('k6', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"ok,CancelledError"');
    // The premise: the attempt made one commit, the handler's, so that is
    // the one the signal landed on.
    expect(commits(r.sent())).toBe(1);
  }, 30_000);

  it('once the attempt is shut down, a carried cancellation is not delivered: the attempt is over', async () => {
    // What the handler does after a shutdown fails with the attempt's end,
    // and the attempt that follows gets the cancellation. A `CancelledError`
    // there is terminal to whatever cleans up, for an invocation that will
    // be retried.
    const without = await shutDown('ks1', false);
    const carried = await shutDown('ks2', true);
    expect(carried).not.toContain('CancelledError');
    expect(carried).toBe(without);
    expect(without).toMatch(/,AttemptShutDown$/);
  }, 30_000);

  it('a view reads, and writes nothing: its sync has nothing to store', async () => {
    const state = new Map<string, Uint8Array>();
    const writer = restateSide(state);
    const writing = serveSession(notes, 'add', writer.stream);
    writer.start('k8', 'first');
    await writer.settle();
    await writing;
    const stored = new Map(state);

    const r = restateSide(state);
    const serving = serveSession(notes, 'count', r.stream);
    r.start('k8', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('1');
    // `VmStore` refuses a reader's writes and syncs it at once, so the view
    // sends no state command and leaves the object's state as it found it.
    expect(r.sent().some((m) => m.type === TYPE.setState || m.type === TYPE.clearState)).toBe(false);
    expect([...state.keys()].toSorted()).toEqual([...stored.keys()].toSorted());
  }, 30_000);

  it('a retry of a cancelled invocation fails its first call, and works after it', async () => {
    // The cancel signal is among the earlier attempts' entries, so the VM
    // knows before the handler starts and nothing is in flight to reject.
    // The selector's path fails the first call all the same
    // (`cancellation.test.ts`, "a retry of a cancelled invocation"), so a
    // cancellation nothing was waiting for is carried to the next wait.
    const r = restateSide(new Map(), { cancelAtStart: true });
    const serving = serveSession(notes, 'twice', r.stream);
    r.start('k7', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"CancelledError,ok"');
  }, 30_000);

  it('a read that asks Restate nothing sees a carried cancellation too, once', async () => {
    // A read of pages the session holds is answered in the addon without a
    // wait on Restate, so a cancellation delivered at the store's waits had
    // nothing to land on. It is delivered where the handler calls.
    const r = restateSide();
    const serving = serveSession(notes, 'commitThenReads', r.stream);
    r.start('kr', null);
    let sentAtCancel = Infinity;
    const landing = setTimeout(() => {
      sentAtCancel = r.sent().length;
      r.cancel();
    }, 150);
    await r.settle();
    clearTimeout(landing);
    await serving;
    const sent = r.sent();
    const output = sent.find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"ok,CancelledError,ok"');
    // The premise: the reads after the signal asked Restate for nothing.
    expect(sent.slice(sentAtCancel).map((m) => m.type)).toEqual([TYPE.output, TYPE.end]);
  }, 30_000);

  it('a carried cancellation fails the next call of the database before it writes or sends anything', async () => {
    // A call that fails with `CancelledError` did nothing: a handler that
    // compensates on it, or makes the call again, would otherwise be acting
    // on a write that did happen. The cancellation is delivered where the
    // handler calls, before the call issues a command.
    const state = new Map<string, Uint8Array>();
    const r = restateSide(state);
    const serving = serveSession(notes, 'twoCommits', r.stream);
    r.start('kc', null);
    // While the handler works outside Restate, between its two commits.
    let sentAtCancel = Infinity;
    const landing = setTimeout(() => {
      sentAtCancel = r.sent().length;
      r.cancel();
    }, 150);
    await r.settle();
    clearTimeout(landing);
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"ok,CancelledError"');
    // The cancelled transaction put nothing on the wire: no page, no head,
    // no send. Counting commits would count the schema's too, so this asserts
    // what came after the signal went in: the handler's output, and before it
    // no command at all.
    const sent = r.sent();
    const written = sent
      .filter((m) => m.type === TYPE.setState)
      .map((m) => ({ key: text(m.fields.get(1)![0] as Uint8Array)!, acked: (m.flags & REQUESTED_ACK) !== 0 }));
    expect(sentAtCancel, 'the signal went in before the handler ended').toBeLessThan(sent.length);
    const after = sent.slice(sentAtCancel).filter((m) => m.type >= 0x0400 && m.type < 0x8000);
    expect(
      after.map((m) => m.type),
      'the cancelled transaction issued commands',
    ).toEqual([TYPE.output]);
    // Its sends are made in the hook between a commit's head write and the
    // wait for that write's ack, so they are the first thing to escape a
    // commit that is failed late.
    expect(
      sent.some((m) => m.type === TYPE.oneWayCall),
      "the cancelled transaction's sends went out",
    ).toBe(false);
    // Every head write asks for its own ack: that ack is the commit's sync.
    expect(written.filter((w) => w.key === HEAD_KEY).every((w) => w.acked)).toBe(true);
  }, 30_000);

  it("a retry's carried cancellation fails the call's result, not the id it makes first", async () => {
    // A call makes the invocation id's promise before the result's. Handing
    // the carry to the id let the call run to completion and the handler see
    // `ok` — the cancellation lost.
    const r = restateSide(new Map(), { cancelAtStart: true });
    const serving = serveSession(notes, 'callTwice', r.stream);
    r.start('k8', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"CancelledError,A"');
  }, 30_000);

  it('a send does not swallow the cancellation the call after it is owed', async () => {
    const r = restateSide(new Map(), { cancelAtStart: true });
    const serving = serveSession(notes, 'sendThenCall', r.stream);
    r.start('k9', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"CancelledError"');
  }, 30_000);

  it('a database beside the object keeps its keys apart, as the addon names them', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'beside', r.stream);
    r.start('k6', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('1');
    // `VmStore::key` reimplements `beside` in Rust; these are the keys the
    // JavaScript store would have written, so the two cannot drift apart.
    // `beside('notes2')` puts the name after the format's prefix, so
    // `v22/head` becomes `v22/db/notes2/head`. The object's own database is
    // open too (it has a schema), and keeps its keys unprefixed.
    const written = [...r.state.keys()].toSorted();
    expect(written).toContain('v22/db/notes2/head');
    expect(written).toContain('v22/head');
    expect(written.every((k) => k.startsWith('v22/'))).toBe(true);
  }, 30_000);

  it('a handler that starts a call and returns leaves no unhandled rejection', async () => {
    // The call's result is never answered and rejects when the attempt ends.
    // Nothing holds it — `start` awaits only the invocation id — so an
    // unhandled rejection here would bring the process down. Vitest fails the
    // run on one, which is the assertion.
    const r = restateSide();
    const serving = serveSession(notes, 'starts', r.stream);
    r.start('k3', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"inv_started"');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }, 30_000);

  it('a send takes a Duration delay, not only milliseconds', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'sends', r.stream);
    r.start('k4', null);
    await r.settle();
    await serving;
    const sent = r.sent().find((m) => m.type === TYPE.oneWayCall);
    expect(sent).toBeDefined();
    // `invoke_time` is absolute: 30 seconds from now, not 0 and not NaN.
    const at = Number(sent!.fields.get(4)![0]);
    expect(at).toBeGreaterThan(Date.now() + 20_000);
    const output = r.sent().find((m) => m.type === TYPE.output);
    expect(output?.fields.get(14)).toBeDefined();
  }, 30_000);

  it('awaits two calls of Restate at once, which the selector existed to allow', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'both', r.stream);
    r.start('k2', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    // Both answered, in the order the handler put them.
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"AB"');
  }, 30_000);
});
