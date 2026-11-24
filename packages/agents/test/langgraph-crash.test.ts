// A graph of your own through crashes (src/langgraph/graph.ts): the bank's transfer moves money once, and the
// message is answered once, wherever the attempt crashes.
import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import * as langgraph from '@restatedev/agents/langgraph';
import { bank } from './bank.ts';
import { Teller } from './fakes/langgraph.ts';
import { crashedAnywhere, sqlAttempt } from './support.ts';

/** A graph of a model (the teller) and a node of the bank's tools, as LangChain's `createAgent` has. */
function banking() {
  const teller = new Teller({});
  return new StateGraph(MessagesAnnotation)
    .addNode('model', async ({ messages }) => ({ messages: [teller.reply(messages)] }))
    .addNode('tools', new ToolNode(langgraph.tools(bank('GraphAgent'))))
    .addEdge(START, 'model')
    .addConditionalEdges('model', toolsCondition, { tools: 'tools', [END]: END })
    .addEdge('tools', 'model');
}

describe('a graph of your own, through crashes', () => {
  it('answers a message once after a crash at any of its state requests', async () => {
    const chat = langgraph.chat({ graph: banking() });
    // Every request by default, as the failing crash points are spread: CRASH_STRIDE for a faster run.
    const stride = Number(process.env.CRASH_STRIDE ?? 1);
    expect(await crashedAnywhere(chat, langgraph.messages(), { stride })).toEqual([]);
  }, 600_000);

  it('goes on from the writes of a step whose checkpoint was not stored, without running its tasks again', async () => {
    const ran: string[] = [];
    let crash = true;
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('first', () => {
        ran.push('first');
        return { messages: [new AIMessage('first done')] };
      })
      .addNode('second', () => {
        ran.push('second');
        if (crash) {
          crash = false;
          throw new Error('the process died');
        }
        return { messages: [new AIMessage('second done')] };
      })
      .addNode('third', () => {
        ran.push('third');
        return { messages: [new AIMessage('third done')] };
      })
      .addEdge(START, 'first')
      .addEdge('first', 'second')
      .addEdge('second', 'third')
      .addEdge('third', END);
    const chat = langgraph.chat({ graph });
    const map = new Map<string, Uint8Array>();
    const ask = (id: string) => {
      const sql = sqlAttempt({ map, key: 'k', id });
      return sql.end(() => chat.handler(sql.ctx, 'go'));
    };
    await expect(ask('inv_a')).rejects.toThrow('the process died');
    // The state of a crash between the second step's writes and its checkpoint: the task's writes are stored
    // (here in place of the error it stored), and no checkpoint follows them.
    const sql = sqlAttempt({ map, key: 'k', id: 'seed' });
    await sql.end(async () => {
      const saver = new langgraph.SqlCheckpointSaver(sql.ctx.db);
      const { tasks, config } = await graph
        .compile({ checkpointer: saver })
        .getState({ configurable: { thread_id: 'chat' } });
      expect(tasks.map((task) => task.name)).toEqual(['second']);
      await sql.ctx.db.execute("DELETE FROM restate_langgraph_writes WHERE channel = '__error__'");
      // What a node's task writes: its update, and the trigger of the node that follows.
      const writes: [string, unknown][] = [
        ['messages', [new AIMessage({ content: 'second done', id: 'second_done' })]],
        ['branch:to:third', null],
      ];
      await saver.putWrites(config, writes, tasks[0]!.id);
    });
    expect(await ask('inv_a')).toBe('third done');
    expect(ran).toEqual(['first', 'second', 'third']);
  });
});
