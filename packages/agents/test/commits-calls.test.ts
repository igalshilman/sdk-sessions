// What a turn with Restate `call` tools costs for the frameworks that need a
// model of their own in the test: DeepSeek and OpenCode (commits.test.ts has
// the others). The tools' call records ride the commits that happen anyway
// (calls.ts), but for the one written before each call is made.
//
// OpenCode keeps its transcript in a database of its own, which a commit of
// `ctx.db` does not reach: a call that answered is written before its result is handed to OpenCode, so that
// is a commit of its own again. Only what `ctx.db` commits is counted for it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import * as restate from '@restatedev/sessions';
import { call, tool } from '@restatedev/agents';
import * as deepseek from '@restatedev/agents/deepseek';
import type * as Db from '../src/opencode/db.ts';
import type * as OpenCode from '../src/opencode/index.ts';
import type * as Fake from './fakes/opencode.ts';
import { handlerOf, type Made, type PromptHandler, sqlAttempt } from './support.ts';
import { teller } from './fakes/deepseek.ts';

vi.mock('@deepseek-ai/dsh-llm-deepseek-api-key', () => import('./fakes/deepseek.ts'));
vi.mock('@restatedev/agents/opencode/db', async (original) => {
  const db = await original<typeof Db>();
  const { scriptedPlugin } = await import('./fakes/opencode.ts');
  const openOpenCode: typeof db.openOpenCode = (database, fence, options) =>
    db.openOpenCode(database, fence, { ...options, plugins: [scriptedPlugin, ...(options.plugins ?? [])] });
  return { ...db, openOpenCode };
});

const callee = restate.service({
  name: 'callee',
  handlers: {
    t1: async (_c, _x: unknown) => 'r',
    t2: async (_c, _x: unknown) => 'r',
    t3: async (_c, _x: unknown) => 'r',
  },
});
const answered = async (c: Made) => `result of ${c.method}`;
const restateTools = () =>
  (['t1', 't2', 't3'] as const).map((name) => call(callee, name, { name, description: `tool ${name}` }));
const plainTools = () =>
  ['t1', 't2', 't3'].map((name) =>
    tool({ name, description: `tool ${name}`, input: z.object({}), run: () => `result of ${name}` }),
  );

/**
 * The commits of `ctx.db` of a key's second turn of 4 model requests, a tool call after each of the first
 * three: a transaction that wrote, or a write outside one.
 */
async function commits(
  chat: PromptHandler,
  { route, script }: { route?: (call: Made) => Promise<unknown>; script: () => void },
) {
  const map = new Map<string, Uint8Array>();
  const handler = handlerOf(chat);
  let count = 0;
  for (const [i, text] of ['first', 'second'].entries()) {
    count = 0;
    script();
    const sql = sqlAttempt({ map, key: 'k', id: `inv${i}`, route });
    const { db } = sql;
    const execute = db.execute.bind(db);
    const transaction = db.transaction.bind(db);
    db.execute = async (statement, params) => (count++, execute(statement, params));
    db.transaction = (async (body: (tx: restate.Transaction) => Promise<unknown>) => {
      let wrote = false;
      // Counted once it has ended: a write that rides it is made after its body.
      const result = await transaction(async (tx) => {
        const run = tx.execute.bind(tx);
        tx.execute = async (statement, params) => ((wrote = true), run(statement, params));
        return body(tx);
      });
      if (wrote) count++;
      return result;
    }) as typeof db.transaction;
    expect(await sql.end(() => handler(sql.ctx, text))).toBe('Done');
  }
  return count;
}

describe('a DeepSeek turn with Restate calls', () => {
  it('has one commit more for each, before the call', async () => {
    let asked = 0;
    const script = () => {
      asked = 0;
      teller.reply = () =>
        asked++ < 3 ? { call: { id: ToolCallId(`call_${asked}`), name: 't1', args: {} } } : { text: 'Done' };
    };
    const plain = await commits(deepseek.chat({ tools: plainTools() }), { script });
    expect(await commits(deepseek.chat({ tools: restateTools() }), { route: answered, script })).toBe(plain + 3);
  });
});

describe('an OpenCode turn with Restate calls', () => {
  let opencode: typeof OpenCode;
  let fake: typeof Fake;
  beforeAll(async () => {
    vi.stubEnv('MODEL', 'scripted/scripted');
    opencode = await import('@restatedev/agents/opencode');
    fake = await import('./fakes/opencode.ts');
  });
  afterAll(() => void vi.unstubAllEnvs());
  let turns = 0;
  const script = () => {
    let asked = 0;
    turns++;
    fake.script.reply = () =>
      asked++ < 3 ? { call: { id: `call_${turns}_${asked}`, name: 't1', input: {} } } : { text: 'Done' };
  };

  // The call that answered is written before OpenCode has the result: a commit of its own, as before (two for
  // each call, with the one before the call). Its record's forgetting rides the commit that copies the result.
  it('has two commits more for each, as its result is stored apart from `ctx.db`', async () => {
    const plain = await commits(opencode.chat({ tools: plainTools() }), { script });
    expect(await commits(opencode.chat({ tools: restateTools() }), { route: answered, script })).toBe(plain + 6);
  }, 120_000);
});
