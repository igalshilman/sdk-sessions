// What a turn costs: its commits to the key's database (each a flush to
// Restate: two state sets, a run, a round trip) and its calls to the
// companion, for Claude, the built-in LangGraph loop and a graph of your
// own, without a Restate server. A turn of `r` model requests makes `r - 1`
// rounds of `k` tool calls, then answers. And a commit cancelled as it waits
// for Restate: it is stored, and the conversation knows it.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as restate from '@restatedev/sessions';
import { CANCELLED, sessionObject, tool } from '@restatedev/agents';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import * as claude from '@restatedev/agents/claude';
import * as langgraph from '@restatedev/agents/langgraph';
import * as pi from '@restatedev/agents/pi';
import { followingOf, handlerOf, type PromptHandler, sqlAttempt } from './support.ts';
import { reply as tellerReply, teller } from './fakes/claude.ts';
import { Teller } from './fakes/langgraph.ts';

vi.mock('@anthropic-ai/sdk', () => import('./fakes/claude.ts'));

// pi's model, by the plan (`nextCalls`): the default model's provider, OpenAI's.
vi.mock('@earendil-works/pi-ai/providers/all', async () => {
  const { fakeProvider, callTools, say } = await import('./fakes/pi.ts');
  return {
    builtinProviders: () => [
      fakeProvider('openai', 'gpt-6-sol', () => {
        const calls = nextCalls();
        return calls
          ? callTools(
              calls.map(({ name }) => [name, {}]),
              'On it.',
            )
          : say('Done');
      }),
    ],
  };
});

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** The plan of the turn being answered: so many rounds of so many tool calls, then the answer. */
const plan = { rounds: 0, calls: 0, asked: 0, ids: 0 };

/** The tool calls of the model's next reply, if the plan has a round left: each with an id of its own. */
const nextCalls = () =>
  plan.asked++ < plan.rounds
    ? Array.from({ length: plan.calls }, (_, i) => ({ id: `call_${++plan.ids}`, name: `t${i + 1}` }))
    : undefined;

const tools = () =>
  ['t1', 't2', 't3'].map((name) =>
    tool({ name, description: `tool ${name}`, input: z.object({}), run: () => `result of ${name}` }),
  );

/** Claude's model, by the plan. */
function claudePlanned() {
  teller.reply = (messages: MessageParam[]) => {
    const calls = nextCalls();
    const message = tellerReply(messages);
    message.content = calls
      ? [
          { type: 'text', text: 'On it.', citations: null },
          ...calls.map(({ id, name }) => ({ type: 'tool_use' as const, id, name, input: {} })),
        ]
      : [{ type: 'text', text: 'Done', citations: null }];
    message.stop_reason = calls ? 'tool_use' : 'end_turn';
    return message;
  };
}

/** LangGraph's model, by the plan. */
class Planned extends Teller {
  override reply(_messages: BaseMessage[]) {
    const calls = nextCalls();
    if (!calls) return new AIMessage('Done');
    return new AIMessage({ content: 'On it.', tool_calls: calls.map(({ id, name }) => ({ id, name, args: {} })) });
  }
}

/** A graph of your own: a model node and LangGraph's ToolNode, as the usual tool-calling loop. */
const ownGraph = () => {
  const model = new Planned({});
  return new StateGraph(MessagesAnnotation)
    .addNode('model', async ({ messages }) => ({ messages: [await model.invoke(messages)] }))
    .addNode('tools', new ToolNode(langgraph.tools(tools())))
    .addEdge(START, 'model')
    .addConditionalEdges('model', toolsCondition)
    .addEdge('tools', 'model');
};

/** What a turn cost: its commits, and the companion's handlers it called, in order. */
interface Cost {
  commits: number;
  companion: string[];
}

/**
 * Two turns of `chat` on a key of its own, each of `r` requests with `k` tool
 * calls a round: what each cost. `object` is the agent's.
 */
async function costs(
  chat: PromptHandler,
  r: number,
  k: number,
  { object, published }: { object?: { readonly name: string }; published?: () => Promise<void> } = {},
): Promise<Cost[]> {
  const map = new Map<string, Uint8Array>();
  const following = followingOf(map);
  const handler = handlerOf(chat);
  const out: Cost[] = [];
  for (const [i, text] of ['first', 'second'].entries()) {
    Object.assign(plan, { rounds: r - 1, calls: k, asked: 0 });
    let commits = 0;
    const made = following.made.length;
    const onSync = async () => void commits++;
    const sql = sqlAttempt({ map, key: 'k', id: `inv${i}`, onSync, object, published });
    expect(await sql.end(() => handler(sql.ctx, text))).toBe('Done');
    out.push({ commits, companion: following.made.slice(made) });
  }
  return out;
}

const AGENTS: [string, () => PromptHandler, ReturnType<typeof claude.messages>][] = [
  ['Claude', () => (claudePlanned(), claude.chat({ tools: tools() })), claude.messages()],
  [
    'the built-in LangGraph loop',
    () => langgraph.chat({ model: new Planned({}), tools: tools() }),
    langgraph.messages(),
  ],
  ['a LangGraph graph of your own', () => langgraph.chat({ graph: ownGraph() }), langgraph.messages()],
];

/**
 * The commits of a key's second turn, by agent, for a plain turn (`r = 1`)
 * and one of a round of 3 tool calls (`r = 2, k = 3`): its row (`ask`), each
 * reply with tool calls, the tools' results, and the final reply with the
 * answer, in one commit. A graph of your own also commits its checkpoints.
 */
const COMMITS: Record<string, [plain: number, round: number]> = {
  Claude: [2, 4],
  'the built-in LangGraph loop': [2, 4],
};

describe("a turn's commits", () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it.each(AGENTS.filter(([name]) => name in COMMITS))(
    'are one for the final reply and its answer: %s',
    async (name, chat) => {
      const [plain, round] = COMMITS[name]!;
      expect((await costs(chat(), 1, 0))[1]!.commits).toBe(plain);
      expect((await costs(chat(), 2, 3))[1]!.commits).toBe(round);
    },
  );

  it.each(AGENTS)("apply a key's schemas in one commit, on its first turn: %s", async (_name, chat) => {
    for (const [r, k] of [
      [1, 0],
      [2, 3],
    ] as const) {
      const [first, second] = await costs(chat(), r, k);
      expect(first!.commits - second!.commits).toBe(1);
    }
  });
});

describe("a LangGraph turn's tool results", () => {
  it.each(AGENTS.filter(([name]) => name.includes('LangGraph')))(
    'are one write per step, however many tools ran: %s',
    async (_name, chat) => {
      const [, one] = await costs(chat(), 2, 1);
      const [, three] = await costs(chat(), 2, 3);
      expect(three!.commits).toBe(one!.commits);
    },
  );
});

describe("a turn's publishes", () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it.each(AGENTS)(
    'are one after each write of steps that commits, none for the final reply: %s',
    async (_name, chat) => {
      expect((await costs(chat(), 1, 0))[1]!.companion).toEqual(['start', 'close']);
      expect((await costs(chat(), 2, 3))[1]!.companion).toEqual(['start', 'publish', 'publish', 'close']);
      expect((await costs(chat(), 3, 2))[1]!.companion).toEqual(['start', ...Array(4).fill('publish'), 'close']);
    },
  );

  it.each(AGENTS)(
    "show a follower the tool calls as their tools start, and their results before the model's next request: %s",
    async (_name, chat, messages) => {
      const map = new Map<string, Uint8Array>();
      // What a follower reads at each publish of the turn: its tool calls, and how many have their output.
      const seen: [calls: number, outputs: number][] = [];
      let requests = 0;
      const published = async () => {
        const read = sqlAttempt({ map, key: 'k', id: `read${++requests}`, shared: true });
        const page = await read.end(() => messages(read.view, {}));
        const parts = page.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool');
        seen.push([parts.length, parts.filter((p) => p.output !== undefined).length]);
      };
      Object.assign(plan, { rounds: 1, calls: 3, asked: 0 });
      const sql = sqlAttempt({ map, key: 'k', id: 'inv', published });
      expect(await sql.end(() => handlerOf(chat())(sql.ctx, 'go'))).toBe('Done');
      // The start's (the companion's), the reply's, the results'.
      expect(seen).toEqual([
        [0, 0],
        [3, 0],
        [3, 3],
      ]);
    },
  );
});

describe("a turn's start", () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it.each(AGENTS)(
    "is published by the companion's `start`: the turn makes no publish of its own to start: %s",
    async (_name, chat) => {
      const [, turn] = await costs(chat(), 1, 0);
      expect(turn!.companion).toEqual(['start', 'close']);
    },
  );

  it('is not published in the background: the turn says it does not publish, and the turn makes none', async () => {
    claudePlanned();
    const chat = claude.chat({ tools: tools() });
    const object = sessionObject({ name: 'quiet', background: true, handlers: { chat }, views: {} });
    const [, plain] = await costs(chat, 1, 0, { object });
    expect(plain!.companion).toEqual(['start', 'close']);
    // Nor are its steps: rounds of tool calls make no publish, only the close does.
    const [, rounds] = await costs(chat, 3, 2, { object });
    expect(rounds!.companion).toEqual(['start', 'close']);
  });
});

/**
 * A turn of Claude (one round of one tool call, `t1`, then `Done`) whose
 * attempt is cancelled as the first commit that `at` picks (by its
 * statements and their parameters) waits for Restate: the commit is
 * stored, and the wait rejects with a CancelledError, as the SDK's does.
 * What the turn failed with, and what the database then holds.
 */
async function cancelledAt(at: (statements: [string, unknown[]][]) => boolean) {
  claudePlanned();
  Object.assign(plan, { rounds: 1, calls: 1, asked: 0 });
  const map = new Map<string, Uint8Array>();
  let pending: [string, unknown[]][] = [];
  let cancelled = false;
  const onSync = async () => {
    const committing = pending;
    pending = [];
    if (!cancelled && at(committing)) {
      cancelled = true;
      throw new restate.CancelledError();
    }
  };
  const sql = sqlAttempt({ map, key: 'k', id: 'inv1', onSync });
  // The statements of each commit, as the turn makes them.
  const { db } = sql;
  const execute = db.execute.bind(db);
  const transaction = db.transaction.bind(db);
  db.execute = async (statement, params) => {
    pending = [[statement, params ?? []]];
    return execute(statement, params);
  };
  db.transaction = (async (body: (tx: restate.Transaction) => Promise<unknown>) =>
    transaction(async (tx) => {
      const statements: [string, unknown[]][] = [];
      const run = tx.execute.bind(tx);
      tx.execute = async (statement, params) => {
        statements.push([statement, params ?? []]);
        return run(statement, params);
      };
      const result = await body(tx);
      pending = statements;
      return result;
    })) as typeof db.transaction;
  const failed = await sql
    .end(() => handlerOf(claude.chat({ tools: tools().slice(0, 1) }))(sql.ctx, 'go'))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  const read = sqlAttempt({ map, key: 'k', id: 'read' });
  const stored = await read.end(async () => ({
    turns: await read.db.values('SELECT status, answer FROM restate_agent_turns'),
    items: (await read.db.values('SELECT item FROM restate_agent_items ORDER BY n')).map(
      ([item]) => JSON.parse(String(item)) as MessageParam,
    ),
  }));
  return { failed, ...stored };
}

/** What each item says: a tool call, a result, or text. */
const shown = (items: MessageParam[]) =>
  items.map(({ content = [] }) =>
    typeof content === 'string'
      ? content
      : content
          .map((b) =>
            b.type === 'tool_use'
              ? `call ${b.id}`
              : b.type === 'tool_result'
                ? `result ${b.tool_use_id}: ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`
                : b.type === 'text'
                  ? b.text
                  : b.type,
          )
          .join(' + '),
  );

/** Whether a commit stores a step whose item has `text` (a tool call's id, say). */
const storing = (text: string) => (statements: [string, unknown[]][]) =>
  statements.some(
    ([sql, params]) => sql.startsWith('INSERT INTO restate_agent_items') && String(params[3]).includes(text),
  );

/** Whether a commit stores a turn's answer. */
const answering = (statements: [string, unknown[]][]) =>
  statements.some(([sql]) => sql.startsWith('UPDATE restate_agent_turns'));

describe('a commit cancelled as it waits for Restate', () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it("is the turn's: a cancelled reply with tool calls leaves its calls open, which the close gives a result", async () => {
    const { failed, turns, items } = await cancelledAt(storing('tool_use'));
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(turns).toEqual([['cancelled', CANCELLED]]);
    const [, id] = /call (call_\d+)/.exec(shown(items).join(' '))!;
    expect(shown(items)).toEqual([`On it. + call ${id}`, `result ${id}: ${CANCELLED}`, CANCELLED]);
  });

  it("is the turn's: a cancelled result is the call's, which the close gives no other", async () => {
    const { failed, turns, items } = await cancelledAt(storing('tool_result'));
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(turns).toEqual([['cancelled', CANCELLED]]);
    const [, id] = /call (call_\d+)/.exec(shown(items).join(' '))!;
    expect(shown(items)).toEqual([`On it. + call ${id}`, `result ${id}: result of t1`, CANCELLED]);
  });

  it("is the turn's: a cancelled answer is the turn's, which nothing closes after", async () => {
    const { failed, turns, items } = await cancelledAt(answering);
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(turns).toEqual([['answered', 'Done']]);
    expect(shown(items).at(-1)).toBe('Done');
  });
});

/** The commits of a key's second turn of `r` model requests with one tool call each round, on `object`'s agent. */
const second = async (commits: 'each' | 'effects', r: number, object?: { readonly name: string }) =>
  (await costs(pi.chat({ tools: tools(), commits }), r, 1, { object }))[1]!.commits;

describe("a pi turn's commits", () => {
  // Not followed: no publishes to wait for, and no one to steer it.
  const unwatched = pi.agent({ name: 'unwatched', background: true });

  it('are 30 for 4 requests and 3 tool calls, a commit each: pi stores each step in several', async () => {
    expect(await second('each', 4, unwatched)).toBe(30);
  });

  it('are 10 with `effects`: the turn opens, each effect starts (4 requests, 3 tools), the answer, the turn closes', async () => {
    expect(await second('effects', 4, unwatched)).toBe(10);
  });

  it('are 13 with `effects` in a turn that is followed: a publish after each round reads what was steered to it', async () => {
    expect(await second('each', 4)).toBe(30);
    expect(await second('effects', 4)).toBe(13);
  });

  it('are fewer with `effects` whatever the length of the turn', async () => {
    for (const r of [1, 2, 3])
      expect(await second('effects', r, unwatched)).toBeLessThan(await second('each', r, unwatched));
  });
});

describe("a graph of your own's commits", () => {
  const WRITE = /(?:INSERT OR REPLACE INTO|INSERT OR IGNORE INTO|INSERT INTO|UPDATE|DELETE FROM)\s+"?restate_(\w+)/i;

  /** The second turn of a key, `r` requests with `k` tool calls a round: each commit's tables, in order. */
  async function sequence(r: number, k: number) {
    const map = new Map<string, Uint8Array>();
    const handler = handlerOf(langgraph.chat({ graph: ownGraph() }));
    let seen: string[] = [];
    const commits: string[] = [];
    for (const [i, text] of ['first', 'second'].entries()) {
      Object.assign(plan, { rounds: r - 1, calls: k, asked: 0 });
      commits.length = 0;
      const sql = sqlAttempt({
        map,
        key: 'k',
        id: `inv${i}`,
        onSync: async () => void commits.push(seen.shift() ?? '?'),
      });
      const transaction = sql.db.transaction.bind(sql.db);
      sql.db.transaction = ((body: (tx: restate.Transaction) => Promise<unknown>) =>
        transaction(async (tx) => {
          const tables = new Set<string>();
          const execute = tx.execute.bind(tx);
          tx.execute = (statement, params) => {
            const table = WRITE.exec(statement)?.[1];
            if (table) tables.add(table.replace(/^langgraph_/, ''));
            return execute(statement, params);
          };
          const result = await body(tx);
          seen.push([...tables].join('+'));
          return result;
        })) as typeof sql.db.transaction;
      seen = [];
      expect(await sql.end(() => handler(sql.ctx, text))).toBe('Done');
    }
    return commits;
  }

  it("are each step's writes with its checkpoint, but for the first's, and the conversation's copies", async () => {
    const put = 'channel_values+checkpoints';
    const step = `writes+${put}`;
    const commits = await sequence(4, 1);
    // The checkpointer's: the prompt's row, then the input checkpoint and the write of LangGraph's `__start__` task
    // (which its checkpoint does not follow at once), then each of the 7 steps' (3 rounds of a model's reply and a
    // tool's result, then the final reply) a commit, and the thread pruned to its latest checkpoint.
    expect(commits.filter((commit) => commit !== 'agent_items')).toEqual([
      'agent_turns',
      put,
      'writes',
      put,
      ...Array.from({ length: 7 }, () => step),
      'checkpoints+writes+channel_values',
      'agent_items+agent_turns',
    ]);
    // The conversation's copies of the 3 replies with tool calls and the 3 results: each after its checkpoint
    // (they run beside the next step, whose commit may come first), and the final reply with the answer.
    expect(commits.filter((commit) => commit === 'agent_items')).toHaveLength(6);
    expect(commits).toHaveLength(19);
    expect(commits.at(-1)).toBe('agent_items+agent_turns');
  });

  it('are as many for a round of tool calls as for one', async () => {
    expect(await sequence(2, 3)).toHaveLength((await sequence(2, 1)).length);
  });
});
