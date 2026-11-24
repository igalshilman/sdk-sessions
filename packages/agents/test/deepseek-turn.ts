// A DeepSeek turn on the reference plan, and what its commits and effects were, in order (deepseek-commits.test.ts).
import { expect } from 'vitest';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import type * as restate from '@restatedev/sessions';
import { SqlSessionPersistence } from '../src/deepseek/persistence.ts';
import { tool } from '@restatedev/agents';
import * as deepseek from '@restatedev/agents/deepseek';
import { handlerOf, sqlAttempt } from './support.ts';
import { teller } from './fakes/deepseek.ts';

/** What the effects of the turn did, in order: a model request `M`, a tool body `T`, and each commit `C(what)`. */
export let effects: string[] = [];
export const plan = { rounds: 0, asked: 0, ids: 0 };

/** The tools `t1` to `t3`; `before` runs as each body starts. */
export const tools = (before?: () => Promise<unknown>) =>
  ['t1', 't2', 't3'].map((name) =>
    tool({
      name,
      description: `tool ${name}`,
      input: z.object({}),
      run: async () => {
        await before?.();
        effects.push('T');
        return `result of ${name}`;
      },
    }),
  );

/** The teller's replies: one tool call a round, for `plan.rounds` rounds, then the answer. */
export const planned = () => {
  teller.reply = () => {
    effects.push('M');
    return plan.asked++ < plan.rounds
      ? { call: { id: ToolCallId(`call_${++plan.ids}`), name: `t${plan.asked}`, args: {} } }
      : { text: 'Done' };
  };
};

type Statements = [string, unknown[]][];

/** What a commit stores, in a word: the turn's `ask` or `answer`, or the harness's events it logs. */
const labelled = (statements: Statements) => {
  const events = statements.flatMap(([sql, params]) =>
    sql.startsWith('INSERT INTO restate_deepseek_events')
      ? [(JSON.parse(String(params[2])) as { type: string }).type]
      : [],
  );
  if (events.length > 0) return `events ${events.join(' ')}`;
  if (statements.some(([sql]) => sql.startsWith('INSERT INTO restate_agent_turns'))) return 'ask';
  if (statements.some(([sql]) => sql.startsWith('UPDATE restate_agent_turns'))) return 'answer';
  return 'other';
};

/** `db`'s statements, by commit: what `onSync` finds in `pending()` as a commit is made. */
function recording(db: restate.Database) {
  let pending: Statements = [];
  const execute = db.execute.bind(db);
  const transaction = db.transaction.bind(db);
  db.execute = async (statement, params) => {
    pending = [[statement, params ?? []]];
    return execute(statement, params);
  };
  db.transaction = (async (body: (tx: restate.Transaction) => Promise<unknown>) =>
    transaction(async (tx) => {
      const statements: Statements = [];
      const run = tx.execute.bind(tx);
      tx.execute = async (statement, params) => {
        statements.push([statement, params ?? []]);
        return run(statement, params);
      };
      const result = await body(tx);
      pending = statements;
      return result;
    })) as typeof db.transaction;
  return () => {
    const taken = pending;
    pending = [];
    return taken;
  };
}

/**
 * A key's second turn of `rounds + 1` model requests (a tool call a round), and what it did, in order. `fail` picks
 * a commit (by its label) that fails as it is made; `published` runs at each publish.
 */
export async function turn(
  rounds: number,
  { fail, published }: { fail?: (label: string) => boolean; published?: () => Promise<void> } = {},
) {
  planned();
  const map = new Map<string, Uint8Array>();
  const handler = handlerOf(deepseek.chat({ tools: tools() }));
  let log: string[] = [];
  let result: unknown;
  for (const [i, text] of ['first', 'second'].entries()) {
    Object.assign(plan, { rounds, asked: 0 });
    effects = [];
    log = [];
    const commits: { taken: () => Statements } = { taken: () => [] };
    const onSync = async () => {
      const label = labelled(commits.taken());
      effects.push(`C(${label})`);
      if (i === 1 && fail?.(label)) throw new Error(`the commit of ${label} failed`);
      log.push(label);
    };
    const sql = sqlAttempt({ map, key: 'k', id: `inv${i}`, onSync, published });
    commits.taken = recording(sql.db);
    result = await sql.end(() => handler(sql.ctx, text)).catch((error: unknown) => error);
    if (i === 0) expect(result).toBe('Done');
  }
  return { log, effects, result, map };
}

/** The session handles the persistence opens, while `body` runs: what a read of one finds beyond the rows is what is queued. */
export async function withHandles<T>(body: (handles: SessionHandle[]) => Promise<T>): Promise<T> {
  const handles: SessionHandle[] = [];
  const original = Reflect.get(SqlSessionPersistence.prototype, 'openHandle');
  SqlSessionPersistence.prototype.openHandle = function (...args) {
    const handle = original.apply(this, args);
    handles.push(handle);
    return handle;
  };
  try {
    return await body(handles);
  } finally {
    SqlSessionPersistence.prototype.openHandle = original;
  }
}

/** How many events of the session `handle` has are queued, not stored: what a read finds beyond the database's rows. */
export async function queued(db: restate.Database, handle: SessionHandle): Promise<number> {
  const [row] = await db.values('SELECT count(*) FROM restate_deepseek_events');
  return (await handle.read()).events.length - Number(row?.[0]);
}
