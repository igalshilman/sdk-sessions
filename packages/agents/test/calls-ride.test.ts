// The call records of Restate tools ride the commits that happen anyway
// (calls.ts): that a call answered, and that its record is forgotten, are
// stored with the commit of the call's result (and the turn's answer), not by
// commits of their own. What that must keep: a result is never stored while its
// call is not recorded as answered, whatever the framework, and a crash at
// any point of the turn makes the call once.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as restate from '@restatedev/sessions';
import { call, sessionObject } from '@restatedev/agents';
import { callOf, flushCalls, outcomes, settleCalls } from '../src/calls.ts';
import { CANCELLED, RETURNED_UNRECORDED } from '../src/common.ts';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type Anthropic from '@anthropic-ai/sdk';
import * as claude from '@restatedev/agents/claude';
import * as deepseek from '@restatedev/agents/deepseek';
import * as langgraph from '@restatedev/agents/langgraph';
import * as pi from '@restatedev/agents/pi';
import { tool } from '@restatedev/agents';
import { z } from 'zod';
import { handlerOf, type Made, type PromptHandler, sqlAttempt } from './support.ts';
import { reply as tellerReply, teller } from './fakes/claude.ts';
import { teller as deepseekTeller } from './fakes/deepseek.ts';
import { Teller } from './fakes/langgraph.ts';

vi.mock('@anthropic-ai/sdk', () => import('./fakes/claude.ts'));
vi.mock('@deepseek-ai/dsh-llm-deepseek-api-key', () => import('./fakes/deepseek.ts'));
vi.mock('@earendil-works/pi-ai/providers/all', async () => {
  const { fakeProvider, callTools, say } = await import('./fakes/pi.ts');
  return {
    builtinProviders: () => [
      fakeProvider('openai', 'gpt-6-sol', () => {
        const next = nextCall();
        return next ? callTools([[next.name, {}]], 'On it.') : say('Done');
      }),
    ],
  };
});

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** The model's plan: this many rounds of one call each (`t1`, `t2`...), then the answer. */
const plan = { rounds: 0, asked: 0, ids: 0 };
const nextCall = () => (plan.asked++ < plan.rounds ? { id: `call_${++plan.ids}`, name: `t${plan.asked}` } : undefined);
const planned = (rounds: number) => Object.assign(plan, { rounds, asked: 0 });

const callee = restate.service({
  name: 'callee',
  handlers: {
    t1: async (_c, _x: unknown) => 'r',
    t2: async (_c, _x: unknown) => 'r',
    t3: async (_c, _x: unknown) => 'r',
  },
});
/** What the callee answers: a text only its result has (`result of t1, turn 1`, say). */
const answered =
  (turn = '') =>
  async (c: Made) =>
    `result of ${c.method}${turn}`;
const tools = () => (['t1', 't2', 't3'] as const).map((name) => call(callee, name, { name, description: name }));

/** Claude's model, by the plan. */
function claudePlanned() {
  teller.reply = (messages: MessageParam[]) => {
    const next = nextCall();
    const message = tellerReply(messages);
    message.content = next
      ? [
          { type: 'text', text: 'On it.', citations: null },
          { type: 'tool_use' as const, id: next.id, name: next.name, input: {} },
        ]
      : [{ type: 'text', text: 'Done', citations: null }];
    message.stop_reason = next ? 'tool_use' : 'end_turn';
    return message;
  };
}

class Planned extends Teller {
  override reply(_messages: BaseMessage[]) {
    const next = nextCall();
    if (!next) return new AIMessage('Done');
    return new AIMessage({ content: 'On it.', tool_calls: [{ id: next.id, name: next.name, args: {} }] });
  }
}

const ownGraph = () => {
  const model = new Planned({});
  return new StateGraph(MessagesAnnotation)
    .addNode('model', async ({ messages }) => ({ messages: [await model.invoke(messages)] }))
    .addNode('tools', new ToolNode(langgraph.tools(tools())))
    .addEdge(START, 'model')
    .addConditionalEdges('model', toolsCondition)
    .addEdge('tools', 'model');
};

/** DeepSeek's model, by the plan. */
function deepseekPlanned() {
  deepseekTeller.reply = () => {
    const next = nextCall();
    return next ? { call: { id: ToolCallId(next.id), name: next.name, args: {} } } : { text: 'Done' };
  };
}

afterAll(() => {
  teller.reply = tellerReply;
});

const quiet = (name: string) => sessionObject({ name, background: true, handlers: {}, views: {} });

/** The calls row as the key's committed state has it, and whether any other table has `text`. */
async function committed(map: Map<string, Uint8Array>, text: string) {
  const read = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
  return read.end(async () => {
    const { db } = read;
    const row = await db.get<{ calls: string }>('SELECT calls FROM restate_agent_calls').catch(() => undefined);
    const records = row ? (JSON.parse(row.calls) as { tool: string; done?: true }[]) : [];
    const tables = await db.values(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'restate_agent_calls'",
    );
    let found = false;
    for (const [name] of tables) {
      const rows = await db.values(`SELECT * FROM "${String(name)}"`);
      const dump = JSON.stringify(rows, (_k, v: unknown) =>
        v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
      );
      if (dump.includes(text)) found = true;
    }
    return { records, found };
  });
}

describe('a call that answered', () => {
  /**
   * Whenever a commit stores a call's result (found in any table of the
   * key's database), the call's record in the same state says it answered,
   * or is gone: observed after each commit of a turn of three calls.
   */
  const AGENTS: [string, () => PromptHandler][] = [
    ['Claude', () => (claudePlanned(), claude.chat({ tools: tools() }))],
    ['the built-in LangGraph loop', () => langgraph.chat({ model: new Planned({}), tools: tools() })],
    ['a LangGraph graph of your own', () => langgraph.chat({ graph: ownGraph() })],
    ['DeepSeek', () => (deepseekPlanned(), deepseek.chat({ tools: tools() }))],
    ['pi', () => pi.chat({ tools: tools(), commits: 'each' })],
    ['pi with `commits: effects`', () => pi.chat({ tools: tools(), commits: 'effects' })],
  ];

  it.each(AGENTS)('is recorded when the commit stores its result: %s', async (_name, chat) => {
    const map = new Map<string, Uint8Array>();
    const object = quiet(`ride-${_name.replace(/\W+/g, '-')}`);
    const handler = handlerOf(chat());
    const seen = new Set<string>();
    const violations: string[] = [];
    for (const [i, text] of ['first', 'second'].entries()) {
      planned(3);
      const sql = sqlAttempt({
        map,
        key: 'k',
        id: `inv${i}`,
        object,
        route: answered(`, turn ${i}`),
        // The state as this commit left it: the object's state is written before the commit's sync.
        onSync: async () => {
          for (const k of [1, 2, 3]) {
            const { records, found } = await committed(map, `result of t${k}, turn ${i}`);
            if (!found) continue;
            seen.add(`t${k}`);
            for (const r of records)
              if (r.tool === `callee/t${k}` && !r.done) violations.push(`t${k}: ${JSON.stringify(r)}`);
          }
        },
      });
      expect(await sql.end(() => handler(sql.ctx, text))).toBe('Done');
    }
    expect(violations).toEqual([]);
    expect([...seen].toSorted()).toEqual(['t1', 't2', 't3']);
  });
});

/** The key's calls row as committed: its records. */
const recordsOf = async (map: Map<string, Uint8Array>) => (await committed(map, '\0')).records;

describe("a call's records", () => {
  it('ride the next commit: answered and settled write nothing, the next write or a flush does', async () => {
    const map = new Map<string, Uint8Array>();
    let syncs = 0;
    const sql = sqlAttempt({ map, key: 'k', id: 'inv1', onSync: async () => void syncs++ });
    await sql.end(async () => {
      const { ctx } = sql;
      const first = await callOf(ctx, 'pay', { n: 1 }, 'c1');
      // The record of a new call commits before the call.
      expect(await recordsOf(map)).toMatchObject([{ tool: 'pay' }]);
      syncs = 0;
      await first.answered();
      expect(syncs).toBe(0);
      expect((await recordsOf(map))[0]).not.toHaveProperty('done');
      await flushCalls(ctx);
      expect(syncs).toBe(1);
      expect(await recordsOf(map)).toMatchObject([{ tool: 'pay', done: true }]);
      // Settled, it is forgotten with the next commit; a flush with none pending commits nothing.
      await settleCalls(ctx, () => true);
      expect(syncs).toBe(1);
      expect(await recordsOf(map)).toHaveLength(1);
      await ctx.db.execute('CREATE TABLE IF NOT EXISTS other (x)');
      expect(syncs).toBe(2);
      expect(await recordsOf(map)).toEqual([]);
      await flushCalls(ctx);
      expect(syncs).toBe(2);
    });
  });

  it("are written whole by the next call's record, which commits before its call", async () => {
    const map = new Map<string, Uint8Array>();
    let syncs = 0;
    const sql = sqlAttempt({ map, key: 'k', id: 'inv1', onSync: async () => void syncs++ });
    await sql.end(async () => {
      const { ctx } = sql;
      await (await callOf(ctx, 'pay', { n: 1 }, 'c1')).answered();
      syncs = 0;
      await callOf(ctx, 'pay', { n: 2 }, 'c2');
      // One commit, with the answer of the first in it, and nothing pending after.
      expect(syncs).toBe(1);
      expect(await recordsOf(map)).toMatchObject([{ ids: ['c1'], done: true }, { ids: ['c2'] }]);
      await flushCalls(ctx);
      expect(syncs).toBe(1);
    });
  });

  it('are written at once when another call is in flight: a call that answered is not left unrecorded during its wait', async () => {
    const map = new Map<string, Uint8Array>();
    let syncs = 0;
    const sql = sqlAttempt({ map, key: 'k', id: 'inv1', onSync: async () => void syncs++ });
    await sql.end(async () => {
      const { ctx } = sql;
      const first = await callOf(ctx, 'pay', { n: 1 }, 'c1');
      const second = await callOf(ctx, 'wait', {}, 'c2');
      syncs = 0;
      await first.answered();
      expect(syncs).toBe(1);
      expect(await recordsOf(map)).toMatchObject([{ ids: ['c1'], done: true }, { ids: ['c2'] }]);
      // The last in flight rides.
      await second.answered();
      expect(syncs).toBe(1);
      // A call that failed to answer is no longer in flight.
      const third = await callOf(ctx, 'pay', { n: 3 }, 'c3');
      const fourth = await callOf(ctx, 'pay', { n: 4 }, 'c4');
      third.left();
      syncs = 0;
      await fourth.answered();
      expect(syncs).toBe(0);
    });
  });
});

describe("a stopped turn's report of a call", () => {
  it('reads the attempt itself: a call that answered returned, though its record is not stored yet', async () => {
    const map = new Map<string, Uint8Array>();
    const sql = sqlAttempt({ map, key: 'k', id: 'inv1' });
    await sql.end(async () => {
      const { ctx } = sql;
      await (await callOf(ctx, 'pay', { n: 1 }, 'c1')).answered();
      expect(await outcomes(ctx, ['c1'])).toEqual(new Map([['c1', undefined]]));
      // Another invocation that closes the turn reads the stored row, where it did not answer yet: it reads as
      // cut off, as a crash between the call's return and its record would have left it.
      const other = sqlAttempt({ map, key: 'k', id: 'inv2' });
      await other.end(async () => {
        expect(await outcomes(other.ctx, ['c1'], 'inv1')).toEqual(new Map());
      });
    });
  });

  it('is that the call returned, for a Claude turn stopped while a tool that is no call runs', async () => {
    const hang = tool({
      name: 'hang',
      description: 'hangs',
      input: z.object({}),
      run: () => new Promise<never>(() => {}),
    });
    teller.reply = (messages: MessageParam[]) => {
      const message = tellerReply(messages);
      message.content = [
        { type: 'tool_use', id: 'c1', name: 't1', input: {} },
        { type: 'tool_use', id: 'c2', name: 'hang', input: {} },
      ];
      message.stop_reason = 'tool_use';
      return message;
    };
    const map = new Map<string, Uint8Array>();
    const returned = Promise.withResolvers<void>();
    const sql = sqlAttempt({
      map,
      key: 'k',
      id: 'inv1',
      route: async () => (returned.resolve(), 'result of t1'),
    });
    const chat = handlerOf(claude.chat({ tools: [...tools().slice(0, 1), hang] }));
    const turn = sql.end(() => chat(sql.ctx, 'go')).catch((error: unknown) => error);
    await returned.promise;
    // The record of the call is not stored as answered: its commit comes with its result's, which the hung tool holds back.
    await vi.waitFor(async () => expect(await recordsOf(map)).toMatchObject([{ tool: 'callee/t1' }]));
    expect((await recordsOf(map))[0]).not.toHaveProperty('done');
    sql.cancel();
    expect(await turn).toBeInstanceOf(restate.CancelledError);
    const read = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
    const items = await read.end(() => read.db.values('SELECT item FROM restate_agent_items ORDER BY n'));
    const results = items
      .map(([item]) => JSON.parse(String(item)) as MessageParam)
      .flatMap(({ content }) => (Array.isArray(content) ? content : []))
      .flatMap((b) => (b.type === 'tool_result' ? [[b.tool_use_id, JSON.stringify(b.content)] as const] : []));
    expect(results).toHaveLength(2);
    expect(results[0]![0]).toBe('c1');
    expect(results[0]![1]).toContain(RETURNED_UNRECORDED);
    expect(results[1]).toEqual(['c2', expect.stringContaining(CANCELLED)]);
  });
});

/**
 * Claude's model as the transcript says: `rounds` calls of `t1` (ids `call_1`,
 * `call_2`...), one after each result, then `Done`: the same whichever attempt
 * asks.
 */
function claudeByResults(rounds: number) {
  teller.reply = (messages: MessageParam[]) => {
    const message = tellerReply(messages);
    const isResult = (m: MessageParam) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result');
    const asked = messages.findLastIndex((m) => m.role === 'user' && !isResult(m));
    const results = messages.slice(asked).filter(isResult).length;
    message.content =
      results >= rounds
        ? [{ type: 'text', text: 'Done', citations: null }]
        : [{ type: 'tool_use', id: `call_${results + 1}`, name: 't1', input: {} }];
    message.stop_reason = results >= rounds ? 'end_turn' : 'tool_use';
    return message;
  };
}

/** The ids of the tool results of the key's transcript, in order. */
async function resultIds(map: Map<string, Uint8Array>) {
  const read = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
  const items = await read.end(() => read.db.values('SELECT item FROM restate_agent_items ORDER BY n'));
  return items
    .map(([item]) => JSON.parse(String(item)) as MessageParam)
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : []));
}

describe('a crash', () => {
  it('after a call answered and before its result is stored: the retry makes it under the same key, one result', async () => {
    claudeByResults(1);
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    const keys: (string | undefined)[] = [];
    const first = sqlAttempt({
      map,
      fence,
      key: 'k',
      id: 'inv1',
      route: async (c) => {
        keys.push(c.idempotencyKey);
        // The attempt ends as the call returns: its record of the answer was not written.
        fence.closed = true;
        first.abort();
        return 'result of t1';
      },
    });
    const chat = handlerOf(claude.chat({ tools: tools() }));
    await expect(first.end(() => chat(first.ctx, 'go'))).rejects.toThrow(/fenced|attempt ended/);
    expect((await recordsOf(map))[0]).not.toHaveProperty('done');
    const retry = sqlAttempt({
      map,
      key: 'k',
      id: 'inv1',
      route: async (c) => (keys.push(c.idempotencyKey), 'result of t1'),
    });
    expect(await retry.end(() => chat(retry.ctx, 'go'))).toBe('Done');
    expect(keys).toEqual(['inv1:call_1', 'inv1:call_1']);
    expect(await resultIds(map)).toEqual(['call_1']);
  });

  it('right after its result is stored: the retry forgets the record, and a later identical call is a new call', async () => {
    claudeByResults(2);
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    const keys: (string | undefined)[] = [];
    const first = sqlAttempt({
      map,
      fence,
      key: 'k',
      id: 'inv1',
      route: async (c) => (keys.push(c.idempotencyKey), 'result of t1'),
      // The commit that stores the result is the crash's last: the next write fails.
      onSync: async () => {
        if (!(await committed(map, 'result of t1')).found) return;
        fence.closed = true;
        first.abort();
      },
    });
    const chat = handlerOf(claude.chat({ tools: tools() }));
    await expect(first.end(() => chat(first.ctx, 'go'))).rejects.toThrow(/fenced|attempt ended/);
    // Stored with the result: the call answered, and its forgetting has not been written.
    expect(await resultIds(map)).toEqual(['call_1']);
    expect(await recordsOf(map)).toMatchObject([{ ids: ['call_1'], done: true }]);
    const retry = sqlAttempt({
      map,
      key: 'k',
      id: 'inv1',
      route: async (c) => (keys.push(c.idempotencyKey), 'result of t1'),
    });
    expect(await retry.end(() => chat(retry.ctx, 'go'))).toBe('Done');
    // The same tool and input again, under a new id: not the call the model has the result of.
    expect(keys).toEqual(['inv1:call_1', 'inv1:call_2']);
    expect(await resultIds(map)).toEqual(['call_1', 'call_2']);
  });

  it("after a call answered, in DeepSeek: the model's call again, under a new id, is the earlier call", async () => {
    let asked = 0;
    deepseekTeller.reply = () =>
      ++asked <= 2 ? { call: { id: ToolCallId(`call_${asked}`), name: 't1', args: {} } } : { text: 'Done' };
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    const keys: (string | undefined)[] = [];
    const first = sqlAttempt({
      map,
      fence,
      key: 'k',
      id: 'inv1',
      route: async (c) => {
        keys.push(c.idempotencyKey);
        fence.closed = true;
        first.abort();
        return 'result of t1';
      },
    });
    const chat = handlerOf(deepseek.chat({ tools: tools() }));
    await expect(first.end(() => chat(first.ctx, 'go'))).rejects.toThrow(/fenced|attempt ended/);
    const retry = sqlAttempt({
      map,
      key: 'k',
      id: 'inv1',
      route: async (c) => (keys.push(c.idempotencyKey), 'result of t1'),
    });
    expect(await retry.end(() => chat(retry.ctx, 'go'))).toBe('Done');
    expect(keys).toEqual(['inv1:call_1', 'inv1:call_1']);
  });
});

describe('two calls at once', () => {
  it('record the first to answer while the other waits: it is not left unrecorded for as long as that takes', async () => {
    teller.reply = (messages: MessageParam[]) => {
      const message = tellerReply(messages);
      const results = messages.at(-1)!.content;
      const done = Array.isArray(results) && results.some((c) => c.type === 'tool_result');
      message.content = done
        ? [{ type: 'text', text: 'Done', citations: null }]
        : [
            { type: 'tool_use', id: 'c1', name: 't1', input: {} },
            { type: 'tool_use', id: 'c2', name: 't2', input: {} },
          ];
      message.stop_reason = done ? 'end_turn' : 'tool_use';
      return message;
    };
    const map = new Map<string, Uint8Array>();
    const gate = Promise.withResolvers<void>();
    const sql = sqlAttempt({
      map,
      key: 'k',
      id: 'inv1',
      route: async (c) => {
        if (c.method === 't2') await gate.promise;
        return `result of ${c.method}`;
      },
    });
    const chat = handlerOf(claude.chat({ tools: tools() }));
    const turn = sql.end(() => chat(sql.ctx, 'go'));
    // The second still waits: the first's answer is stored by a commit of its own.
    await vi.waitFor(async () =>
      expect(await recordsOf(map)).toMatchObject([{ tool: 'callee/t1', done: true }, { tool: 'callee/t2' }]),
    );
    expect((await recordsOf(map))[1]).not.toHaveProperty('done');
    gate.resolve();
    expect(await turn).toBe('Done');
  });
});
