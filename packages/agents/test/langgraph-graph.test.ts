// A LangGraph graph of your own as an agent (`langgraph.agent({ graph })`,
// src/langgraph/graph.ts): the Python SDK's tests/agents_langgraph_graph.py,
// for what this package takes of it.
import * as restate from '@restatedev/sessions';
import { describe, expect, it } from 'vitest';
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { interrupt, MessagesAnnotation, START, END, StateGraph, Annotation } from '@langchain/langgraph';
import * as langgraph from '@restatedev/agents/langgraph';
import { sqlAttempt } from './support.ts';

/** The texts of `messages`, each with its type. */
const said = (messages: readonly BaseMessage[]) => messages.map((m) => `${m.getType()}: ${m.text}`);

/** A graph of one node, `reply`, which answers each message with `answer` of the messages it sees. */
function replying(answer: (messages: BaseMessage[]) => string | Promise<string>) {
  return new StateGraph(MessagesAnnotation)
    .addNode('reply', async ({ messages }) => ({ messages: [new AIMessage(await answer(messages))] }))
    .addEdge(START, 'reply')
    .addEdge('reply', END);
}

/**
 * An agent's object, of state `map`, whose `chat` is `chat`: each attempt of
 * request `id` answers `text`; `signal` answers the companion's waits.
 */
function agentOf(
  chat: ReturnType<typeof langgraph.chat>,
  {
    map = new Map<string, Uint8Array>(),
    signal,
  }: { map?: Map<string, Uint8Array>; signal?: (wait: { id: string; name: string; input?: unknown }) => unknown } = {},
) {
  let requests = 0;
  const ask = (text: string, id = `inv_${++requests}`) => {
    const sql = sqlAttempt({ map, key: 'k', id, signal });
    return sql.end(() => chat.handler(sql.ctx, text));
  };
  const read = <T>(view: (ctx: restate.ViewContext, input: never) => Promise<T>, input?: unknown) => {
    const sql = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
    return sql.end(() => view(sql.view, input as never));
  };
  const texts = async () =>
    (await read(langgraph.messages(), {})).messages.map(
      ({ role, parts }) => `${role}: ${parts.map((p) => ('text' in p ? p.text : JSON.stringify(p))).join('')}`,
    );
  return { ask, read, texts, map };
}

describe('a graph of your own', () => {
  it('answers each message with its last AI message, on a thread that keeps the earlier ones', async () => {
    const seen: string[][] = [];
    const graph = replying((messages) => {
      seen.push(said(messages));
      return `you said ${messages.at(-1)!.text}`;
    });
    const agent = agentOf(langgraph.chat({ graph }));
    expect(await agent.ask('hello')).toBe('you said hello');
    expect(await agent.ask('again')).toBe('you said again');
    // The graph's state keeps the earlier turns: its model reads them, not the conversation.
    expect(seen[1]).toEqual(['human: hello', 'ai: you said hello', 'human: again']);
    expect(await agent.texts()).toEqual([
      'user: hello',
      'assistant: you said hello',
      'user: again',
      'assistant: you said again',
    ]);
  });

  it('answers a retry with the stored answer, without running the graph again', async () => {
    let runs = 0;
    const agent = agentOf(langgraph.chat({ graph: replying(() => `run ${++runs}`) }));
    expect(await agent.ask('hello', 'inv_a')).toBe('run 1');
    expect(await agent.ask('hello', 'inv_a')).toBe('run 1');
    expect(runs).toBe(1);
  });

  it('resumes a run a crash cut off from its last checkpoint: a step stored is not run again', async () => {
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
      .addEdge(START, 'first')
      .addEdge('first', 'second')
      .addEdge('second', END);
    const agent = agentOf(langgraph.chat({ graph }));
    await expect(agent.ask('go', 'inv_a')).rejects.toThrow('the process died');
    expect(await agent.ask('go', 'inv_a')).toBe('second done');
    expect(ran).toEqual(['first', 'second', 'second']);
    // Each AI message is copied once, as its step stored it.
    expect(await agent.texts()).toEqual(['user: go', 'assistant: first done', 'assistant: second done']);
  });

  it('ends a turn on a terminal error, and gives the next run what closed it', async () => {
    const seen: string[][] = [];
    const graph = replying((messages) => {
      seen.push(said(messages));
      if (messages.at(-1)!.text === 'boom') throw new restate.TerminalError('it broke');
      return 'fine';
    });
    const agent = agentOf(langgraph.chat({ graph }));
    await expect(agent.ask('boom')).rejects.toThrow('it broke');
    expect(await agent.ask('next')).toBe('fine');
    // The graph never stored the failed run's prompt: the next run gets it, and the note that closed it.
    expect(seen[1]).toEqual(['human: boom', 'ai: Error: it broke', 'human: next']);
  });

  it('keeps only the latest checkpoint of the thread between turns', async () => {
    const agent = agentOf(langgraph.chat({ graph: replying(() => 'ok') }));
    await agent.ask('one');
    await agent.ask('two');
    const sql = sqlAttempt({ map: agent.map, key: 'k', id: 'count', shared: true });
    const [[count]] = (await sql.end(() =>
      sql.view.db.values('SELECT COUNT(*) FROM restate_langgraph_checkpoints'),
    )) as [[number]];
    expect(count).toBe(1);
  });

  it('answers with the structured response the run wrote, which output checks', async () => {
    const Graph = Annotation.Root({
      ...MessagesAnnotation.spec,
      structuredResponse: Annotation<{ city: string } | undefined>(),
    });
    let n = 0;
    const graph = new StateGraph(Graph)
      .addNode('reply', () => ({
        messages: [new AIMessage('here it is')],
        // The second run writes none: the first's is not its answer.
        ...(++n === 1 ? { structuredResponse: { city: 'Rome' } } : {}),
      }))
      .addEdge(START, 'reply')
      .addEdge('reply', END);
    const { z } = await import('zod');
    const agent = agentOf(langgraph.chat({ graph, output: z.object({ city: z.string() }) }));
    expect(await agent.ask('where?')).toEqual({ city: 'Rome' });
    // No structured response of its own, and a text that is not one: asked again, then failed.
    await expect(agent.ask('and now?')).rejects.toThrow(/not the answer asked for/);
  });

  it("waits for a signal at each interrupt(), and resumes with the signal's value", async () => {
    const waits: { id: string; name: string; input?: unknown }[] = [];
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('approve', ({ messages }) => {
        const answer = interrupt({ refund: messages.at(-1)!.text }) as string;
        return { messages: [new AIMessage(`refund ${answer}`)] };
      })
      .addEdge(START, 'approve')
      .addEdge('approve', END);
    const agent = agentOf(langgraph.chat({ graph }), {
      signal: (wait) => {
        waits.push(wait);
        return 'approved';
      },
    });
    expect(await agent.ask('42 EUR', 'inv_a')).toBe('refund approved');
    expect(waits).toEqual([
      { id: expect.stringMatching(/^inv_a:interrupt:/), name: 'interrupt', input: { refund: '42 EUR' } },
    ]);
  });

  it('waits anew for each interrupt() of a node that interrupts twice', async () => {
    const waits: string[] = [];
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('ask', () => {
        const first = interrupt<string, string>('first?');
        const second = interrupt<string, string>('second?');
        return { messages: [new AIMessage(`${first} then ${second}`)] };
      })
      .addEdge(START, 'ask')
      .addEdge('ask', END);
    const agent = agentOf(langgraph.chat({ graph }), {
      signal: ({ id, input }) => {
        waits.push(id);
        return input === 'first?' ? 'one' : 'two';
      },
    });
    expect(await agent.ask('go', 'inv_a')).toBe('one then two');
    expect(new Set(waits).size).toBe(2);
  });

  it("waits for a subgraph's interrupt() once, and resumes the subgraph", async () => {
    const waits: string[] = [];
    const inner = new StateGraph(MessagesAnnotation)
      .addNode('check', () => ({ messages: [new AIMessage(`checked: ${interrupt<string, string>('check?')}`)] }))
      .addEdge(START, 'check')
      .addEdge('check', END)
      .compile();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('inner', inner)
      .addNode('after', () => ({ messages: [new AIMessage('after')] }))
      .addEdge(START, 'inner')
      .addEdge('inner', 'after')
      .addEdge('after', END);
    const agent = agentOf(langgraph.chat({ graph }), {
      signal: ({ id }) => {
        waits.push(id);
        return 'fine';
      },
    });
    expect(await agent.ask('go')).toBe('after');
    expect(waits).toHaveLength(1);
    expect(await agent.texts()).toEqual(['user: go', 'assistant: checked: fine', 'assistant: after']);
  });

  it('joins the same wait in a retried attempt', async () => {
    const waits: string[] = [];
    const answer = Promise.withResolvers<string>();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('approve', () => ({ messages: [new AIMessage(`refund ${interrupt<string, string>('ok?')}`)] }))
      .addEdge(START, 'approve')
      .addEdge('approve', END);
    const map = new Map<string, Uint8Array>();
    const chat = langgraph.chat({ graph });
    // The first attempt waits, and is gone.
    const first = agentOf(chat, {
      map,
      signal: (wait) => {
        waits.push(wait.id);
        return new Promise(() => {});
      },
    });
    void first.ask('refund', 'inv_a').catch(() => {});
    await expect.poll(() => waits.length, { timeout: 30_000 }).toBe(1);
    const second = agentOf(chat, {
      map,
      signal: (wait) => {
        waits.push(wait.id);
        return answer.promise;
      },
    });
    const answered = second.ask('refund', 'inv_a');
    await expect.poll(() => waits.length, { timeout: 30_000 }).toBe(2);
    answer.resolve('approved');
    expect(await answered).toBe('refund approved');
    expect(waits[1]).toBe(waits[0]);
  });

  it('refuses a graph with static breakpoints, and options only the built-in loop takes', () => {
    const graph = replying(() => 'ok');
    expect(() => langgraph.chat({ graph: graph.compile({ interruptBefore: ['reply'] }) })).toThrow(
      /static breakpoints/,
    );
    expect(() => langgraph.chat({ graph, system: 'Be brief.' })).toThrow(/takes no system/);
    expect(() => langgraph.chat({ context: {} })).toThrow(/pass graph/);
    const stateless = new StateGraph(Annotation.Root({ count: Annotation<number>() }));
    expect(() => langgraph.chat({ graph: stateless as never })).toThrow(/no messages/);
  });

  it('takes a compiled graph, and gives it its run context', async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('reply', (_state, config) => ({
        messages: [new AIMessage(`for ${(config.context as { user: string }).user}`)],
      }))
      .addEdge(START, 'reply')
      .addEdge('reply', END)
      .compile();
    const agent = agentOf(langgraph.chat({ graph, context: { user: 'ada' } }));
    expect(await agent.ask('hi')).toBe('for ada');
    // The compiled graph is the user's: its checkpointer stays theirs.
    expect(graph.checkpointer).toBeUndefined();
  });

  it('copies tool calls and their results into the conversation, step by step', async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('model', ({ messages }) =>
        messages.at(-1)!.getType() === 'tool'
          ? { messages: [new AIMessage('Done.')] }
          : { messages: [new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'lookup', args: {} }] })] },
      )
      .addNode('tools', async () => {
        const { ToolMessage } = await import('@langchain/core/messages');
        return { messages: [new ToolMessage({ content: 'found', tool_call_id: 'c1' })] };
      })
      .addEdge(START, 'model')
      .addConditionalEdges('model', ({ messages }) =>
        (messages.at(-1) as AIMessage).tool_calls?.length ? 'tools' : END,
      )
      .addEdge('tools', 'model');
    const agent = agentOf(langgraph.chat({ graph }));
    expect(await agent.ask('look it up')).toBe('Done.');
    const { messages } = await agent.read(langgraph.messages(), {});
    expect(messages.map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'look it up' }],
      [{ type: 'tool', id: 'c1', name: 'lookup', input: {}, output: 'found' }],
      [{ type: 'text', text: 'Done.' }],
    ]);
  });

  it('gives the system message of a graph of its own to its model, not to the conversation', async () => {
    const graph = replying((messages) => said([new SystemMessage('Be brief.'), ...messages]).join(' | '));
    const agent = agentOf(langgraph.chat({ graph }));
    expect(await agent.ask('hi')).toBe('system: Be brief. | human: hi');
    expect(await agent.texts()).toEqual(['user: hi', 'assistant: system: Be brief. | human: hi']);
    void HumanMessage;
  });
});
