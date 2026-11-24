// When a turn forgets its call records (calls.ts): the Restate calls of its
// tools whose results the conversation stored. Each commit of steps settles
// them, once, before anything is published; so do a tool call's start and
// the turn's end. The same for a `chat` turn, a background agent's, and a turn
// outside a `chat` turn (a handler of your own that calls `prompt()`).
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as restate from '@restatedev/sessions';
import { call, chatHandler, sessionObject } from '@restatedev/agents';
import * as claude from '@restatedev/agents/claude';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { reply as tellerReply, teller } from './fakes/claude.ts';
import { sqlAttempt } from './support.ts';
import type * as Calls from '../src/calls.ts';

/** What happened, in order: each commit, each settle (with the call records it kept), each publish. */
const { events } = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('@anthropic-ai/sdk', () => import('./fakes/claude.ts'));
vi.mock('../src/calls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Calls>();
  return {
    ...actual,
    settleCalls: async (ctx: restate.SessionContext, stored: (id: string, failed?: string) => boolean) => {
      await actual.settleCalls(ctx, stored);
      events.push('settle');
    },
  };
});

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

const lookups = restate.service({ name: 'lookups', handlers: { lookup: async (_ctx, _about: unknown) => 'found' } });
const lookup = call(lookups, 'lookup', { name: 'lookup', description: 'Look it up', input: z.object({}) });

/** Claude's model: two rounds of one `lookup` call each, then `Done`. */
function twoRounds() {
  teller.reply = (messages: MessageParam[]) => {
    const message = tellerReply(messages);
    // This turn's results: those after its prompt, the latest message of the user that is no tool's result.
    const isResult = (m: MessageParam) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result');
    const asked = messages.findLastIndex((m) => m.role === 'user' && !isResult(m));
    const results = messages.slice(asked).filter(isResult).length;
    message.content =
      results >= 2
        ? [{ type: 'text', text: 'Done', citations: null }]
        : [{ type: 'tool_use', id: `call_${results + 1}`, name: 'lookup', input: {} }];
    message.stop_reason = results >= 2 ? 'end_turn' : 'tool_use';
    return message;
  };
}

/** What the tools' Restate calls answer. */
const route = async () => 'found';

/** The events of `body`'s turn on `object`, on a key whose first turn (and schemas) ran before. */
async function eventsOf(object: { readonly name: string }, body: (ctx: restate.SessionContext) => Promise<unknown>) {
  const map = new Map<string, Uint8Array>();
  const first = sqlAttempt({ map, key: 'k', id: 'inv0', object, route });
  await first.end(() => body(first.ctx));
  events.length = 0;
  const sql = sqlAttempt({
    map,
    key: 'k',
    id: 'inv1',
    object,
    route,
    onSync: async () => void events.push('commit'),
    published: async () => void events.push('publish'),
  });
  expect(await sql.end(() => body(sql.ctx))).toBe('Done');
  return [...events];
}

const prompt = (ctx: restate.SessionContext, text: string) => claude.prompt(ctx, text, { tools: [lookup] });
const chat = chatHandler(prompt);

/**
 * A turn of two rounds, as before the chat turn took over publishing: per
 * round, the reply with its call commits, and settles (`commitSettles`, then
 * `publish`, in a followed turn); the tool call starts, and settles; the call
 * record commits before the call, and the result's commit (which also has
 * that the call answered) settles (and publishes). What a settle forgets
 * rides the next commit, so the answer's commit writes the last. Then the
 * answer commits, and the turn's end settles.
 */
const turnOf = (commitSettles: string[], publish: string[]) => {
  const round = ['commit', ...commitSettles, ...publish, 'settle', 'commit', 'commit', ...commitSettles, ...publish];
  return [...round, ...round, 'commit', 'settle'];
};

/**
 * The events of each: a `chat` turn's and a turn's outside one are as before
 * (the latter without its publishes, which its `answerOnce` made); a
 * background agent's settles after each commit of steps too, which it did not
 * before (it published nothing, and so settled at a tool call's start only).
 */
const EXPECTED = {
  chat: ['publish', 'commit', ...turnOf(['settle'], ['publish'])],
  background: ['commit', ...turnOf(['settle'], [])],
  outside: ['commit', ...turnOf(['settle'], [])],
};

afterAll(() => {
  teller.reply = tellerReply;
});

describe('call records', () => {
  it("are forgotten after each commit of a `chat` turn's steps, before its publish", async () => {
    twoRounds();
    const agent = sessionObject({ name: 'settling-chat', handlers: { chat } });
    expect(await eventsOf(agent, (ctx) => chat.handler(ctx, 'go'))).toEqual(EXPECTED.chat);
  });

  it("are forgotten after each commit of a background agent's steps", async () => {
    twoRounds();
    const agent = sessionObject({ name: 'settling-quiet', background: true, handlers: { chat } });
    expect(await eventsOf(agent, (ctx) => chat.handler(ctx, 'go'))).toEqual(EXPECTED.background);
  });

  it('are forgotten after each commit of a turn outside a `chat` turn', async () => {
    twoRounds();
    const own = sessionObject({ name: 'settling-own', handlers: { ask: async () => 'unused' } });
    expect(await eventsOf(own, (ctx) => prompt(ctx, 'go'))).toEqual(EXPECTED.outside);
  });
});
