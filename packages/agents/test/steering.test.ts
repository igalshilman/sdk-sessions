// Steering, in process, on a made-up framework (fakes/items.ts): a message
// steered to a turn is stored once, as a step of the turn, and the model
// keeps seeing it. The turn runs in a `chat` handler (`chatHandler`, with
// `steers`), whose companion is the tests' (support.ts): its `publish`
// answers the messages a test steers to the turn. The companion itself is
// tested in signals.test.ts, and each framework in its own tests.
import * as restate from '@restatedev/sessions';
import { invoke, Schema } from '@restatedev/sessions/internal';
import { fakeContext, type Made } from '@restatedev/sessions/test/support';
import { describe, expect, it } from 'vitest';
import { chatHandler, sessionObject } from '@restatedev/agents';
import { type Messages, stopSignalOf, toolCallEnded } from '../src/common.ts';
import { answerOnce, Conversation, SCHEMA, STEERED, steerStored, STEPS, TURNS } from '../src/conversation.ts';
import { conversationView, page } from '../src/messages.ts';
import { takeSteers } from '../src/steering.ts';
import { calling, type Item, ITEMS } from './fakes/items.ts';
import { followingOf, sqlAttempt } from './support.ts';

/** How a test's run answers: from the attempt's context and the conversation. */
type Answer = (ctx: restate.SessionContext, conversation: Conversation<Item>) => Promise<string>;

/**
 * An agent's key whose `chat` answers each message with `answer`, a turn
 * that takes steered messages; `steering`, the messages the companion lists
 * for the turn being answered (as its `publish` answers them).
 */
function asker(answer: Answer, options: Parameters<typeof answerOnce>[4] = {}) {
  const map = new Map<string, Uint8Array>();
  const following = followingOf(map);
  let invocations = 0;
  const chat = chatHandler(
    async (ctx, text) => answerOnce(ctx, text, ITEMS, (conversation) => answer(ctx, conversation), options),
    { steers: true },
  );
  return {
    map,
    following,
    /** Ask `text`, in invocation `id` (a new one by default; the same one again for a retry). */
    ask: (text: string, id = `inv${++invocations}`) => {
      const sql = sqlAttempt({ map, key: 'k', id });
      return sql.end(() => chat.handler(sql.ctx, text));
    },
    /** The `messages` view. */
    messages: (request = {}) => {
      const sql = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
      return sql.end(() => page(sql.view.db, ITEMS, request));
    },
    /** What the key's database holds, read with `sql`. */
    rows: (sql: string) => {
      const read = sqlAttempt({ map, key: 'k', id: 'rows', shared: true });
      return read.end(() => read.view.db.values(sql));
    },
  };
}

/** The model's reply with one tool call, and the call's result: the turn's next step is a step. */
async function toolRound(ctx: restate.SessionContext, conversation: Conversation<Item>, callId = 'c1') {
  await conversation.turn.appendReply([calling(callId)]);
  await conversation.turn.append({ result: callId, output: 'found' });
  // The call's end is published: the turn learns of the messages steered to it.
  await toolCallEnded(ctx);
}

const texts = (items: Item[]) => items.map((item) => item.text);

/** Each of `messages` as its id, role and text. */
const said = (messages: { id: number; role: string; parts: { type: string; text?: string }[] }[]) =>
  messages.map((m) => [m.id, m.role, m.parts.map((p) => p.text).join('')]);

describe('a steered message', () => {
  it('is stored once, as a step of the turn, and taken with its store', async () => {
    const took: (string | undefined)[][] = [];
    let seen: Item[] = [];
    const a = asker(async (ctx, conversation) => {
      await toolRound(ctx, conversation);
      took.push(texts(await takeSteers(ctx, conversation)));
      // A later step, with the same message still listed: it is not taken again.
      a.following.steering.push({ id: 's1', text: 'use Celsius' });
      await toolCallEnded(ctx);
      took.push(texts(await takeSteers(ctx, conversation)));
      seen = conversation.history();
      const { turn } = conversation;
      expect(turn.steered().map((e) => e.steer)).toEqual(['s1']);
      // The transcript's entry of the turn has it too, as the next turn loads it.
      expect(turn.prompt.steers?.map((e) => e.steer)).toEqual(['s1']);
      // A steered message asks for no answer of its own: the turn goes on from its prompt.
      expect(turn.latestAsk()).toBe(turn.prompt);
      await turn.appendReply([{ role: 'assistant', text: 'done, in Celsius' }]);
      return 'done, in Celsius';
    });
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    expect(await a.ask('the weather?')).toBe('done, in Celsius');
    expect(took).toEqual([['use Celsius'], []]);
    // The model's next request has the message, after the tool's result.
    expect(seen.slice(-2)).toEqual([
      { result: 'c1', output: 'found' },
      { role: 'user', text: 'use Celsius' },
    ]);
    // The transaction that stored it sent the companion its id, once.
    expect(a.following.taken).toEqual([['s1']]);
    expect(await a.rows(`SELECT n, turn, id FROM ${STEERED}`)).toEqual([[3, 0, 's1']]);
    // A message of the user, in its place, under its position.
    const { messages } = await a.messages();
    expect(messages.map((m) => [m.id, m.role, m.parts.map((p) => (p.type === 'text' ? p.text : p.name))])).toEqual([
      [0, 'user', ['the weather?']],
      [1, 'assistant', ['lookup']],
      [3, 'user', ['use Celsius']],
      [4, 'assistant', ['done, in Celsius']],
    ]);
  });

  it('is not taken while a tool call has no result, nor outside a chat turn, nor once the turn is answered', async () => {
    const took: (string | undefined)[][] = [];
    const a = asker(async (ctx, conversation) => {
      await conversation.turn.appendReply([calling('c1')]);
      await toolCallEnded(ctx);
      took.push(texts(await takeSteers(ctx, conversation)));
      await conversation.turn.append({ result: 'c1', output: 'found' });
      await conversation.turn.appendReply([{ role: 'assistant', text: 'done' }]);
      return 'done';
    });
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    await a.ask('the weather?');
    expect(took).toEqual([[]]);
    expect(a.following.taken).toEqual([]);
    // A prompt of a handler of your own (no `chat` turn): nothing to take.
    const sql = sqlAttempt({ map: a.map, key: 'k', id: 'own' });
    const outside = await sql.end(() =>
      answerOnce(sql.ctx, 'hello', ITEMS, async (conversation) => {
        took.push(texts(await takeSteers(sql.ctx, conversation)));
        return 'hi';
      }),
    );
    expect(outside).toBe('hi');
    expect(took).toEqual([[], []]);
  });

  it('is found stored by a retried attempt, which never takes it again', async () => {
    let attempts = 0;
    const seen: Item[][] = [];
    const a = asker(async (ctx, conversation) => {
      attempts += 1;
      if (attempts === 1) {
        await toolRound(ctx, conversation);
        await takeSteers(ctx, conversation);
        // The attempt fails after the message is stored, before the model's request.
        throw new Error('crash');
      }
      // The companion lists it again (its `taken` came after this publish): it is stored already.
      a.following.steering.push({ id: 's1', text: 'use Celsius' });
      await toolCallEnded(ctx);
      expect(await takeSteers(ctx, conversation)).toEqual([]);
      seen.push(conversation.history());
      await conversation.turn.appendReply([{ role: 'assistant', text: 'done' }]);
      return 'done';
    });
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    await expect(a.ask('the weather?', 'inv1')).rejects.toThrow('crash');
    expect(await a.ask('the weather?', 'inv1')).toBe('done');
    expect(seen[0]!.filter((item) => item.text === 'use Celsius')).toHaveLength(1);
    expect(seen[0]!.at(-1)).toEqual({ role: 'user', text: 'use Celsius' });
    expect(await a.rows(`SELECT id FROM ${STEERED}`)).toEqual([['s1']]);
  });

  it('reaches the model in an earlier turn as its prompt, its steered messages and its answer', async () => {
    let turns = 0;
    let seen: Item[] = [];
    const a = asker(
      async (ctx, conversation) => {
        turns += 1;
        if (turns === 1) {
          await toolRound(ctx, conversation);
          await takeSteers(ctx, conversation);
        } else seen = conversation.history();
        await conversation.turn.appendReply([{ role: 'assistant', text: `answer ${turns}` }]);
        return `answer ${turns}`;
      },
      { window: 0 },
    );
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    await a.ask('the weather?');
    await a.ask('and tomorrow?');
    expect(seen).toEqual([
      { role: 'user', text: 'the weather?' },
      { role: 'user', text: 'use Celsius' },
      { role: 'assistant', text: 'answer 1' },
      { role: 'user', text: 'and tomorrow?' },
    ]);
  });

  it("counts toward the budget with its turn's prompt and answer", async () => {
    const long = 'x'.repeat(400);
    let turns = 0;
    let earlier: number[] = [];
    // A budget of 100 tokens: 400 characters. The first turn's prompt and answer fit; with the steered message, not.
    const a = asker(
      async (ctx, conversation) => {
        turns += 1;
        if (turns === 1) {
          await toolRound(ctx, conversation);
          await takeSteers(ctx, conversation);
        } else earlier = conversation.earlier().map((e) => e.n);
        await conversation.turn.appendReply([{ role: 'assistant', text: 'ok' }]);
        return 'ok';
      },
      { window: 0, budget: 100 },
    );
    a.following.steering.push({ id: 's1', text: long });
    await a.ask('the weather?');
    await a.ask('and tomorrow?');
    expect(earlier).toEqual([]);
  });

  it('is taken by no turn that stopped, nor once the turn has stopped as it gets the ledger', async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    following.steering.push({ id: 's1', text: 'use Celsius' });
    const took: (string | undefined)[][] = [];
    const done = Promise.withResolvers<void>();
    const sql = sqlAttempt({ map, key: 'k', id: 'inv1' });
    const chat = chatHandler(
      async (ctx, text) =>
        answerOnce(ctx, text, ITEMS, async (conversation) => {
          await toolRound(ctx, conversation);
          // Stopped as it gets the ledger (`going` says no more): it takes none.
          took.push(
            texts(
              await conversation.turn.steer(
                following.steering,
                () => {},
                () => false,
              ),
            ),
          );
          const stopped = new Promise<void>((resolve) =>
            stopSignalOf(ctx)!.addEventListener('abort', () => resolve(), { once: true }),
          );
          sql.cancel();
          await stopped;
          // Left behind by its stopped turn: it takes none either.
          took.push(texts(await takeSteers(ctx, conversation)));
          done.resolve();
          return 'never';
        }),
      { steers: true },
    );
    await expect(sql.end(() => chat.handler(sql.ctx, 'the weather?'))).rejects.toBeInstanceOf(restate.CancelledError);
    await done.promise;
    expect(took).toEqual([[], []]);
    expect(following.taken).toEqual([]);
    const read = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
    expect(await read.end(() => steerStored(read.view.db, 's1'))).toBe(false);
  });

  it('is not what the output check asks again from: it asks again once after one', async () => {
    let runs = 0;
    const asks: (string | undefined)[] = [];
    const a = asker(
      async (ctx, conversation) => {
        runs += 1;
        if (runs === 1) {
          await toolRound(ctx, conversation);
          await takeSteers(ctx, conversation);
        }
        asks.push(conversation.turn.latestAsk().item.text);
        const text = runs === 1 ? 'not json' : '{"ok":true}';
        await conversation.turn.appendReply([{ role: 'assistant', text }]);
        return text;
      },
      { check: (answer) => (answer.startsWith('{') ? undefined : 'Answer in JSON.') },
    );
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    expect(await a.ask('the weather?')).toBe('{"ok":true}');
    expect(asks).toEqual(['the weather?', 'Answer in JSON.']);
    expect(runs).toBe(2);
  });

  it('is dropped with the reply before it, which the model is asked again for: then free to be a turn of its own', async () => {
    const a = asker(async (ctx, conversation) => {
      await toolRound(ctx, conversation);
      await takeSteers(ctx, conversation);
      const reply = conversation.turn.replies()[0]!;
      await conversation.turn.drop(reply);
      expect(conversation.turn.steered()).toEqual([]);
      expect(conversation.turn.prompt.steers).toEqual([]);
      await conversation.turn.appendReply([{ role: 'assistant', text: 'again' }]);
      return 'again';
    });
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    await a.ask('the weather?');
    expect(await a.rows(`SELECT id FROM ${STEERED}`)).toEqual([]);
  });

  it('shows in the summary view in its turn, once, also from a cursor', async () => {
    const a = asker(async (ctx, conversation) => {
      await toolRound(ctx, conversation);
      await takeSteers(ctx, conversation);
      await conversation.turn.appendReply([{ role: 'assistant', text: 'done' }]);
      return 'done';
    });
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    await a.ask('the weather?');
    const summary = await a.messages({ view: 'summary' });
    expect(said(summary.messages)).toEqual([
      [0, 'user', 'the weather?'],
      [3, 'user', 'use Celsius'],
      [4, 'assistant', 'done'],
    ]);
    // From a cursor after the prompt: the steered message and the answer, once each.
    const since = await a.messages({ view: 'summary', cursor: 1 });
    expect(said(since.messages)).toEqual([
      [3, 'user', 'use Celsius'],
      [4, 'assistant', 'done'],
    ]);
    // A page back from the answer: the prompt and the steered message.
    const back = await a.messages({ view: 'summary', before: 4 });
    expect(said(back.messages)).toEqual([
      [0, 'user', 'the weather?'],
      [3, 'user', 'use Celsius'],
    ]);
  });

  it('is taken by one turn only: listed to a later turn again, it is taken no more', async () => {
    let turns = 0;
    const took: (string | undefined)[][] = [];
    const a = asker(async (ctx, conversation) => {
      turns += 1;
      await toolRound(ctx, conversation, `c${turns}`);
      // The companion lists it to the second turn too (its close forgot it late, say).
      if (turns === 2) a.following.steering.push({ id: 's1', text: 'use Celsius' });
      await toolCallEnded(ctx);
      took.push(texts(await takeSteers(ctx, conversation)));
      await conversation.turn.appendReply([{ role: 'assistant', text: `answer ${turns}` }]);
      return `answer ${turns}`;
    });
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    await a.ask('the weather?');
    expect(await a.ask('and tomorrow?')).toBe('answer 2');
    expect(took).toEqual([['use Celsius'], []]);
    expect(await a.rows(`SELECT id, turn FROM ${STEERED}`)).toEqual([['s1', 0]]);
  });

  it("is taken once of the messages given with the same id, and the companion is told each id's take once", async () => {
    const a = asker(async (ctx, conversation) => {
      await toolRound(ctx, conversation);
      expect(texts(await takeSteers(ctx, conversation))).toEqual(['use Celsius', 'and the rain']);
      await conversation.turn.appendReply([{ role: 'assistant', text: 'done' }]);
      return 'done';
    });
    a.following.steering.push(
      { id: 's1', text: 'use Celsius' },
      { id: 's1', text: 'use Celsius' },
      { id: 's2', text: 'and the rain' },
    );
    await a.ask('the weather?');
    expect(a.following.taken).toEqual([['s1', 's2']]);
  });
});

describe("the conversation's steered messages", () => {
  it('come to a database of the schema before steering, which takes their table as it opens', async () => {
    const map = new Map<string, Uint8Array>();
    // The schema as it was: the same steps, but the last.
    const before = new Schema(SCHEMA.name, SCHEMA.steps.slice(0, -1));
    const old = sqlAttempt({ map, key: 'k', id: 'old' });
    await old.end(async () => {
      await before.ensure(old.ctx.db);
      await old.ctx.db.execute(`INSERT INTO ${TURNS} (n, seq, prompt, item, asked_at) VALUES (0, 1, 'p0', ?, 0)`, [
        JSON.stringify({ role: 'user', text: 'hi' }),
      ]);
    });
    const sql = sqlAttempt({ map, key: 'k', id: 'new' });
    const loaded = await sql.end(async () => {
      const conversation = await Conversation.load(sql.ctx.db, ITEMS);
      return [conversation.transcript.length, await steerStored(sql.ctx.db, 's1')];
    });
    expect(loaded).toEqual([1, false]);
  });

  it('are kept in the steps table with their items, and in their own table by position', async () => {
    const a = asker(async (ctx, conversation) => {
      await toolRound(ctx, conversation);
      await takeSteers(ctx, conversation);
      await conversation.turn.appendReply([{ role: 'assistant', text: 'done' }]);
      return 'done';
    });
    a.following.steering.push({ id: 's1', text: 'use Celsius' });
    await a.ask('the weather?');
    expect(await a.rows(`SELECT s.item FROM ${STEPS} s JOIN ${STEERED} st ON st.n = s.n`)).toEqual([
      [JSON.stringify({ role: 'user', text: 'use Celsius' })],
    ]);
  });
});

/** The companion's answers: its `steer` holds the message for the turn being answered. */
const companion = (call: Made) => (call.method === 'steer' ? { id: 'inv_view', turn: 'inv_turn' } : { revision: 1 });

/** An agent on the made-up framework, which answers each message with its text; its calls and sends. */
function steerable() {
  const agent = sessionObject({
    name: 'steerable',
    handlers: {
      chat: chatHandler(
        (ctx, text) =>
          answerOnce(ctx, text, ITEMS, async (conversation) => {
            await conversation.turn.appendReply([{ role: 'assistant', text: `answered: ${text}` }]);
            return `answered: ${text}`;
          }),
        { steers: true },
      ),
    },
    views: { messages: conversationView(ITEMS) },
  });
  const map = new Map<string, Uint8Array>();
  const calls: Made[] = [];
  const run = (handler: string, input?: unknown, id = 'inv') =>
    invoke(
      agent,
      handler,
      fakeContext({ map, service: 'steerable', key: 'alice', id, calls, answer: companion }),
      input,
    );
  /** The conversation's messages, as text. */
  const shown = async () =>
    ((await run('messages', {}, 'read')) as Messages).messages.map((m) =>
      m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    );
  return { run, calls, shown };
}

describe("an agent's steer view and steered handler", () => {
  it('answers a steered message that no turn took as a turn of its own', async () => {
    const { run, shown } = steerable();
    await run('steered', { id: 's1', text: 'use Celsius' }, 'inv_s1');
    expect(await shown()).toEqual(['use Celsius', 'answered: use Celsius']);
  });

  it("does nothing for a message a turn stored, whatever the turn's end", async () => {
    const map = new Map<string, Uint8Array>();
    const sql = sqlAttempt({ map, key: 'alice', id: 'mark' });
    await sql.end(async () => {
      await SCHEMA.ensure(sql.ctx.db);
      await sql.ctx.db.execute(`INSERT INTO ${STEERED} (n, turn, id) VALUES (9, 0, 's2')`);
    });
    const agent = sessionObject({
      name: 'steerable',
      handlers: { chat: chatHandler(async () => 'never asked') },
      views: { messages: conversationView(ITEMS) },
    });
    const calls: Made[] = [];
    await invoke(agent, 'steered', fakeContext({ map, service: 'steerable', key: 'alice', id: 'inv_s2', calls }), {
      id: 's2',
      text: 'and the rain',
    });
    expect(calls.map((c) => c.method)).toEqual([]);
  });

  it("sends the message to the companion under the view's request id, which answers who takes it", async () => {
    const { run, calls } = steerable();
    expect(await run('steer', 'use Celsius', 'inv_view')).toEqual({ id: 'inv_view', turn: 'inv_turn' });
    expect(calls.find((c) => c.method === 'steer')).toMatchObject({
      service: 'signals',
      key: 'steerable:alice',
      parameter: { id: 'inv_view', text: 'use Celsius' },
      idempotencyKey: 'inv_view:steer',
    });
  });

  it("refuses a message to an agent whose `chat` no framework's `chat()` made: it could answer it no way", async () => {
    const agent = sessionObject({
      name: 'own',
      handlers: { chat: async (_ctx: restate.SessionContext, text: string) => text },
      views: { messages: conversationView(ITEMS) },
    });
    const ctx = fakeContext({ map: new Map(), service: 'own', key: 'alice', id: 'inv' });
    await expect(invoke(agent, 'steer', ctx, 'hi')).rejects.toThrow(/takes no steered messages/);
    expect(() => invoke(agent, 'steered', ctx, { id: 's', text: 'hi' })).toThrow(/no handler/);
  });

  it('reserves `steer` and `steered` for its own', () => {
    for (const name of ['steer', 'steered']) {
      expect(() =>
        sessionObject({
          name: 'mine',
          handlers: { [name]: async () => 'mine' },
          views: { messages: conversationView(ITEMS) },
        }),
      ).toThrow(/handler of @restatedev\/agents' own/);
    }
  });
});
