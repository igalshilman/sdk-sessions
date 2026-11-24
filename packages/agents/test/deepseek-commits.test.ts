// What a DeepSeek turn costs: its commits to the key's database, by what each stores, on the reference turn (a
// key's second turn of 4 model requests and 3 tool calls); and what must be stored before an effect starts. The
// harness's session log is written where an effect is about to start (a model request, a tool body), where
// someone must see it, and at the end: `pnpm --filter @restatedev/agents test deepseek-commits`.
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestMessage } from '@deepseek-ai/dsh-llm';
import * as deepseek from '@restatedev/agents/deepseek';
import { conversation, handlerOf, sqlAttempt } from './support.ts';
import { bank } from './bank.ts';
import { reply as tellerReply, teller } from './fakes/deepseek.ts';

vi.mock('@deepseek-ai/dsh-llm-deepseek-api-key', () => import('./fakes/deepseek.ts'));

import { plan, planned, queued, tools, turn, withHandles } from './deepseek-turn.ts';

describe("a DeepSeek turn's commits", () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it('are 10 on the reference turn: the ask, one before each effect, the final flush, the answer', async () => {
    const { log, effects: seen, result } = await turn(3);
    expect(result).toBe('Done');
    expect(log).toHaveLength(10);
    // A round: the reply with its tool call is stored before the tool runs, its result and the next step before the next request.
    const round = ['C(events assistant/message tool/call)', 'T', 'C(events tool/result step/end step/start)', 'M'];
    expect(seen).toEqual([
      'C(ask)',
      'C(events session/end-seed agent/inbox/spliced turn/start agent/inbox/spliced step/start user/message request/header)',
      'M',
      ...round.slice(0, 3),
      'M',
      ...round.slice(0, 3),
      'M',
      ...round.slice(0, 3),
      'M',
      'C(events assistant/message step/end turn/end)',
      'C(answer)',
    ]);
  });

  it('are one before each effect, and nothing is stored between two commits with no effect between them', async () => {
    for (const rounds of [0, 1, 2, 5]) {
      const { effects: seen } = await turn(rounds);
      for (const [i, e] of seen.entries()) {
        if (e !== 'M' && e !== 'T') continue;
        expect(seen[i - 1]).toMatch(/^C\(events/);
        expect(seen[i - 2]).not.toMatch(/^C\(events/);
      }
    }
  });

  it('are the same on a turn of one request: the ask, one before the request, the final flush, the answer', async () => {
    expect((await turn(0)).log).toHaveLength(4);
  });
});

describe("a DeepSeek turn's effects", () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it('do not start when the write before a model request fails', async () => {
    const { effects: seen, result } = await turn(1, { fail: (label) => label.includes('request/header') });
    expect(String(result)).toContain('failed');
    expect(seen.filter((e) => e === 'M' || e === 'T')).toEqual([]);
  });

  it('do not start when the write before a tool body fails: the model asked once, the tool never ran', async () => {
    const { effects: seen, result } = await turn(1, { fail: (label) => label.includes('tool/call') });
    expect(String(result)).toContain('failed');
    expect(seen.filter((e) => e === 'M' || e === 'T')).toEqual(['M']);
  });

  it('do not start while anything the harness queued is unstored: every model request and tool body finds the log written', async () => {
    const unstored = await withHandles(async (handles) => {
      planned();
      Object.assign(plan, { rounds: 3, asked: 0 });
      const found: number[] = [];
      const sql = sqlAttempt({ map: new Map(), key: 'k', id: 'inv' });
      const check = async () => found.push(await queued(sql.db, handles.at(-1)!));
      const reply = teller.reply;
      teller.reply = async (messages: RequestMessage[]) => (await check(), reply(messages));
      const chat = deepseek.chat({ tools: tools(check) });
      expect(await sql.end(() => handlerOf(chat)(sql.ctx, 'go'))).toBe('Done');
      return found;
    });
    // 4 requests, 3 tool bodies.
    expect(unstored).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("a followed DeepSeek turn's publishes", () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it('come after the data they tell of is stored, in order, once for each step stored', async () => {
    const map = new Map<string, Uint8Array>();
    // What a follower reads at each publish: its tool calls, and how many have their output.
    const seen: [calls: number, outputs: number][] = [];
    let reads = 0;
    const { messages } = deepseek;
    const published = async () => {
      const read = sqlAttempt({ map, key: 'k', id: `read${++reads}`, shared: true });
      const page = await read.end(() => messages()(read.view, {}));
      const parts = page.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool');
      seen.push([parts.length, parts.filter((p) => p.output !== undefined).length]);
    };
    planned();
    Object.assign(plan, { rounds: 2, asked: 0 });
    const sql = sqlAttempt({ map, key: 'k', id: 'inv', published });
    expect(await sql.end(() => handlerOf(deepseek.chat({ tools: tools() }))(sql.ctx, 'go'))).toBe('Done');
    // The start's (the companion's), then the call of each round as it is stored, and its result.
    expect(seen).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
    ]);
  });
});

/** The text of a model request's messages. */
const saidIn = (messages: RequestMessage[]) =>
  messages.flatMap((m) => m.content.flatMap((c) => (c.type === 'text' ? [c.text] : []))).join('\n');

describe('a DeepSeek turn that condenses its input', () => {
  afterAll(() => {
    Reflect.deleteProperty(teller, 'resolveModel');
    teller.reply = tellerReply;
  });

  it("stores everything queued before the summary's request too, and ends as before", async () => {
    // A small model: a window of 4000 tokens, answers of 100 at most.
    teller.resolveModel = async (provider, model) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 4000 },
      defaultMaxTokens: 100,
    });
    const { requests, unstored, users } = await withHandles(async (handles) => {
      const map = new Map<string, Uint8Array>();
      const seen: RequestMessage[][] = [];
      const found: number[] = [];
      let sql!: ReturnType<typeof sqlAttempt>;
      teller.reply = async (messages) => {
        seen.push(messages);
        found.push(await queued(sql.db, handles.at(-1)!));
        return tellerReply(messages);
      };
      const chat = deepseek.chat({ compaction: { thresholdRatio: 0.5, retainRatio: 0.1, headroomTokens: 100 } });
      for (let n = 0; n < 6; n++) {
        sql = sqlAttempt({ map, key: 'k', id: `inv${n}` });
        await sql.end(() => handlerOf(chat)(sql.ctx, `${n}: ${'lorem ipsum '.repeat(250)}`));
      }
      const read = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
      const { messages } = await read.end(() => deepseek.messages()(read.view, {}));
      return {
        requests: seen,
        unstored: found,
        users: messages.filter((m) => m.role === 'user').map((m) => m.parts[0]),
      };
    });
    expect(saidIn(requests.at(-1)!)).toContain('<compacted-summary>');
    // A request for each turn, and the summary's among them.
    expect(requests.length).toBeGreaterThan(6);
    expect(unstored.every((n) => n === 0)).toBe(true);
    expect(users).toHaveLength(6);
  });
});

describe('a DeepSeek turn that crashes', () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it("after a tool ran and before its result is stored, resumes with the tool's outcome unknown, and completes", async () => {
    const reply = teller.reply;
    const said: string[] = [];
    teller.reply = (messages) => {
      said.push(saidIn(messages));
      return reply(messages);
    };
    const prompt = deepseek.chat({ tools: bank('DeepSeekAgent') });
    const before = conversation(prompt, 'crash-before-write');
    await before.attempt('inv0', 'Please move 1 from 3 to 4');
    let unknown = 0;
    let crashes = 0;
    for (let at = 1; ; at++) {
      const c = conversation(prompt, 'crash-before-write', before);
      said.length = 0;
      if ((await c.attempt('inv1', 'Please move 5 from 1 to 2', at)) !== 'crashed') break;
      crashes++;
      const ran = c.ledger.calls.length;
      expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe('Done: moved 5 from account 1 to account 2');
      // The move is made once, however far the first attempt got.
      expect(c.ledger.transfers.size).toBe(2);
      if (ran > 0 && said.some((s) => s.includes('outcome is unknown'))) unknown++;
      // Nothing is duplicated in the transcript: the two prompts, the transfer's call and result, the answers.
      const { messages } = await c.read(deepseek.messages(), {});
      expect(messages.filter((m) => m.role === 'user')).toHaveLength(2);
      const calls = messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool');
      expect(calls.map((p) => p.output)).not.toContain(undefined);
    }
    expect(crashes).toBeGreaterThan(0);
    // At least one crash left the tool run with its result unwritten, and the model was told it was unknown.
    expect(unknown).toBeGreaterThan(0);
  }, 120_000);
});
