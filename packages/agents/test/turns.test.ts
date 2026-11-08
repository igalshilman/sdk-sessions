// Turns of the conversation of turns, on a made-up framework (fakes/items.ts):
// the call records a closed turn reports, crashes at every state request, and
// what an agent on the store has (`settle`, `compact`, `erase`, `window` and
// `budget`).
import * as restate from '@restatedev/sessions';
import { invoke } from '@restatedev/sessions/internal';
import { fakeContext, type Made } from '@restatedev/sessions/test/support';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { call, chatHandler, sessionObject, type Tool } from '@restatedev/agents';
import { callOf, forPrompt, outcomes } from '../src/calls.ts';
import { CANCELLED, ENDED, RETURNED_UNRECORDED, stopSignalOf, toolCallEnded, toolCallStarted } from '../src/common.ts';
import { answerOnce, Conversation, type Run, STEPS, SUMMARY, type Turn } from '../src/conversation.ts';
import { conversationView } from '../src/messages.ts';
import { waitFor } from '../src/tools.ts';
import { bank } from './bank.ts';
import { ledger } from '@restatedev/sessions/test/ledger';
import { calling, FakeItems, type Item, ITEMS } from './fakes/items.ts';
import { conversation as banking, followingOf, handlerOf, sqlAttempt } from './support.ts';

/** The results a turn stored, by their calls' ids. */
const resultsOf = (conversation: Conversation<Item>) =>
  Object.fromEntries(
    conversation.entries.flatMap((e) => (e.parsed?.results ?? []).map((r) => [r.id, r.output] as const)),
  );

/**
 * What a turn stopped right after `wait` stores as the result of its tool
 * call `c1`: `wait` runs in the turn's attempt, whose companion answers a
 * wait with `no`, and its `lookups` with `found`.
 */
async function closedResult(wait: (ctx: restate.SessionContext) => Promise<void>) {
  const map = new Map<string, Uint8Array>();
  const sql = sqlAttempt({ map, key: 'k', id: 'inv_stopped', signal: () => 'no', route: async () => 'found' });
  await expect(
    sql.end(() =>
      answerOnce(sql.ctx, 'q', ITEMS, async (conversation) => {
        await conversation.turn.appendReply([calling('c1')]);
        await wait(sql.ctx);
        // The turn is stopped before the call's result is stored.
        throw new restate.CancelledError();
      }),
    ),
  ).rejects.toBeInstanceOf(restate.CancelledError);
  const read = sqlAttempt({ map, key: 'k', id: 'read' });
  return resultsOf(await read.end(() => Conversation.load(read.ctx.db, ITEMS))).c1;
}

const lookup = call(restate.service({ name: 'lookups', handlers: { lookup: async () => 'found' } }), 'lookup', {
  description: 'Look it up.',
  input: z.object({ about: z.string() }),
});

describe("a closed turn's calls", () => {
  it('report a call that returned as done, not cancelled', async () => {
    expect(await closedResult(async (ctx) => (await callOf(ctx, 'lookup', {}, 'c1')).answered())).toBe(
      RETURNED_UNRECORDED,
    );
  });

  it('report a call that failed with its error', async () => {
    expect(
      await closedResult(async (ctx: restate.SessionContext) =>
        (await callOf(ctx, 'lookup', {}, 'c1')).answered('Error: no'),
      ),
    ).toBe('Error: no');
  });

  it('do not report a call another prompt of the invocation made, with the same id, as theirs', async () => {
    const sql = sqlAttempt({ map: new Map(), key: 'k', id: 'inv1' });
    const found = await sql.end(async () => {
      await forPrompt(sql.ctx, 'inv1', async () => (await callOf(sql.ctx, 'lookup', {}, 'c1')).answered());
      return outcomes(sql.ctx, ['c1'], 'inv1', 'inv1:2');
    });
    expect([...found]).toEqual([]);
  });

  it('report a call that never returned as cancelled', async () => {
    expect(await closedResult(async (ctx) => void (await callOf(ctx, 'lookup', {}, 'c1')))).toBe(CANCELLED);
  });

  it('do not report a call done because its approval returned', async () => {
    expect(
      await closedResult(async (ctx: restate.SessionContext) => {
        expect(await waitFor(ctx, 'c1', 'approval', { refund: 5 }, { approval: true })).toBe('no');
      }),
    ).toBe(CANCELLED);
  });

  it('report a call done once the result it waited for returned', async () => {
    expect(
      await closedResult(async (ctx: restate.SessionContext) => {
        expect(await waitFor(ctx, 'c1', 'lookup', { about: 'x' })).toBe('no');
      }),
    ).toBe(RETURNED_UNRECORDED);
  });

  it("report an approved call done once its own Restate call returned, whatever its approval's", async () => {
    expect(
      await closedResult(async (ctx: restate.SessionContext) => {
        await waitFor(ctx, 'c1', 'approval', { refund: 5 }, { approval: true });
        await lookup.run({ about: 'x' }, { ctx, callId: 'c1' });
      }),
    ).toBe(RETURNED_UNRECORDED);
  });

  it('keep a returned call until its result is stored, and forget it once it is', async () => {
    const map = new Map<string, Uint8Array>();
    const made: Made[] = [];
    const args = { about: 'o1' };
    let attempts = 0;
    const run: Run<Item> = async (conversation) => {
      const ctx = contexts.at(-1)!;
      attempts += 1;
      if (attempts === 1) {
        await conversation.turn.appendReply([
          { role: 'assistant', text: '', calls: [{ id: 't1', name: lookup.name, input: args }] },
        ]);
        await toolCallStarted(ctx);
        await lookup.run(args, { ctx, callId: 't1' });
        await toolCallEnded(ctx); // a publish: the calls whose results are stored are forgotten
        throw new Error('the process crashed before the result was stored');
      }
      // The framework drops the cut-off reply, and the model makes the call again under a new id.
      await conversation.turn.drop(conversation.turn.replies()[0]!);
      await conversation.turn.appendReply([
        { role: 'assistant', text: '', calls: [{ id: 't2', name: lookup.name, input: args }] },
      ]);
      await toolCallStarted(ctx);
      const output = await lookup.run(args, { ctx, callId: 't2' });
      await conversation.turn.append({ result: 't2', output });
      await toolCallEnded(ctx);
      await conversation.turn.appendReply([{ role: 'assistant', text: 'shipped' }]);
      return 'shipped';
    };
    const contexts: restate.SessionContext[] = [];
    const attempt = () => {
      const sql = sqlAttempt({
        map,
        key: 'k',
        id: 'inv_crashed',
        route: async (c) => {
          made.push(c);
          return 'found';
        },
      });
      contexts.push(sql.ctx);
      return sql.end(() => answerOnce(sql.ctx, 'where is o1?', ITEMS, run));
    };
    const records = async () => {
      const sql = sqlAttempt({ map, key: 'k', id: 'read' });
      const row = await sql.end(() => sql.ctx.db.get<{ calls: string }>('SELECT calls FROM restate_agent_calls'));
      return row ? (JSON.parse(row.calls) as unknown[]) : [];
    };
    await expect(attempt()).rejects.toThrow('crashed');
    // The call returned, but its result is not stored: it is kept.
    expect(await records()).toHaveLength(1);
    expect(await attempt()).toBe('shipped');
    // The retry, under a new id, reached the same Restate call; and once its result is stored, it is forgotten.
    expect(made.map((m) => m.idempotencyKey)).toEqual(['inv_crashed:t1', 'inv_crashed:t1']);
    expect(await records()).toEqual([]);
  });
});

/**
 * A made-up framework's run, with `tools` and a model that, asked with the
 * conversation's history, calls the tool its prompt asks for or answers with
 * the last result: a stored final reply is answered without asking the model,
 * and the open calls of a cut-off reply run again with their ids. Its tool
 * calls publish as they end, unless `quiet` (as an agent in the background).
 */
function teller(tools: Tool[], asked: { count: number } = { count: 0 }, quiet = false) {
  const model = (history: Item[]): Item => {
    asked.count += 1;
    const last = history.at(-1)!;
    if (last.result !== undefined) return { role: 'assistant', text: `Done: ${last.output}` };
    const transfer = /move (\d+) from (\d+) to (\d+)/.exec(last.text ?? '');
    if (transfer) {
      const [, amount, from, to] = transfer.map(Number);
      const input = { from, to, amount };
      return { role: 'assistant', text: 'On it.', calls: [{ id: `t${history.length}`, name: 'transfer', input }] };
    }
    return { role: 'assistant', text: '', calls: [{ id: `a${history.length}`, name: 'audit', input: {} }] };
  };
  return (ctx: restate.SessionContext): Run<Item> =>
    async (conversation) => {
      const turn = conversation.turn;
      for (;;) {
        const final = turn.finalReply();
        if (final !== undefined) return final;
        const open = turn.openCalls();
        if (open.length === 0) {
          await turn.appendReply([model(conversation.history())]);
          continue;
        }
        for (const c of open) {
          await toolCallStarted(ctx);
          const output = await tools.find((t) => t.name === c.name)!.run(c.input, { ctx, callId: c.id });
          await turn.append({ result: c.id, output });
          if (!quiet) await toolCallEnded(ctx);
        }
      }
    };
}

/** The bank agent on the made-up framework, its model asked `asked.count` times. */
const tellerAgent = (asked?: { count: number }) => {
  const run = teller(bank('teller'), asked);
  return chatHandler((ctx, message) => answerOnce(ctx, message, ITEMS, run(ctx)));
};

describe('a call whose result a turn stored', () => {
  it('is forgotten as the turn ends, with no publish after', async () => {
    const map = new Map<string, Uint8Array>();
    const sql = sqlAttempt({ map, key: 'k', id: 'inv_quiet', route: async () => 'found' });
    await sql.end(() =>
      answerOnce(sql.ctx, 'q', ITEMS, async (conversation) => {
        await conversation.turn.appendReply([
          { role: 'assistant', text: '', calls: [{ id: 't1', name: lookup.name, input: {} }] },
        ]);
        const output = await lookup.run({ about: 'x' }, { ctx: sql.ctx, callId: 't1' });
        await conversation.turn.append({ result: 't1', output });
        return 'done';
      }),
    );
    const read = sqlAttempt({ map, key: 'k', id: 'read' });
    const row = await read.end(() => read.ctx.db.get<{ calls: string }>('SELECT calls FROM restate_agent_calls'));
    expect(JSON.parse(row!.calls)).toEqual([]);
  });
});

describe('the bank agent on the made-up framework', () => {
  it('answers a message once after a crash at any of its state requests', async () => {
    const messages = conversationView(ITEMS);
    const clean = banking(tellerAgent(), 'clean');
    await clean.attempt('inv0', 'Please move 1 from 3 to 4');
    await clean.attempt('inv1', 'Please move 5 from 1 to 2');
    const expected = (await clean.read(messages, {})).messages;
    const wrong: string[] = [];
    for (let n = 1; ; n += 1) {
      const asked = { count: 0 };
      const c = banking(tellerAgent(asked), 'anywhere');
      await c.attempt('inv0', 'Please move 1 from 3 to 4');
      const before = asked.count;
      if ((await c.attempt('inv1', 'Please move 5 from 1 to 2', n)) !== 'crashed') break;
      const answer = await c.attempt('inv1', 'Please move 5 from 1 to 2').catch((error: unknown) => String(error));
      const seen = (await c.read(messages, {})).messages;
      // The model is asked twice for the prompt (the transfer, then the answer), and once more at most:
      // for a reply the crash cut off before it was stored.
      const ok =
        answer === 'Done: moved 5 from account 1 to account 2' &&
        c.ledger.transfers.size === 2 &&
        JSON.stringify(seen) === JSON.stringify(expected) &&
        asked.count - before <= 3;
      if (!ok) wrong.push(`${n}: ${answer}, ${c.ledger.transfers.size} transfers, asked ${asked.count - before}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('answers a stored final reply without asking the model again', async () => {
    const asked = { count: 0 };
    const map = new Map<string, Uint8Array>();
    const run = teller([], asked);
    // The model's final reply is stored, then the attempt dies before the turn's answer is.
    const first = sqlAttempt({ map, key: 'k', id: 'inv_final' });
    await expect(
      first.end(() =>
        answerOnce(first.ctx, 'hello', ITEMS, async (conversation) => {
          await conversation.turn.appendReply([{ role: 'assistant', text: 'Hi there' }]);
          throw new Error('crashed');
        }),
      ),
    ).rejects.toThrow('crashed');
    const next = sqlAttempt({ map, key: 'k', id: 'inv_final' });
    expect(await next.end(() => answerOnce(next.ctx, 'hello', ITEMS, run(next.ctx)))).toBe('Hi there');
    expect(asked.count).toBe(0);
  });
});

/** The books' audit, as a Restate call: made once, however often its tool call runs. */
const audit = call(ledger, 'audit', { name: 'audit', description: 'Check the books.', key: 'bank' });

describe('an invocation that prompts twice', () => {
  it("makes each prompt's call, the same tool and input, as its own, however a crash cuts it", async () => {
    // Its tool calls do not publish as they end (as an agent in the background's): a call is forgotten
    // as its turn ends, after its answer is stored.
    const run = teller([audit], undefined, true);
    const handler = async (ctx: restate.SessionContext, message: string) => {
      const first = await answerOnce(ctx, message, ITEMS, run(ctx));
      return `${first} / ${await answerOnce(ctx, `${message}, again`, ITEMS, run(ctx))}`;
    };
    const done = 'Done: {"accounts":8,"total":8000,"transfers":0,"inconsistent":0}';
    const wrong: string[] = [];
    let crashes = 0;
    for (let n = 1; ; n += 1) {
      const c = banking(handler, 'anywhere');
      if ((await c.attempt('inv1', 'audit the books', n)) !== 'crashed') break;
      crashes++;
      const answer = await c.attempt('inv1', 'audit the books');
      // Each prompt's audit is a tool call of its own (`a1`, then `a5`), with its own idempotency key.
      const keys = [...new Set(c.calls.map((m) => m.idempotencyKey))];
      if (answer !== `${done} / ${done}` || keys.join() !== 'inv1:a1,inv1:a5') wrong.push(`${n}: ${keys.join()}`);
    }
    expect(crashes).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });
});

/** An agent on the store, with a made-up framework that answers `fine`, and the calls its handlers make. */
function storeAgent(
  options: { budget?: number; summarize?: (ctx: restate.SessionContext, request: string) => Promise<string> } = {},
) {
  const agent = sessionObject({
    name: 'keeper',
    ...options,
    handlers: {
      chat: chatHandler((ctx, message) =>
        answerOnce(ctx, message, ITEMS, async (conversation) => {
          if (message === 'die') {
            await conversation.turn.appendReply([calling('c1')]);
            throw new Error('the invocation is gone');
          }
          return `fine: ${message}`;
        }),
      ),
    },
    views: { messages: conversationView(ITEMS) },
  });
  const map = new Map<string, Uint8Array>();
  const calls: Made[] = [];
  const sends: Made[] = [];
  let n = 0;
  const run = (handler: string, input?: unknown, id = `inv_${++n}`) =>
    invoke(agent, handler, fakeContext({ map, service: 'keeper', key: 'alice', id, calls, sends }), input);
  return { agent, run, calls, sends, map };
}

/** What an agent whose `messages` view is on the made-up framework's items answers on `items`. */
function answeredWith(items: FakeItems) {
  const agent = sessionObject({
    name: 'mixed',
    handlers: { chat: chatHandler((ctx, message) => answerOnce(ctx, message, items, async () => 'fine')) },
    views: { messages: conversationView(ITEMS) },
  });
  const ctx = fakeContext({ map: new Map(), service: 'mixed', key: 'alice', id: 'inv1', calls: [], sends: [] });
  return invoke(agent, 'chat', ctx, 'hi') as Promise<string>;
}

/** A summary, as an agent's `summarize` gives one. */
const summarize = async () => 'a summary';

/** A `messages` view of your own, not the conversation of turns'. */
const yours = async () => ({ messages: [], more: false, cursor: 0 });

/** An agent of `options`, to define. */
const make = (options: object) => () =>
  sessionObject({ name: 'x', ...options, views: { messages: conversationView(ITEMS) } });

describe('an agent on the conversation of turns', () => {
  it('has `settle` and `compact`, private, beside `erase`', () => {
    const { agent } = storeAgent();
    const handlers = Object.keys((agent as unknown as { object: object }).object);
    expect(handlers).toEqual(expect.arrayContaining(['erase', 'settle', 'compact']));
    expect(() =>
      // @ts-expect-error: a handler every agent has
      sessionObject({ name: 'x', handlers: { settle: async () => {} }, views: { messages: conversationView(ITEMS) } }),
    ).toThrow('`settle` is a handler');
  });

  it("starts each turn saying it settles; another's turn does not", async () => {
    const { run, calls } = storeAgent();
    await run('chat', 'hi');
    expect(calls.find((c) => c.method === 'start')?.parameter).toMatchObject({ settles: true });
    const other = sessionObject({
      name: 'other',
      handlers: { chat: chatHandler(async () => 'ok') },
      views: { messages: async () => ({ messages: [], more: false, cursor: 0 }) },
    });
    const otherCalls: Made[] = [];
    await invoke(other, 'chat', fakeContext({ map: new Map(), service: 'other', calls: otherCalls }), 'hi');
    expect(otherCalls.find((c) => c.method === 'start')?.parameter).not.toHaveProperty('settles');
  });

  it("closes a gone invocation's turn on `settle`, and publishes it", async () => {
    const { run, calls } = storeAgent();
    await expect(run('chat', 'die', 'inv_gone')).rejects.toThrow('gone');
    calls.length = 0;
    expect(await run('settle', 'inv_other')).toBe(false);
    expect(calls).toEqual([]);
    expect(await run('settle', 'inv_gone')).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['publish']);
    const page = (await run('messages', {})) as { messages: { parts: { text?: string; output?: string }[] }[] };
    expect(page.messages.at(-1)!.parts).toEqual([{ type: 'text', text: ENDED }]);
    expect(await run('settle', 'inv_gone')).toBe(false);
  });

  it('keeps its ids and cursors going through `erase`', async () => {
    const { run } = storeAgent();
    await run('chat', 'one');
    const before = (await run('messages', {})) as { cursor: number };
    await run('erase');
    const emptied = (await run('messages', {})) as { messages: unknown[]; first: number; cursor: number };
    expect([emptied.messages, emptied.first, emptied.cursor]).toEqual([[], 2, before.cursor]);
    await run('chat', 'two');
    expect(((await run('messages', {})) as { messages: { id: number }[] }).messages.map((m) => m.id)).toEqual([2, 3]);
  });

  it('summarizes the earliest turns once they outgrow its budget, in `compact`', async () => {
    const requests: string[] = [];
    const { run, sends, map } = storeAgent({
      budget: 10,
      summarize: async (_ctx, request) => {
        requests.push(request);
        return 'they talked';
      },
    });
    for (let i = 0; i < 6; i++) await run('chat', `q${i}`, `inv_q${i}`);
    // The turns before the next window outgrew 40 characters: `compact` was sent, once per prompt.
    const compacts = sends.filter((s) => s.method === 'compact');
    expect(compacts.length).toBeGreaterThan(0);
    expect(compacts[0]).toMatchObject({ key: 'alice', idempotencyKey: expect.stringMatching(/:compact$/) });
    expect(await run('compact')).toBe(true);
    expect(requests[0]).toMatch(/^Summarize the conversation/);
    expect(requests[0]).toContain('User: q0\nAssistant: fine: q0');
    // The next turn's model sees the summary, then the turns after it.
    const seen: Item[][] = [];
    const sql = sqlAttempt({ map, key: 'alice', id: 'inv_next' });
    await sql.end(() =>
      answerOnce(
        sql.ctx,
        'next',
        ITEMS,
        async (conversation) => {
          seen.push(conversation.history());
          return 'ok';
        },
        { budget: 10, window: 1 },
      ),
    );
    expect(seen[0]![0]).toEqual({ role: 'user', text: `${SUMMARY}they talked` });
    // The rows stay: the views show every turn.
    const rows = await sqlAttempt({ map, key: 'alice', id: 'read' }).ctx.db.values(`SELECT COUNT(*) FROM ${STEPS}`);
    expect(Number(rows[0]![0])).toBeGreaterThan(0);
  });

  it("refuses to answer with items other than its `messages` view's: one framework per agent", async () => {
    expect(await answeredWith(ITEMS)).toBe('fine');
    await expect(answeredWith(new FakeItems())).rejects.toThrow("another framework's");
    await expect(answeredWith(new FakeItems())).rejects.toBeInstanceOf(restate.TerminalError);
  });

  it("refuses `summarize` without the conversation of turns, whose `compact` uses it: a framework's `messages` view", () => {
    const chat = chatHandler((ctx, message) => answerOnce(ctx, message, ITEMS, async () => 'fine'));
    expect(() => sessionObject({ name: 'x', summarize, handlers: { chat } })).toThrow(/summarize/);
    expect(() => sessionObject({ name: 'x', summarize, handlers: { chat }, views: { messages: yours } })).toThrow(
      /summarize/,
    );
    expect(() => make({ summarize, handlers: { chat } })()).not.toThrow();
  });

  it('refuses a window or budget that is not a number of turns or tokens', () => {
    expect(make({ window: -1 })).toThrow('window');
    expect(make({ window: 1.5 })).toThrow('window');
    expect(make({ budget: -5 })).toThrow('budget');
    expect(make({ window: 'all', budget: 0 })).not.toThrow();
  });
});

describe('a turn of a chat handler on the store', () => {
  it('is settled by its agent when the next turn finds its invocation gone', async () => {
    const map = new Map<string, Uint8Array>();
    const { agent } = storeAgent();
    const chat = (agent as unknown as { object: Record<string, unknown> }).object;
    expect(chat).toBeDefined();
    const ask = (id: string, text: string) => {
      const sql = sqlAttempt({ map, key: 'k', id, object: agent });
      return sql.end(() => run(sql.ctx, text));
    };
    const run = handlerOf(
      chatHandler((ctx, message) =>
        answerOnce(ctx, message, ITEMS, async (conversation) => {
          if (message === 'die') {
            await conversation.turn.appendReply([calling('c1')]);
            throw new Error('the invocation is gone');
          }
          return 'fine';
        }),
      ),
    );
    await expect(ask('inv_a', 'die')).rejects.toThrow('gone');
    expect(await ask('inv_b', 'hi')).toBe('fine');
    // The companion closed the gone turn as the next started, and would have its agent settle it.
    expect(followingOf(map).settled).toEqual(['inv_a']);
  });
});

/** The turns of the object of state `map`, as stored. */
async function storedTurns(map: Map<string, Uint8Array>) {
  const read = sqlAttempt({ map, key: 'k', id: 'read' });
  return (await read.end(() => Conversation.load(read.ctx.db, ITEMS))).turns;
}

/** The results the items of `turn` hold, by call id. */
const turnResults = (turn: Turn<Item>) =>
  turn.items.flatMap((e) => (e.item.result === undefined ? [] : [[e.item.result, e.item.output] as const]));

/**
 * `run` as a chat handler's turn on the made-up framework, in an attempt of
 * its own over `map`: the attempt (to cancel), and its answer.
 */
function stopping(map: Map<string, Uint8Array>, run: (ctx: restate.SessionContext) => Run<Item>) {
  const sql = sqlAttempt({ map, key: 'k', id: 'inv1' });
  const chat = chatHandler((ctx, message) => answerOnce(ctx, message, ITEMS, run(ctx)));
  const answer = sql.end(() => handlerOf(chat)(sql.ctx, 'Please move 5 from 1 to 2'));
  return {
    sql,
    answer: answer.then(
      () => 'answered',
      (error: unknown) => error,
    ),
  };
}

describe("a stopped turn's run, left running", () => {
  it('stores nothing after the close: a tool that ends as the stop comes leaves one result, before the note', async () => {
    const map = new Map<string, Uint8Array>();
    const started = Promise.withResolvers<void>();
    const { sql, answer } = stopping(map, (ctx) => async (conversation) => {
      const turn = conversation.turn;
      await turn.appendReply([calling('c1')]);
      const stop = stopSignalOf(ctx)!;
      const stopped = new Promise((resolve) => stop.addEventListener('abort', resolve, { once: true }));
      started.resolve();
      await stopped;
      // The tool, which does not heed the stop, ends just after it.
      await turn.append({ result: 'c1', output: 'moved 5' }).catch(() => {});
      return 'done';
    });
    await started.promise;
    sql.cancel();
    expect(await answer).toBeInstanceOf(restate.CancelledError);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the run left behind ends
    const [turn] = await storedTurns(map);
    expect(turnResults(turn!)).toHaveLength(1);
    expect(turn!.items.at(-1)!.item).toEqual({ role: 'assistant', text: CANCELLED });
    expect(turn!.prompt.answeredAt).toBe(turn!.items.at(-1)!.n);
  });

  it('closes the calls of a reply whose write was under way as the stop came', async () => {
    const map = new Map<string, Uint8Array>();
    const stop = { cancel: () => {} };
    const { sql, answer } = stopping(map, () => async (conversation) => {
      const writing = conversation.turn.appendReply([calling('c1')]);
      stop.cancel();
      await writing;
      return new Promise<string>(() => {});
    });
    stop.cancel = () => sql.cancel();
    expect(await answer).toBeInstanceOf(restate.CancelledError);
    const [turn] = await storedTurns(map);
    expect(turn!.openCalls()).toEqual([]);
    expect(turnResults(turn!)).toEqual([['c1', CANCELLED]]);
  });

  it('takes no copy of a framework into a turn being closed', async () => {
    const map = new Map<string, Uint8Array>();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const copied: boolean[] = [];
    const { sql, answer } = stopping(map, (ctx) => async (conversation) => {
      const turn = conversation.turn;
      // The call records loaded: a close reads them without the database.
      await callOf(ctx, 'lookup', {}, 'c0');
      await turn.appendReply([calling('c1')]);
      // The framework's own write, which copies its messages into the turn.
      await ctx.db.transaction(async (tx) => {
        started.resolve();
        await gate.promise;
        copied.push(await turn.copyIn(tx, [{ item: { result: 'c1', output: 'copied' } }]));
      });
      return new Promise<string>(() => {});
    });
    await started.promise;
    sql.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20)); // the close waits for the framework's write
    gate.resolve();
    expect(await answer).toBeInstanceOf(restate.CancelledError);
    expect(copied).toEqual([false]);
    const [turn] = await storedTurns(map);
    expect(turnResults(turn!)).toEqual([['c1', CANCELLED]]);
  });
});

describe("a framework's copy into its turn", () => {
  it("takes positions of its own beside a write of the turn's that waits for the copy's transaction", async () => {
    const map = new Map<string, Uint8Array>();
    const sql = sqlAttempt({ map, key: 'k', id: 'inv1' });
    let ordered: number[] = [];
    await sql.end(() =>
      answerOnce(sql.ctx, 'q', ITEMS, async (conversation) => {
        const turn = conversation.turn;
        const gate = Promise.withResolvers<void>();
        // The framework's transaction copies its reply into the turn...
        const copying = sql.ctx.db.transaction(async (tx) => {
          await gate.promise;
          await turn.copyIn(tx, [{ item: { role: 'assistant', text: 'copied' }, reply: true }]);
        });
        // ...while the turn's own write (an ask again, say) waits for it.
        const asking = turn.askAgain('again');
        await new Promise((resolve) => setTimeout(resolve, 10));
        gate.resolve();
        await copying;
        await asking;
        ordered = turn.items.map((e) => e.n);
        return 'copied';
      }),
    );
    // In the order they committed: positions, and so the cursors of the changes (then the answer's reply).
    const [turn] = await storedTurns(map);
    const written = turn!.items.slice(0, 2);
    expect(written.map((e) => e.item.text)).toEqual(['copied', 'again']);
    expect(ordered).toEqual(written.map((e) => e.n));
  });
});

/** A handler on the made-up framework whose message `die` leaves its turn open (its invocation gone). */
const dying = (ctx: restate.SessionContext, message: string) =>
  answerOnce(ctx, message, ITEMS, async (conversation) => {
    if (message !== 'die') return 'fine';
    await conversation.turn.appendReply([calling('c1')]);
    throw new Error('the invocation is gone');
  });

describe('a close', () => {
  it('closes a dead turn once, however a crash cuts it', async () => {
    const handler = dying;
    const dead = banking(handler, 'k');
    await dead.attempt('inv1', 'die').catch(() => {});
    let crashes = 0;
    for (let at = 1; ; at++) {
      const c = banking(handler, 'k', { state: dead.state, ledger: dead.ledger });
      if ((await c.attempt('inv2', 'next', at)) !== 'crashed') break;
      crashes++;
      expect(await c.attempt('inv2', 'next')).toBe('fine');
      const [first] = await c.read(async (ctx) => (await Conversation.load(ctx.db as never, ITEMS)).turns);
      const notes = first!.items.filter((e) => e.item.text === ENDED);
      expect([at, notes.length, turnResults(first!)]).toEqual([at, 1, [['c1', ENDED]]]);
    }
    expect(crashes).toBeGreaterThan(0);
  });
});
