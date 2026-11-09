// `prune` and `metadata` on checkpointer.ts: what a thread keeps once pruned,
// and what each checkpoint carries. `pnpm --filter @restatedev/agents test langgraph`.
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  END,
  interrupt,
  MessagesAnnotation,
  MessagesDeltaValue,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph';
import { asDatabase, open } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { memoryStore } from '@restatedev/sessions/test/support';
import { SqlCheckpointSaver } from '@restatedev/agents/langgraph';

let n = 0;
const database = async () => asDatabase(await open(`langgraph-prune-${process.pid}-${n++}`, memoryStore()));
const count = async (db: ReturnType<typeof asDatabase>, table: string, thread = 't') =>
  Number((await db.values(`SELECT COUNT(*) FROM ${table} WHERE thread_id = ?`, [thread]))[0]![0]);
const thread = (id = 't') => ({ configurable: { thread_id: id }, durability: 'sync' as const });

/** A graph that echoes each message, with its checkpoints in `saver`. */
const echo = (saver: SqlCheckpointSaver) =>
  new StateGraph(MessagesAnnotation)
    .addNode('reply', ({ messages }) => ({ messages: [new AIMessage(`echo ${messages.at(-1)?.text}`)] }))
    .addEdge(START, 'reply')
    .addEdge('reply', END)
    .compile({ checkpointer: saver });

describe('prune', () => {
  it('keeps the latest checkpoint of a thread, which the next run goes on from, and leaves other threads', async () => {
    const db = await database();
    const saver = new SqlCheckpointSaver(db);
    const graph = echo(saver);
    for (const text of ['a', 'b']) {
      await graph.invoke({ messages: [new HumanMessage(text)] }, thread());
      await graph.invoke({ messages: [new HumanMessage(text)] }, thread('other'));
    }
    expect(await count(db, 'restate_langgraph_checkpoints')).toBeGreaterThan(1);
    await saver.prune(['t']);
    expect(await count(db, 'restate_langgraph_checkpoints')).toBe(1);
    expect(await count(db, 'restate_langgraph_checkpoints', 'other')).toBeGreaterThan(1);
    await graph.invoke({ messages: [new HumanMessage('c')] }, thread());
    const { values } = await graph.getState(thread());
    expect((values as { messages: BaseMessage[] }).messages.map((m) => m.text)).toEqual([
      'a',
      'echo a',
      'b',
      'echo b',
      'c',
      'echo c',
    ]);
    await saver.prune(['t'], { strategy: 'delete' });
    for (const table of [
      'restate_langgraph_checkpoints',
      'restate_langgraph_channel_values',
      'restate_langgraph_writes',
    ]) {
      expect(await count(db, table)).toBe(0);
    }
  });

  it('keeps what a delta channel is rebuilt from', async () => {
    const db = await database();
    const saver = new SqlCheckpointSaver(db);
    const graph = new StateGraph(new StateSchema({ messages: MessagesDeltaValue }))
      .addNode('reply', (state: { messages: BaseMessage[] }) => ({
        messages: [new AIMessage(`saw ${state.messages.length}`)],
      }))
      .addEdge(START, 'reply')
      .addEdge('reply', END)
      .compile({ checkpointer: saver });
    for (const text of ['a', 'b', 'c']) {
      await graph.invoke({ messages: [new HumanMessage(text)] }, thread());
      await saver.prune(['t']);
    }
    const { values } = await graph.getState(thread());
    expect((values as { messages: BaseMessage[] }).messages.map((m) => m.text)).toEqual([
      'a',
      'saw 1',
      'b',
      'saw 3',
      'c',
      'saw 5',
    ]);
  });

  it('keeps the pending writes of a paused run, which resumes', async () => {
    const db = await database();
    const saver = new SqlCheckpointSaver(db);
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('first', () => ({ messages: [new AIMessage('first')] }))
      .addNode('ask', () => ({ messages: [new AIMessage(`asked: ${interrupt<string, string>('ok?')}`)] }))
      .addEdge(START, 'first')
      .addEdge('first', 'ask')
      .addEdge('ask', END)
      .compile({ checkpointer: saver });
    await graph.invoke({ messages: [new HumanMessage('go')] }, thread());
    await saver.prune(['t']);
    const { Command } = await import('@langchain/langgraph');
    const { messages } = (await graph.invoke(new Command({ resume: 'yes' }), thread())) as { messages: BaseMessage[] };
    expect(messages.map((m) => m.text)).toEqual(['go', 'first', 'asked: yes']);
  });
});

describe('metadata', () => {
  it("is added to each checkpoint's", async () => {
    const db = await database();
    const graph = echo(new SqlCheckpointSaver(db, { metadata: { run: 'r1' } }));
    await graph.invoke({ messages: [new HumanMessage('a')] }, thread());
    const { metadata } = await graph.getState(thread());
    expect(metadata).toMatchObject({ run: 'r1', source: 'loop' });
  });
});
