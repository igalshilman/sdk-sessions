// The prebuilt LangGraph nodes (src/langgraph/nodes.ts) and `langgraph.tools()`,
// in a graph of your own: the Python SDK's tests/agents_langgraph_nodes.py,
// for what this package takes of it.
import * as restate from '@restatedev/sessions';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { call as callTool } from '@restatedev/agents';
import * as langgraph from '@restatedev/agents/langgraph';
import { nodes, SqlCheckpointSaver } from '@restatedev/agents/langgraph';
import { type Made, sqlAttempt } from './support.ts';

const orders = restate.object({
  name: 'orders',
  handlers: { status: async (_ctx: unknown, _order: string) => 'shipped' },
});
const lookups = restate.service({ name: 'lookups', handlers: { lookup: async (_ctx, _what: string) => 'found' } });
const shipping = restate.workflow({ name: 'shipping', handlers: { run: async (_ctx, _order: string) => 'receipt' } });
const researcher = restate.object({
  name: 'researcher',
  handlers: { chat: async (_ctx: unknown, _text: string) => 'answer' },
});

/** The graph's state: the messages, and the fields the nodes read and write. */
const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  order: Annotation<string>(),
  result: Annotation<unknown>(),
});

/** A graph of `node` alone, which answers with what it wrote to `result`. */
const around = (node: nodes.Node) =>
  new StateGraph(State)
    .addNode('step', node)
    .addNode('answer', ({ result }) => ({ messages: [new AIMessage(`result: ${JSON.stringify(result ?? null)}`)] }))
    .addEdge(START, 'step')
    .addEdge('step', 'answer')
    .addEdge('answer', END);

/** An agent's object, of state `map`, whose `chat` runs `graph`: each attempt routes its calls to `route`. */
function agentOf(
  graph: langgraph.AnyGraph,
  {
    route,
    signal,
    map = new Map<string, Uint8Array>(),
  }: {
    route?: (call: Made) => Promise<unknown>;
    signal?: (wait: { id: string; name: string; input?: unknown }) => unknown;
    map?: Map<string, Uint8Array>;
  } = {},
) {
  const chat = langgraph.chat({ graph });
  return (text: string, id: string) => {
    const sql = sqlAttempt({ map, key: 'k', id, route, signal });
    return sql.end(() => chat.handler(sql.ctx, text));
  };
}

describe('the prebuilt nodes', () => {
  it('call a handler, once however often the node runs again, and write its result', async () => {
    const made: Made[] = [];
    let crash = true;
    const ask = agentOf(
      around(nodes.call(orders, 'status', { input: () => 'o1', key: () => 'alice', output: 'result' })),
      {
        route: async (c) => {
          made.push(c);
          if (crash) {
            crash = false;
            throw new Error('the process died');
          }
          return 'shipped';
        },
      },
    );
    await expect(ask('status?', 'inv_a')).rejects.toThrow('the process died');
    expect(await ask('status?', 'inv_a')).toBe('result: "shipped"');
    expect(made.map(({ service, method, key, parameter }) => ({ service, method, key, parameter }))).toEqual([
      { service: 'orders', method: 'status', key: 'alice', parameter: 'o1' },
      { service: 'orders', method: 'status', key: 'alice', parameter: 'o1' },
    ]);
    // The same idempotency key each time: Restate makes the call once.
    expect(made[0]!.idempotencyKey).toMatch(/^langgraph:k:step:/);
    expect(made[1]!.idempotencyKey).toBe(made[0]!.idempotencyKey);
  });

  it('send to a handler, and write nothing', async () => {
    const made: Made[] = [];
    const ask = agentOf(around(nodes.send(lookups, 'lookup', { input: () => 'x' })), {
      route: async (c) => {
        made.push(c);
        return undefined;
      },
    });
    expect(await ask('go', 'inv_a')).toBe('result: null');
    expect(made).toMatchObject([{ service: 'lookups', method: 'lookup', parameter: 'x' }]);
  });

  it("run a workflow, by default under an id of the node's own", async () => {
    const made: Made[] = [];
    const ask = agentOf(around(nodes.workflow(shipping, { input: () => 'o1', output: 'result' })), {
      route: async (c) => {
        made.push(c);
        return 'receipt';
      },
    });
    expect(await ask('ship', 'inv_a')).toBe('result: "receipt"');
    expect(made).toMatchObject([{ service: 'shipping', method: 'run', parameter: 'o1' }]);
    expect(made[0]!.key).toBe(made[0]!.idempotencyKey);
  });

  it("ask another agent, on the key of this key and the node's name", async () => {
    const made: Made[] = [];
    const ask = agentOf(around(nodes.subagent(researcher, { message: () => 'why?', output: 'result' })), {
      route: async (c) => {
        made.push(c);
        return 'because';
      },
    });
    expect(await ask('research', 'inv_a')).toBe('result: "because"');
    expect(made).toMatchObject([{ service: 'researcher', method: 'chat', key: 'k.step', parameter: 'why?' }]);
  });

  it('wait for a signal, which pending shows with its input', async () => {
    const waits: { id: string; name: string; input?: unknown }[] = [];
    const ask = agentOf(around(nodes.waitForSignal('approval', { input: () => ({ refund: 42 }), output: 'result' })), {
      signal: (wait) => {
        waits.push(wait);
        return 'approved';
      },
    });
    expect(await ask('refund', 'inv_a')).toBe('result: "approved"');
    expect(waits).toEqual([
      { id: expect.stringMatching(/^inv_a:langgraph:k:step:/), name: 'approval', input: { refund: 42 } },
    ]);
  });

  it('run in a handler of your own, with its context as the run context', async () => {
    const made: Made[] = [];
    const sql = sqlAttempt({
      map: new Map(),
      key: 'k',
      id: 'inv_a',
      route: async (c) => {
        made.push(c);
        return 'found';
      },
    });
    const graph = around(nodes.call(lookups, 'lookup', { input: (s: { order: string }) => s.order, output: 'result' }));
    const { messages } = (await sql.end(() =>
      graph
        .compile({ checkpointer: new SqlCheckpointSaver(sql.ctx.db) })
        .invoke({ order: 'o7' }, { configurable: { thread_id: 't' }, context: sql.ctx as never, durability: 'sync' }),
    )) as { messages: BaseMessage[] };
    expect(messages.at(-1)!.text).toBe('result: "found"');
    expect(made).toMatchObject([{ service: 'lookups', method: 'lookup', parameter: 'o7' }]);
  });

  it('refuse a graph run without a context, a checkpointer, or sync durability', async () => {
    const graph = around(nodes.call(lookups, 'lookup', { input: () => 'x' }));
    await expect(graph.compile().invoke({})).rejects.toThrow(/handler's context/);
    const first = sqlAttempt({ map: new Map(), key: 'k', id: 'inv_a' });
    await expect(first.end(() => graph.compile().invoke({}, { context: first.ctx as never }))).rejects.toThrow(
      /checkpointer/,
    );
    const second = sqlAttempt({ map: new Map(), key: 'k', id: 'inv_b' });
    const saved = graph.compile({ checkpointer: new SqlCheckpointSaver(second.ctx.db) });
    await expect(
      second.end(() =>
        saved.invoke({}, { configurable: { thread_id: 't' }, context: second.ctx as never, durability: 'async' }),
      ),
    ).rejects.toThrow(/durability: 'sync'/);
  });

  it('refuse a key for a target that is not keyed, and want one for one that is', () => {
    expect(() => nodes.call(lookups, 'lookup', { key: () => 'x' })).toThrow(/is not keyed/);
    expect(() => nodes.call(orders, 'status', {})).toThrow(/is keyed/);
  });
});

describe('langgraph.tools()', () => {
  it("make Restate's calls once per tool call in a graph of your own, through crashes", async () => {
    const made: Made[] = [];
    let crash = true;
    const tools = langgraph.tools([
      callTool(lookups, 'lookup', { description: 'Look it up.', input: z.object({ what: z.string() }) }),
    ]);
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('model', ({ messages }) => {
        if (messages.at(-1)!.getType() !== 'tool') {
          return {
            messages: [
              new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'lookups_lookup', args: { what: 'x' } }] }),
            ],
          };
        }
        // The process dies once the tool's result is stored, before the model's next reply is.
        if (crash) {
          crash = false;
          throw new Error('the process died');
        }
        return { messages: [new AIMessage(`Found: ${messages.at(-1)!.text}`)] };
      })
      .addNode('tools', new ToolNode(tools))
      .addEdge(START, 'model')
      .addConditionalEdges('model', toolsCondition, { tools: 'tools', [END]: END })
      .addEdge('tools', 'model');
    const ask = agentOf(graph, {
      route: async (c) => {
        made.push(c);
        return 'found';
      },
    });
    await expect(ask('look', 'inv_a')).rejects.toThrow('the process died');
    expect(await ask('look', 'inv_a')).toBe('Found: found');
    expect(made).toMatchObject([{ service: 'lookups', method: 'lookup', parameter: { what: 'x' } }]);
    expect(made[0]!.idempotencyKey).toBe('inv_a:c1');
  });

  it("refuse a Restate tool outside a graph's run", async () => {
    const [looked] = langgraph.tools([callTool(lookups, 'lookup', { description: 'Look it up.' })]);
    await expect(looked!.invoke({ id: 'c1', name: 'lookups_lookup', args: {}, type: 'tool_call' })).rejects.toThrow(
      /handler's context/,
    );
  });
});
