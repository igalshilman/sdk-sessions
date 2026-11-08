// An agent's conversation as clients read it (messages.ts): pages and
// cursors, rendered from the conversation's own rows. The Python SDK's
// tests/agents_messages.py, test for test.
import type * as restate from '@restatedev/sessions';
import { describe, expect, it } from 'vitest';
import type { Messages, MessagesRequest } from '../src/common.ts';
import { Conversation, type Entry, nextStart, restart, STEPS, TURNS } from '../src/conversation.ts';
import { page } from '../src/messages.ts';
import { type Item, ITEMS } from './fakes/items.ts';
import { sqlAttempt } from './support.ts';

const load = (ctx: restate.SessionContext) => Conversation.load(ctx.db, ITEMS);

/** An object of its own, whose handlers write its conversation step by step, and `read` its pages. */
function rendered() {
  const map = new Map<string, Uint8Array>();
  let n = 0;
  const run = <T>(body: (ctx: restate.SessionContext) => Promise<T>) => {
    const sql = sqlAttempt({ map, key: 'k', id: `inv_${++n}` });
    return sql.end(() => body(sql.ctx));
  };
  return {
    ask: (text: string) =>
      run(async (ctx) => {
        const conversation = await load(ctx);
        // Turns never overlap: the one before is answered first, with its last reply.
        const running = conversation.running();
        if (running) await running.answered(running.finalReply() ?? '');
        await conversation.ask(`${ctx.request.id}:${conversation.transcript.length}`, text);
      }),
    answer: (text: string) => run(async (ctx) => (await load(ctx)).turn.answered(text)),
    reply: (...items: Item[]) => run(async (ctx) => (await load(ctx)).turn.appendReply(items)),
    append: (...items: Item[]) => run(async (ctx) => (await load(ctx)).turn.append(...items)),
    drop: (reply: number) => run(async (ctx) => (await load(ctx)).turn.drop(reply)),
    clear: () =>
      run(async (ctx) => {
        await load(ctx);
        const start = await nextStart(ctx.db);
        await ctx.db.transaction(async (tx) => {
          await tx.execute(`DELETE FROM ${TURNS}`);
          await tx.execute(`DELETE FROM ${STEPS}`);
          await restart(tx, start);
        });
      }),
    read: (request: MessagesRequest = {}): Promise<Messages> => {
      const sql = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
      return sql.end(() => page(sql.view.db, ITEMS, request));
    },
  };
}

const texts = (messages: Messages) =>
  messages.messages.map((m) => [m.id, m.parts.map((p) => (p.type === 'text' ? p.text : p.name)).join(' ')]);

const WEATHER = { id: 'call-1', name: 'get_weather', input: { city: 'Lisbon' } };

describe('messages', () => {
  it('reads the conversation in pages, and from a cursor', async () => {
    const chat = rendered();
    await chat.ask('What is the weather in Lisbon?');
    await chat.reply({ role: 'assistant', text: '', calls: [WEATHER] });
    const first = await chat.read();
    expect(texts(first)).toEqual([
      [0, 'What is the weather in Lisbon?'],
      [1, 'get_weather'],
    ]);
    // The tool call's output comes: its message grows in place, keeps its id, and moves past the cursor.
    await chat.append({ result: 'call-1', output: 'Sunny' });
    await chat.reply({ role: 'assistant', text: 'It is sunny in Lisbon.' });
    const changed = await chat.read({ cursor: first.cursor });
    expect(changed.messages.map((m) => m.id)).toEqual([1, 3]);
    expect(changed.messages[0]!.parts).toEqual([{ ...WEATHER, type: 'tool', output: 'Sunny' }]);
    // Nothing changed since: nothing to read, and the cursor stays.
    expect((await chat.read()).cursor).toBe(changed.cursor);
    expect((await chat.read({ cursor: changed.cursor })).messages).toEqual([]);
  });

  it('reads back only as many prompts as a page shows', async () => {
    const chat = rendered();
    for (let n = 0; n < 5; n++) {
      await chat.ask(`question ${n}`);
      await chat.reply({ role: 'assistant', text: `answer ${n}` });
    }
    const latest = await chat.read({ limit: 3 });
    expect(texts(latest)).toEqual([
      [7, 'answer 3'],
      [8, 'question 4'],
      [9, 'answer 4'],
    ]);
    expect(latest.more).toBe(true);
    const earlier = await chat.read({ limit: 3, before: 7 });
    expect(texts(earlier)).toEqual([
      [4, 'question 2'],
      [5, 'answer 2'],
      [6, 'question 3'],
    ]);
    expect(earlier.more).toBe(true);
    const first = await chat.read({ limit: 3, before: 2 });
    expect(texts(first)).toEqual([
      [0, 'question 0'],
      [1, 'answer 0'],
    ]);
    expect(first.more).toBe(false);
  });

  it('reads no messages with a limit of 0: the cursor, and whether there are any', async () => {
    const chat = rendered();
    for (let n = 0; n < 2; n++) {
      await chat.ask(`question ${n}`);
      await chat.reply({ role: 'assistant', text: `answer ${n}` });
    }
    const all = await chat.read();
    for (const view of ['full', 'summary'] as const) {
      const none = await chat.read({ limit: 0, view });
      expect([view, none.messages, none.more, none.cursor]).toEqual([view, [], true, all.cursor]);
    }
  });

  it("marks an error output, which is a call's result only if it is its own error", async () => {
    const chat = rendered();
    await chat.ask('Charge me');
    await chat.reply({ role: 'assistant', text: '', calls: [{ id: 'call-1', name: 'charge', input: { amount: 5 } }] });
    await chat.append({ result: 'call-1', output: 'Error: card declined' });
    const [, message] = (await chat.read()).messages;
    expect(message!.parts[0]).toMatchObject({ error: true });

    const entries: Entry<Item>[] = [
      { n: 0, item: { role: 'user', text: 'go' }, prompt: 'p0' },
      { n: 1, item: { result: 'call-1', output: 'Error: no' } },
    ];
    const turn = new Conversation(undefined as unknown as restate.Database, ITEMS, entries).turn;
    // An error is the call's result only if the call answered with it (see calls.ts).
    expect(turn.stored('call-1')).toBe(false);
    expect(turn.stored('call-1', 'Error: no')).toBe(true);
  });

  it('replaces a dropped reply under its ids, and a cursor sees the replacement', async () => {
    const chat = rendered();
    await chat.ask('Hi');
    const blocked = await chat.reply({ role: 'assistant', text: 'blocked' });
    const { cursor } = await chat.read();
    await chat.drop(blocked);
    await chat.reply({ role: 'assistant', text: 'fine' });
    expect(texts(await chat.read({ cursor }))).toEqual([[blocked, 'fine']]);
    expect(texts(await chat.read())).toEqual([
      [0, 'Hi'],
      [1, 'fine'],
    ]);
  });

  it('goes on from its ids and cursors once cleared', async () => {
    const chat = rendered();
    await chat.ask('before');
    await chat.reply({ role: 'assistant', text: 'noted' });
    const { cursor } = await chat.read();
    await chat.clear();
    const emptied = await chat.read();
    expect([emptied.messages, emptied.first, emptied.cursor]).toEqual([[], 2, cursor]);
    await chat.ask('after');
    const after = await chat.read();
    expect(texts(after)).toEqual([[2, 'after']]);
    expect([after.first, after.cursor]).toEqual([2, cursor + 1]);
    expect(texts(await chat.read({ cursor }))).toEqual([[2, 'after']]);
  });

  it('summarizes each turn as its message and answer, under their ids', async () => {
    const chat = rendered();
    await chat.ask('What is the weather in Lisbon?');
    await chat.reply({ role: 'assistant', text: '', calls: [WEATHER] });
    await chat.append({ result: 'call-1', output: 'Sunny' });
    await chat.reply({ role: 'assistant', text: 'It is sunny in Lisbon.' });
    // The turn has no answer yet: the summary is its message alone, while the full view shows its steps.
    const before = await chat.read({ view: 'summary' });
    expect(texts(before)).toEqual([[0, 'What is the weather in Lisbon?']]);
    await chat.answer('Sunny, 24 degrees.');
    await chat.ask('Thanks');
    const summary = await chat.read({ view: 'summary' });
    // The answer has the id of the turn's last message of the assistant, as the full view shows it.
    expect(texts(summary)).toEqual([
      [0, 'What is the weather in Lisbon?'],
      [3, 'Sunny, 24 degrees.'],
      [4, 'Thanks'],
    ]);
    expect((await chat.read()).messages.map((m) => m.id)).toEqual([0, 1, 3, 4]);
    // A follower of the summary gets the answer once it is stored, then the next message, in that order.
    const changed = await chat.read({ view: 'summary', cursor: before.cursor });
    expect(texts(changed)).toEqual([
      [3, 'Sunny, 24 degrees.'],
      [4, 'Thanks'],
    ]);
    expect((await chat.read({ view: 'summary', cursor: changed.cursor })).messages).toEqual([]);
    // Paging back by turns, as the full view pages.
    const latest = await chat.read({ view: 'summary', limit: 2 });
    expect(texts(latest)).toEqual([
      [3, 'Sunny, 24 degrees.'],
      [4, 'Thanks'],
    ]);
    expect(latest.more).toBe(true);
    const earlier = await chat.read({ view: 'summary', limit: 2, before: 3 });
    expect(texts(earlier)).toEqual([[0, 'What is the weather in Lisbon?']]);
    expect(earlier.more).toBe(false);
  });
});
