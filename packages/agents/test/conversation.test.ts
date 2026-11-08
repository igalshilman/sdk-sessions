// The conversation every framework shares (conversation.ts), with items of a
// made-up framework (fakes/items.ts): the Python SDK's
// tests/agents_conversation.py, test for test.
import * as restate from '@restatedev/sessions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOf } from '../src/calls.ts';
import { CANCELLED, ENDED, fromTool, refusalOf, RETURNED_UNRECORDED, type Window } from '../src/common.ts';
import {
  answerOnce,
  Conversation,
  type Entry,
  type Items,
  type Parsed,
  type Run,
  settle,
  type Status,
  SUMMARY,
  windowStart,
} from '../src/conversation.ts';
import { calling, FakeItems, type Item, ITEMS } from './fakes/items.ts';
import { sqlAttempt } from './support.ts';

afterEach(() => vi.restoreAllMocks());

let invocations = 0;
/** A new invocation's id. */
const invocation = () => `inv_${++invocations}`;

/**
 * How to ask an object (of state `map`) whose handler answers each prompt
 * with `run`: an attempt of invocation `id` (a new one by default).
 */
function asking(
  run: Run<Item>,
  { items = ITEMS, window, budget, check, map = new Map<string, Uint8Array>() } = {} as {
    items?: Items<Item>;
    window?: Window;
    budget?: number;
    check?: (answer: string) => string | undefined;
    map?: Map<string, Uint8Array>;
  },
) {
  const ask = (text: string, id = invocation()) => {
    const sql = sqlAttempt({ map, key: 'k', id });
    return sql.end(() => answerOnce(sql.ctx, text, items, run, { window, budget, check }));
  };
  /** `body` in an attempt of its own, on the same object. */
  const inAttempt = <T>(body: (ctx: restate.SessionContext) => Promise<T>, id = invocation()) => {
    const sql = sqlAttempt({ map, key: 'k', id });
    return sql.end(() => body(sql.ctx));
  };
  return { ask, inAttempt, map };
}

const items = (conversation: Conversation<Item>) => conversation.entries.map((e) => e.item);

describe('answerOnce', () => {
  it('answers a prompt once, and a retry returns the stored answer', async () => {
    const runs: string[] = [];
    const { ask } = asking(async (conversation) => {
      runs.push('ran');
      await conversation.turn.appendReply([{ role: 'assistant', text: 'hello' }]);
      return 'hello';
    });
    expect(await ask('hi', 'inv_a')).toBe('hello');
    expect(await ask('hi', 'inv_a')).toBe('hello');
    expect(runs).toEqual(['ran']);
  });

  it('appends the results of tool calls run at once each as it comes', async () => {
    const seen: Item[][] = [];
    const { ask } = asking(async (conversation) => {
      seen.push(items(conversation));
      if (seen.length > 1) return 'fine';
      await conversation.turn.appendReply([calling('c1', 'c2')]);
      await Promise.all(['c1', 'c2'].map((id) => conversation.turn.append({ result: id, output: `${id} done` })));
      await conversation.turn.appendReply([{ role: 'assistant', text: 'both' }]);
      return 'both';
    });
    expect(await ask('first')).toBe('both');
    expect(await ask('second')).toBe('fine');
    expect(seen[1]!.slice(-4)).toEqual([
      { result: 'c1', output: 'c1 done' },
      { result: 'c2', output: 'c2 done' },
      { role: 'assistant', text: 'both' },
      { role: 'user', text: 'second' },
    ]);
  });

  it('closes a failed run with its error, and the next prompt starts afresh', async () => {
    const seen: Item[][] = [];
    const { ask } = asking(async (conversation) => {
      seen.push(items(conversation));
      if (seen.length === 1) {
        await conversation.turn.appendReply([calling('c1')]);
        throw new restate.TerminalError('boom');
      }
      return 'fine';
    });
    await expect(ask('first')).rejects.toThrow('boom');
    expect(await ask('second')).toBe('fine');
    expect(seen[1]!.slice(-3)).toEqual([
      { result: 'c1', output: 'Error: boom' },
      { role: 'assistant', text: 'Error: boom' },
      { role: 'user', text: 'second' },
    ]);
  });

  it('stores nothing more of a stopped run', async () => {
    const kept: Conversation<Item>[] = [];
    const { ask } = asking(async (conversation) => {
      kept.push(conversation);
      throw new restate.CancelledError();
    });
    await expect(ask('first')).rejects.toBeInstanceOf(restate.CancelledError);
    const [conversation] = kept;
    const turn = conversation!.turn;
    expect(turn.entries.at(-1)!.item).toEqual({ role: 'assistant', text: CANCELLED });
    expect([turn.status, turn.answer]).toEqual(['cancelled', CANCELLED]);
    // The run, unwinding after the stop, is fenced off.
    expect(conversation!.closed).toBe(true);
    await expect(turn.append({ role: 'assistant', text: 'too late' })).rejects.toThrow('stores nothing more');
    await expect(turn.drop(turn.entries.at(-1)!.n)).rejects.toThrow('stores nothing more');
    await expect(turn.answered('too late')).rejects.toThrow('stores nothing more');
  });

  it('drops a reply with what followed it, and reads each item once', async () => {
    const reads: Item[] = [];
    class Counting extends FakeItems {
      override read(item: Item): Parsed {
        reads.push(item);
        return super.read(item);
      }
    }
    const { ask } = asking(
      async (conversation) => {
        const reply = await conversation.turn.appendReply([calling('c1')]);
        await conversation.turn.append({ result: 'c1', output: 'found' });
        expect(conversation.turn.hasResult('c1')).toBe(true);
        expect(conversation.turn.openCalls()).toEqual([]);
        await conversation.turn.drop(reply);
        // The reply and the result made from it are gone, from memory and from the database alike.
        expect(conversation.turn.hasResult('c1')).toBe(false);
        const stored = await Conversation.load(conversation.db, ITEMS);
        expect(items(stored)).toEqual(items(conversation));
        expect(items(stored)).toEqual([{ role: 'user', text: 'hi' }]);
        return 'done';
      },
      { items: new Counting() },
    );
    expect(await ask('hi')).toBe('done');
    // The prompt, the reply and the result, each read once as it was appended; and the answer, the turn's reply.
    expect(reads).toEqual([
      { role: 'user', text: 'hi' },
      calling('c1'),
      { result: 'c1', output: 'found' },
      {
        role: 'assistant',
        text: 'done',
      },
    ]);
  });

  it("marks a tool's error, of any type, as no refusal; a model's is one", async () => {
    const noKey = 'Could not resolve authentication method. Expected either api_key or auth_token to be set.';
    const { inAttempt } = asking(async () => '');
    const seen = await inAttempt(async (ctx) => {
      const tools = new TypeError(noKey);
      fromTool(ctx, tools);
      return { tool: refusalOf(ctx, tools), model: refusalOf(ctx, new TypeError(noKey)) };
    });
    expect(seen.tool).toBeUndefined();
    expect(seen.model?.code).toBe(424);
  });
});

/** A database that records the SQL it is asked to run, and runs none of it. */
function recorded() {
  const statements: [string, unknown][] = [];
  const execute = async (sql: string, params?: unknown) => void statements.push([sql, params]);
  const db = { execute, transaction: async (body: (tx: unknown) => Promise<unknown>) => body({ execute }) };
  return { db: db as unknown as restate.Database, statements };
}

/** A conversation of `entries`, the first a prompt, on a database that records. */
function conversationOf(...entries: Item[]) {
  const { db, statements } = recorded();
  const all: Entry<Item>[] = entries.map((item, n) => (n === 0 ? { n, item, prompt: 'p0' } : { n, item }));
  return { conversation: new Conversation(db, ITEMS, all), statements };
}

describe('a turn', () => {
  it('reads a reply and what follows a prompt by position', async () => {
    const { conversation } = conversationOf({ role: 'user', text: 'hi' });
    const first = await conversation.turn.appendReply([calling('c1'), { role: 'assistant', text: 'thinking' }], 'a');
    await conversation.turn.append({ result: 'c1', output: 'done' });
    const second = await conversation.turn.appendReply([{ role: 'assistant', text: 'there' }], 'b');
    const turn = conversation.turn;
    expect(turn.replyEntries(first).map((e) => e.n)).toEqual([1, 2]);
    expect(turn.replyEntries(second).map((e) => e.n)).toEqual([4]);
    expect(turn.replyEntries(3)).toEqual([]);
    expect([turn.agentOf(first), turn.agentOf(second), turn.agentOf(3)]).toEqual(['a', 'b', undefined]);
    expect(turn.items.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(turn.replies()).toEqual([first, second]);
    expect(conversation.history()).toEqual(items(conversation));
    expect(turn.finalReply()).toBe('there');
  });

  it('keeps its unanswered calls as it appends and drops', async () => {
    const { conversation } = conversationOf({ role: 'user', text: 'hi' });
    const turn = () => conversation.turn;
    const open = () =>
      turn()
        .openCalls()
        .map((c) => c.id);
    const first = await turn().appendReply([calling('c1', 'c2')]);
    expect(open()).toEqual(['c1', 'c2']);
    await turn().append({ result: 'c2', output: 'done' });
    expect(open()).toEqual(['c1']);
    await turn().append({ result: 'c1', output: 'done' });
    const second = await turn().appendReply([calling('c3')]);
    expect(open()).toEqual(['c3']);
    // Dropping the second reply forgets its call; dropping the first forgets its calls' results too.
    await turn().drop(second);
    expect(open()).toEqual([]);
    expect(turn().hasResult('c1')).toBe(true);
    await turn().drop(first);
    expect(open()).toEqual([]);
    expect(turn().hasResult('c1')).toBe(false);
    expect(conversation.entries.map((e) => e.n)).toEqual([0]);
    // The positions are given again.
    expect(await turn().appendReply([calling('c1')])).toBe(first);
    expect(open()).toEqual(['c1']);
  });

  it('of a sealed conversation stores nothing more', async () => {
    const { conversation, statements } = conversationOf(
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    );
    await conversation.seal();
    expect(conversation.closed).toBe(true);
    await expect(conversation.turn.append({ role: 'assistant', text: 'late' })).rejects.toThrow('stores nothing more');
    await expect(conversation.turn.appendReply([{ role: 'assistant', text: 'late' }])).rejects.toThrow(
      'stores nothing more',
    );
    await expect(conversation.turn.drop(1)).rejects.toThrow('stores nothing more');
    expect(statements).toEqual([]);
    expect(conversation.entries).toHaveLength(2);
  });

  it('is written only while it is being answered, and is answered once', async () => {
    const { conversation } = conversationOf();
    expect(() => conversation.turn).toThrow('no turn');
    const first = await conversation.ask('p1', 'hi');
    await expect(conversation.ask('p2', 'hello')).rejects.toThrow('never overlap');
    await first.answered('hello');
    expect(conversation.answerOf('p1')).toBe('hello');
    expect(first.status).toBe('answered');
    // The answer, with no reply of the model, is the turn's reply: the message the summary shows.
    expect(first.items.at(-1)!.item).toEqual({ role: 'assistant', text: 'hello' });
    expect(first.prompt.answeredAt).toBe(first.items.at(-1)!.n);
    await expect(first.answered('again')).rejects.toThrow('not the turn being answered');
    const second = await conversation.ask('p2', 'and you?');
    // An earlier turn is read, never written.
    await expect(first.append({ role: 'assistant', text: 'late' })).rejects.toThrow('not the turn being answered');
    await conversation.seal();
    await expect(second.answered('again')).rejects.toThrow('stores nothing more');
    expect(conversation.answerOf('p1')).toBe('hello');
  });

  it('logs a call id used twice, once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { conversation } = conversationOf(calling('c1'), { result: 'c1', output: 'done' });
    expect(warn).not.toHaveBeenCalled();
    await conversation.turn.appendReply([calling('c1')]);
    await conversation.turn.appendReply([calling('c1', 'c1')]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('"c1"');
  });

  it('keeps calls that share an id each unanswered until a result has it', async () => {
    // Calls without an id are read with the id "": each needs a result of its own when the run is closed.
    const { conversation } = conversationOf({ role: 'user', text: 'hi' }, calling('', ''));
    expect(conversation.turn.openCalls().map((c) => c.id)).toEqual(['', '']);
    await conversation.turn.append({ result: '', output: 'done' });
    expect(conversation.turn.openCalls()).toEqual([]);
  });

  it('that ends with a tool after a message ends with its answer', async () => {
    const { conversation } = conversationOf({ role: 'user', text: 'book Rome' });
    const turn = conversation.turn;
    // The model says something, then calls a tool whose output is the answer (a tool that ends the turn).
    await turn.appendReply(
      [{ role: 'assistant', text: 'Let me book that.', calls: [{ id: 'b1', name: 'book', input: {} }] }],
      'booker',
    );
    await turn.append({ result: 'b1', output: 'booked Rome' });
    await turn.answered('booked Rome');
    // The turn ends with its answer, as a message of the assistant: the summary's, and what the next model sees.
    const last = turn.items.at(-1)!;
    expect(last.item).toEqual({ role: 'assistant', text: 'booked Rome' });
    expect(last.agent).toBe('booker');
    expect(turn.prompt.answeredAt).toBe(last.n);
  });

  it('answered with nothing to say is answered once', async () => {
    // Items that read an empty message as no message.
    class Silent extends FakeItems {
      override read(item: Item): Parsed {
        const parsed = super.read(item);
        return parsed.said && !parsed.said[1] ? { ...parsed, said: undefined } : parsed;
      }
    }
    const { db } = recorded();
    const conversation = new Conversation(db, new Silent(), []);
    const turn = await conversation.ask('p1', 'do it quietly');
    // No message of the assistant, and an empty answer: nothing to show as the answer, and nothing stored for it.
    await turn.answered('');
    expect([turn.status, turn.answer, turn.prompt.answeredAt]).toEqual(['answered', '', undefined]);
    expect(turn.items).toEqual([]);
  });

  it("has open calls of its own, not an earlier turn's", () => {
    const { db } = recorded();
    const entries: Entry<Item>[] = [
      { n: 0, item: { role: 'user', text: 'first' }, prompt: 'p0', answer: 'done', status: 'answered' },
      { n: 1, item: calling('c0') },
      { n: 2, item: { role: 'user', text: 'second' }, prompt: 'p1' },
      { n: 3, item: calling('c1') },
    ];
    const conversation = new Conversation(db, ITEMS, entries);
    const [first, second] = conversation.turns;
    // The first turn ended with a call left open: it is that turn's, and closing the second does not answer it.
    expect(first!.openCalls().map((c) => c.id)).toEqual(['c0']);
    expect(second!.openCalls().map((c) => c.id)).toEqual(['c1']);
    expect(conversation.turn).toBe(second);
    expect(conversation.running()).toBe(second);
    // The model was given both turns, flat.
    expect(conversation.history()).toEqual(entries.map((e) => e.item));
    expect(conversation.knowsResult('c0')).toBe(false);
    expect(conversation.entries.map((e) => e.turn)).toEqual([0, 0, 2, 2]);
  });

  it('asks again within itself, once across attempts', async () => {
    const replies = ['prose', 'crash', 'still prose'];
    const seen: Conversation<Item>[] = [];
    const { ask } = asking(
      async (conversation) => {
        seen.push(conversation);
        const reply = replies.shift()!;
        if (reply === 'crash') throw new Error('the process crashed after asking again');
        await conversation.turn.appendReply([{ role: 'assistant', text: reply }]);
        return reply;
      },
      { check: (answer) => (answer.startsWith('{') ? undefined : 'Reply again, with JSON only.') },
    );
    await expect(ask('plan', 'inv_plan')).rejects.toThrow('crashed');
    // The retry finds the ask again stored: it does not ask again a second time, and answers with the reply to it.
    expect(await ask('plan', 'inv_plan')).toBe('still prose');
    const turn = seen.at(-1)!.turn;
    expect(seen.at(-1)!.transcript).toHaveLength(1);
    expect(turn.answer).toBe('still prose');
    expect(turn.items.map((e) => e.item)).toEqual([
      { role: 'assistant', text: 'prose' },
      { role: 'user', text: 'Reply again, with JSON only.' },
      { role: 'assistant', text: 'still prose' },
    ]);
    expect(turn.latestAsk().item).toEqual({ role: 'user', text: 'Reply again, with JSON only.' });
  });
});

/** The made-up framework's items, counting how many it loads from the database. */
class Loading extends FakeItems {
  loaded = 0;
  override load(stored: string): Item {
    this.loaded += 1;
    return super.load(stored);
  }
}

/** A conversation of answered turns, each its prompt and answer, loaded with no turn whole. */
function turnsOf(...answers: string[]) {
  const { db } = recorded();
  const transcript: Entry<Item>[] = answers.map((answer, n) => ({
    n,
    item: { role: 'user', text: `q${n}` },
    prompt: `p${n}`,
    answer,
    status: 'answered',
  }));
  return new Conversation(db, ITEMS, [], { transcript, budget: 10, window: 0 });
}

/** Turns that ended as `statuses`, in order. */
const statusesOf = (...statuses: (Status | undefined)[]): Entry<Item>[] =>
  statuses.map((status, n) => ({ n, item: { role: 'user', text: `q${n}` }, prompt: `p${n}`, status }));

describe('what a turn loads, and what the model sees', () => {
  it('loads the transcript, and only the latest turns whole', async () => {
    const loading = new Loading();
    const seen: Item[][] = [];
    const { ask } = asking(
      async (conversation) => {
        seen.push(conversation.history());
        const turn = conversation.turn;
        await turn.appendReply([calling(`c${turn.n}`)]);
        await turn.append({ result: `c${turn.n}`, output: 'done' });
        const answer = `answer ${turn.prompt.item.text}`;
        await turn.appendReply([{ role: 'assistant', text: answer }]);
        return answer;
      },
      { items: loading },
    );
    let loaded = 0;
    for (let n = 0; n < 30; n++) {
      loaded = loading.loaded;
      await ask(`q${n}`);
    }
    // The last turn loaded each earlier turn's prompt once, and the items of one turn only: the previous one's 3.
    expect(loading.loaded - loaded).toBe(29 + 3);
    // The model saw the turns before the previous one as their messages and answers, then the previous one whole.
    const last = seen.at(-1)!;
    const earlier = last.slice(0, -5);
    const [previous, reply, result, answer, prompt] = last.slice(-5);
    expect(earlier).toHaveLength(28 * 2);
    expect(previous).toEqual({ role: 'user', text: 'q28' });
    expect(earlier.slice(0, 2)).toEqual([
      { role: 'user', text: 'q0' },
      { role: 'assistant', text: 'answer q0' },
    ]);
    expect(earlier.filter((item) => item.calls || item.result)).toEqual([]);
    expect(reply!.calls).toBeTruthy();
    expect(result!.result).toBeTruthy();
    expect(answer!.text).toBe('answer q28');
    expect(prompt).toEqual({ role: 'user', text: 'q29' });
  });

  it('gives the model the latest earlier turns that the budget holds', () => {
    // 40 characters: the turns of 2 + 18 characters each, of which two fit.
    const conversation = turnsOf('a'.repeat(18), 'b'.repeat(18), 'c'.repeat(18));
    expect(conversation.history()).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'b'.repeat(18) },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'c'.repeat(18) },
    ]);
    // They outgrow it: the turns half of it does not hold are summarized, up to the one it does.
    expect(conversation.overflowing()).toBe(true);
    const found = conversation.toSummarize();
    expect(found?.[0].map((turn) => turn.n)).toEqual([0, 1]);
    expect(found?.[1]).toBe(2);
  });

  it('has a summary stand for the turns before the transcript', () => {
    const { db } = recorded();
    const transcript: Entry<Item>[] = [
      { n: 2, item: { role: 'user', text: 'q2' }, prompt: 'p2', answer: 'c', status: 'answered' },
    ];
    const start = { n: 0, seq: 0, summary: 'they talked', summarized: 2 };
    const conversation = new Conversation(db, ITEMS, [], { start, transcript, window: 0 });
    expect(conversation.history()).toEqual([
      { role: 'user', text: `${SUMMARY}they talked` },
      { role: 'assistant', text: 'Understood.' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'c' },
    ]);
  });

  it('reads only the turns its budget holds, without a summary', async () => {
    const loading = new Loading();
    const seen: Item[][] = [];
    // 10 tokens: 40 characters of turns before the window, of 3 + 4 characters each.
    const { ask } = asking(
      async (conversation) => {
        seen.push(conversation.history());
        return 'fine';
      },
      { items: loading, budget: 10 },
    );
    let loaded = 0;
    for (let n = 0; n < 100; n++) {
      loaded = loading.loaded;
      await ask(`q${String(n).padStart(2, '0')}`);
    }
    // The last turn read the previous turn (its prompt and answer), the 5 before it the budget holds, and the
    // one past it: not all 99.
    expect(loading.loaded - loaded).toBe(2 + 5 + 1);
    expect(seen.at(-1)!.map((item) => item.text)).toEqual([
      ...Array.from({ length: 6 }, (_, i) => [`q${93 + i}`, 'fine']).flat(),
      'q99',
    ]);
  });

  it('loads every turn whole with a window of all', async () => {
    const seen: Conversation<Item>[] = [];
    const { ask } = asking(
      async (conversation) => {
        seen.push(conversation);
        await conversation.turn.appendReply([calling(`c${seen.length}`)]);
        await conversation.turn.append({ result: `c${seen.length}`, output: 'done' });
        return 'fine';
      },
      { window: 'all' },
    );
    for (let n = 0; n < 4; n++) await ask(`q${n}`);
    // Every turn is whole: its prompt, its call, its result and its answer (the last turn's too, appended since).
    expect(seen.at(-1)!.entries).toHaveLength(4 * 4);
    expect(seen.at(-1)!.history()).toHaveLength(seen.at(-1)!.entries.length);
  });

  it('keeps a turn another invocation ended in the window, as an unanswered one', () => {
    // Its framework never finished it, so what it carried is a guess: the next turn reads it whole.
    expect(windowStart(statusesOf('answered', 'ended'), 0)).toBe(1);
    expect(windowStart(statusesOf('answered', 'ended', 'ended'), 0)).toBe(1);
    expect(windowStart(statusesOf('answered', 'answered', 'ended'), 1)).toBe(1);
    expect(windowStart(statusesOf('answered', 'ended', undefined), 0)).toBe(1);
    // One before the window's answered turns is not: the turns after it carried on from it.
    expect(windowStart(statusesOf('answered', 'ended', 'answered'), 1)).toBe(2);
    expect(windowStart(statusesOf('answered', 'ended', 'answered'), 0)).toBe(3);
    // A turn closed by its own run (stopped, failed, refused) carried what its framework had: it counts as answered.
    expect(windowStart(statusesOf('answered', 'cancelled', undefined), 0)).toBe(2);
    // Otherwise, as before.
    expect(windowStart(statusesOf('answered', 'answered', undefined), 1)).toBe(1);
    expect(windowStart(statusesOf('answered', 'answered'), 0)).toBe(2);
  });
});

/** A run that dies after its call c1's Restate call returned, before its result was stored; c2's never did. */
const dying = (seen: Conversation<Item>[]) => {
  let ctx: restate.SessionContext | undefined;
  const run: Run<Item> = async (conversation) => {
    seen.push(conversation);
    if (seen.length > 1) return 'fine';
    await conversation.turn.appendReply([calling('c1', 'c2')]);
    await (await callOf(ctx!, 'lookup', {}, 'c1')).answered();
    throw new Error('the invocation is gone');
  };
  return { run, keep: (c: restate.SessionContext) => (ctx = c) };
};

describe('a turn left without an answer', () => {
  it('is ended by the next, and carries on its agent', async () => {
    const seen: Conversation<Item>[] = [];
    const { ask } = asking(async (conversation) => {
      seen.push(conversation);
      if (seen.length === 1) {
        await conversation.turn.appendReply([calling('c1')], 'refunds');
        throw new Error('the invocation is gone');
      }
      return 'fine';
    });
    await expect(ask('first')).rejects.toThrow('gone');
    // Another invocation: the first turn's is gone, so its turn ends, its call with a result, and it is not run again.
    expect(await ask('second')).toBe('fine');
    const [first, second] = seen[1]!.transcript;
    expect([first!.answer, first!.agent]).toEqual([ENDED, 'refunds']);
    expect(second!.prompt).toBeDefined();
    expect(seen[1]!.turn.openCalls()).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it('gets the outcomes of its calls', async () => {
    const seen: Conversation<Item>[] = [];
    const { run, keep } = dying(seen);
    const { inAttempt } = asking(run);
    const ask = (text: string) =>
      inAttempt((ctx) => {
        keep(ctx);
        return answerOnce(ctx, text, ITEMS, run);
      });
    await expect(ask('first')).rejects.toThrow('gone');
    await ask('second');
    const results = new Map(seen[1]!.entries.flatMap((e) => (e.parsed?.results ?? []).map((r) => [r.id, r.output])));
    expect(results.get('c1')).toBe(RETURNED_UNRECORDED);
    expect(results.get('c2')).toBe(ENDED);
  });

  it('is closed by settle only for its gone invocation, and only once', async () => {
    const seen: Conversation<Item>[] = [];
    const { run, keep } = dying(seen);
    const { inAttempt } = asking(run);
    await expect(
      inAttempt((ctx) => {
        keep(ctx);
        return answerOnce(ctx, 'first', ITEMS, run);
      }, 'inv_gone'),
    ).rejects.toThrow('gone');
    // Another invocation's id closes nothing; the gone one's closes its turn, with its calls' outcomes, once.
    expect(await inAttempt((ctx) => settle(ctx, ITEMS, 'inv_other'))).toBe(false);
    expect(await inAttempt((ctx) => settle(ctx, ITEMS, 'inv_gone'))).toBe(true);
    expect(await inAttempt((ctx) => settle(ctx, ITEMS, 'inv_gone'))).toBe(false);
    const conversation = await inAttempt((ctx) => Conversation.load(ctx.db, ITEMS));
    expect([conversation.transcript[0]!.prompt, conversation.transcript[0]!.answer]).toEqual(['inv_gone', ENDED]);
    expect(conversation.transcript[0]!.status).toBe('ended');
    const results = new Map(
      conversation.entries.flatMap((e) => (e.parsed?.results ?? []).map((r) => [r.id, r.output])),
    );
    expect(Object.fromEntries(results)).toEqual({ c1: RETURNED_UNRECORDED, c2: ENDED });
  });
});

describe('a retry of a closed turn', () => {
  it('fails as the prompt did: failed for good, cancelled, or ended by another invocation', async () => {
    const { ask } = asking(async (conversation) => {
      const text = conversation.turn.prompt.item.text;
      if (text === 'boom') throw new restate.TerminalError('boom');
      if (text === 'stop') throw new restate.CancelledError();
      await conversation.turn.appendReply([calling('c1')]);
      throw new Error('the invocation is gone');
    });
    await expect(ask('boom', 'inv_boom')).rejects.toThrow('boom');
    // Retried (a crash right after the close): not the note as an answer.
    await expect(ask('boom', 'inv_boom')).rejects.toThrow('boom');
    await expect(ask('boom', 'inv_boom')).rejects.not.toThrow(/^Error: /);
    await expect(ask('stop', 'inv_stop')).rejects.toBeInstanceOf(restate.CancelledError);
    await expect(ask('stop', 'inv_stop')).rejects.toBeInstanceOf(restate.CancelledError);
    await expect(ask('gone', 'inv_gone')).rejects.toThrow('gone');
    // The next message closes it, ended; the gone invocation, run again, fails with the note.
    await expect(ask('boom', 'inv_next')).rejects.toThrow('boom');
    await expect(ask('gone', 'inv_gone')).rejects.toThrow(ENDED);
  });
});

describe('the turns', () => {
  it('each have the time they were asked', async () => {
    const { ask, inAttempt } = asking(async () => 'fine');
    const before = Date.now();
    await ask('q0');
    const after = Date.now();
    const [turn] = (await inAttempt((ctx) => Conversation.load(ctx.db, ITEMS))).transcript;
    expect(turn!.askedAt).toBeGreaterThanOrEqual(before);
    expect(turn!.askedAt).toBeLessThanOrEqual(after);
  });
});
