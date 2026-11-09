// `history: 'latest'` on checkpointer.ts: what it keeps, and graphs too large
// for an `OR` of their channels. `pnpm --filter @restatedev/agents test langgraph`.
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, END, MessagesDeltaValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
import type { DatabaseWriter, SqlValue } from '@restatedev/sessions';
import { asDatabase, open } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { memoryStore } from '@restatedev/sessions/test/support';
import { SqlCheckpointSaver } from '@restatedev/agents/langgraph';

let n = 0;
const database = async () => {
  const connection = await open(`langgraph-latest-${process.pid}-${n++}`, memoryStore());
  return { connection, db: asDatabase(connection) };
};
const count = async (db: ReturnType<typeof asDatabase>, table: string) =>
  Number((await db.values(`SELECT COUNT(*) FROM ${table}`))[0]![0]);

describe("history: 'latest'", () => {
  it('keeps what a delta channel is rebuilt from, across runs', async () => {
    const { connection, db } = await database();
    const graph = new StateGraph(new StateSchema({ messages: MessagesDeltaValue }))
      .addNode('reply', (state: { messages: BaseMessage[] }) => ({
        messages: [new AIMessage(`echo ${state.messages.at(-1)?.text} (saw ${state.messages.length})`)],
      }))
      .addEdge(START, 'reply')
      .addEdge('reply', END)
      .compile({ checkpointer: new SqlCheckpointSaver(db, { history: 'latest' }) });
    const thread = { configurable: { thread_id: 't' }, durability: 'sync' as const };
    for (const text of ['a', 'b', 'c']) await graph.invoke({ messages: [new HumanMessage(text)] }, thread);
    const { values } = await graph.getState(thread);
    expect((values as { messages: BaseMessage[] }).messages.map((m) => m.content)).toEqual([
      'a',
      'echo a (saw 1)',
      'b',
      'echo b (saw 3)',
      'c',
      'echo c (saw 5)',
    ]);
    await connection.close();
  });

  it('reads the checkpoints a delta channel needs from the step before, not from the database at each step', async () => {
    const { connection, db } = await database();
    // Each read of a checkpoint back (its parent, its metadata) that a step's `put` makes.
    let reads = 0;
    const counting = (tx: DatabaseWriter) =>
      Object.create(tx, {
        values: {
          value: (sql: string, params?: SqlValue[]) => {
            if (sql.startsWith('SELECT parent_checkpoint_id, type, checkpoint, metadata')) reads++;
            return tx.values(sql, params);
          },
        },
      }) as DatabaseWriter;
    const watched = Object.create(db, {
      transaction: {
        value: <T>(body: (tx: DatabaseWriter) => Promise<T>) => db.transaction((tx) => body(counting(tx))),
      },
    }) as typeof db;
    const graph = new StateGraph(new StateSchema({ messages: MessagesDeltaValue }))
      .addNode('reply', (state: { messages: BaseMessage[] }) => ({
        messages: [new AIMessage(`echo ${state.messages.at(-1)?.text}`)],
      }))
      .addEdge(START, 'reply')
      .addEdge('reply', END)
      .compile({ checkpointer: new SqlCheckpointSaver(watched, { history: 'latest' }) });
    const thread = { configurable: { thread_id: 't' }, durability: 'sync' as const };
    for (const text of ['a', 'b', 'c', 'd']) await graph.invoke({ messages: [new HumanMessage(text)] }, thread);
    const { values } = await graph.getState(thread);
    expect((values as { messages: BaseMessage[] }).messages.map((m) => m.content)).toEqual(
      ['a', 'b', 'c', 'd'].flatMap((text) => [text, `echo ${text}`]),
    );
    expect(reads).toBe(0);
    await connection.close();
  });

  it('keeps only the latest checkpoint of a graph without delta channels', async () => {
    const { connection, db } = await database();
    const graph = new StateGraph(Annotation.Root({ text: Annotation<string> }))
      .addNode('shout', (state) => ({ text: `${state.text}!` }))
      .addEdge(START, 'shout')
      .addEdge('shout', END)
      .compile({ checkpointer: new SqlCheckpointSaver(db, { history: 'latest' }) });
    const thread = { configurable: { thread_id: 't' } };
    await graph.invoke({ text: 'a' }, thread);
    const values = await count(db, 'restate_langgraph_channel_values');
    await graph.invoke({ text: 'b' }, thread);
    expect((await graph.getState(thread)).values).toEqual({ text: 'b!' });
    expect(await count(db, 'restate_langgraph_checkpoints')).toBe(1);
    // The latest version of each channel only: as many as after the first run.
    expect(await count(db, 'restate_langgraph_channel_values')).toBe(values);
    await connection.close();
  });
});

/** A graph of 120 channels, each bumped by its one step. */
const wide = (db: ReturnType<typeof asDatabase>, history: 'all' | 'latest') => {
  const channels = Array.from({ length: 120 }, (_, i) => `c${i}`);
  const State = Annotation.Root(Object.fromEntries(channels.map((c) => [c, Annotation<number>])));
  const graph = new StateGraph(State)
    .addNode('bump', (state: Record<string, number>) =>
      Object.fromEntries(channels.map((c) => [c, (state[c] ?? 0) + 1])),
    )
    .addEdge(START, 'bump')
    .addEdge('bump', END)
    .compile({ checkpointer: new SqlCheckpointSaver(db, { history }) });
  return { graph, channels, start: Object.fromEntries(channels.map((c) => [c, 0])) };
};

describe('a graph of more channels than an expression can be deep', () => {
  it('is read', async () => {
    const { connection, db } = await database();
    const { graph, channels, start } = wide(db, 'all');
    const thread = { configurable: { thread_id: 't' } };
    await graph.invoke(start, thread);
    const { values } = await graph.getState(thread);
    expect(Object.values(values as Record<string, number>)).toEqual(channels.map(() => 1));
    await connection.close();
  });

  it('is read and pruned', async () => {
    const { connection, db } = await database();
    const { graph, channels, start } = wide(db, 'latest');
    const thread = { configurable: { thread_id: 't' } };
    await graph.invoke(start, thread);
    const stored = await count(db, 'restate_langgraph_channel_values');
    await graph.invoke(start, thread);
    const { values } = await graph.getState(thread);
    expect(Object.values(values as Record<string, number>)).toEqual(channels.map(() => 1));
    expect(await count(db, 'restate_langgraph_checkpoints')).toBe(1);
    expect(stored).toBeGreaterThan(channels.length);
    expect(await count(db, 'restate_langgraph_channel_values')).toBe(stored);
    await connection.close();
  });
});
