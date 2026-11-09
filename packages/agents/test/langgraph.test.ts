// The agent's handler without a Restate server, through crashes of the
// handler (see ../testing.ts): LangGraph gets no chance to save anything on the
// way out of a crashed attempt. `pnpm --filter @restatedev/agents test langgraph`. Its model is the teller (../fakes/langgraph.ts).
import { describe, expect, it, vi } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import { CANCELLED, REFUSED, UNANSWERED } from '@restatedev/agents';
import { AIMessage } from '@langchain/core/messages';
import { EmptyInputError, InvalidUpdateError } from '@langchain/langgraph';
import { AttemptEnded, ENDED } from '../src/common.ts';
import {
  afterCancel,
  cancelledTransfer,
  cancelledWhileWorking,
  endedWhileWorking,
  invalidArguments,
  followedWhileWorking,
  withoutIds,
  conversation,
  crashedAnywhere,
  SAID_IN_TURNS as SAID,
  steeredAtAStep,
  followingOf,
  sqlAttempt,
} from './support.ts';
import { Teller } from './fakes/langgraph.ts';
import * as langgraph from '@restatedev/agents/langgraph';
import { prompt } from './langgraph.ts';
import { bank } from './bank.ts';

describe('the LangGraph agent', () => {
  it('answers arguments that do not fit a tool with what is wrong, for the model to fix', async () => {
    const { answer, ran } = await invalidArguments((tools) => langgraph.chat({ tools }));
    expect(answer).toMatch(/error/i);
    expect(answer).toMatch(/amount/);
    expect(ran).toBe(false);
  });

  it('ends a turn cancelled at any moment as one cancelled while a tool waits', async () => {
    const now = await cancelledWhileWorking((tools) => langgraph.chat({ tools }), langgraph.messages());
    const waiting = await afterCancel(langgraph.chat({ tools: [cancelledTransfer] }), langgraph.messages());
    expect(now.failed).toBeInstanceOf(restate.CancelledError);
    expect(now.answer).toBe(waiting.answer);
    expect(withoutIds(now.parts)).toEqual(withoutIds(waiting.parts));
  });

  it('stops a turn whose attempt ended, and the next attempt goes on with it', async () => {
    const { failed, closed, answer } = await endedWhileWorking((tools) => langgraph.chat({ tools }));
    // Stopped, not cancelled: the turn is not closed, and the retry answers it.
    expect(failed).toBeInstanceOf(AttemptEnded);
    expect(closed).toEqual([]);
    expect(answer).toBe('Done: moved 5 from account 1 to account 2');
  });

  it('publishes the conversation as a turn and its tool calls start and end', async () => {
    const { answer, published, outputs } = await followedWhileWorking(
      (tools) => langgraph.chat({ tools }),
      langgraph.messages(),
    );
    // A follower reads the call as it starts, and its output as it ends.
    expect(outputs).toEqual([undefined, 'moved 5 from account 1 to account 2']);
    expect(answer).toBe('Done: moved 5 from account 1 to account 2');
    // Published at its start, as its tool call starts and ends, and at its end.
    expect(published).toBe(4);
  });

  it('ends a cancelled turn, and answers the next message afresh', async () => {
    const { failed, answer, parts } = await afterCancel(
      langgraph.chat({ tools: [cancelledTransfer] }),
      langgraph.messages(),
    );
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(answer).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    expect(parts).toEqual([
      [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
      [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool',
          id: expect.stringMatching(/^call_/),
          name: 'transfer',
          input: { from: 1, to: 2, amount: 5 },
          output: CANCELLED,
          error: true,
        },
      ],
      [{ type: 'text', text: CANCELLED }],
      [{ type: 'text', text: 'Hello' }],
      [{ type: 'text', text: 'Ask me to "move 5 from 1 to 2", or to "audit" the books.' }],
    ]);
  });

  it('answers a message once after a crash at any of its state requests', async () => {
    expect(await crashedAnywhere(prompt, langgraph.messages())).toEqual([]);
  }, 600_000);

  it('tells the model a tool it does not have is not there', async () => {
    // The teller audits with a tool `audit`, which this agent lacks.
    const c = conversation(langgraph.chat(), 'unknown');
    expect(await c.attempt('inv1', 'audit the books')).toMatch(/^Done: .*audit/s);
  });

  it('gives the conversation: what was said, in order, with the tool calls', async () => {
    const c = conversation(prompt, 'm');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'audit the books');
    expect(await c.read(langgraph.messages())).toEqual({ messages: SAID, more: false, cursor: expect.any(Number) });
  });

  it('keeps no checkpoint: the conversation of turns is its state', async () => {
    const c = conversation(prompt, 'latest');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'audit the books');
    const tables = await c.read(async (ctx) =>
      (await ctx.db.values("SELECT name FROM sqlite_schema WHERE type = 'table'")).map(([name]) => String(name)),
    );
    expect(tables.filter((t) => t.startsWith('restate_langgraph'))).toEqual([]);
    expect(await c.read(langgraph.messages())).toMatchObject({ messages: SAID });
  });

  it('ends a prompt the provider refused, and answers the next message afresh', async () => {
    // The teller, but for its first reply: a wrong API key.
    let refused = false;
    const model = new (class extends Teller {
      override reply(...args: Parameters<Teller['reply']>) {
        if (refused) return super.reply(...args);
        refused = true;
        throw new Error('Anthropic API key not found');
      }
    })({});
    const c = conversation(langgraph.chat({ model, tools: bank('GraphAgent') }), 'refused');
    await expect(c.attempt('inv1', 'Please move 5 from 1 to 2')).rejects.toMatchObject({ code: REFUSED });
    // Retried (a crash after its end was stored), it fails again, rather than answer.
    await expect(c.attempt('inv1', 'Please move 5 from 1 to 2')).rejects.toMatchObject({ code: REFUSED });
    expect(await c.attempt('inv2', 'Hello')).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    expect(c.ledger.calls).toEqual([]);
    const { messages } = await c.read(langgraph.messages());
    expect(messages[1]!.parts).toEqual([{ type: 'text', text: UNANSWERED }]);
  });

  it('sends a reply of the model with nothing in it back as one that says so: a provider may refuse it empty', async () => {
    // The teller, but for `Hello`, which it answers with nothing; and, as Anthropic's API, it refuses an empty message.
    class BadRequestError extends Error {}
    const model = new (class extends Teller {
      override reply(...args: Parameters<Teller['reply']>) {
        const [messages] = args;
        if (messages.slice(0, -1).some((m) => !m.text.trim() && !(m as AIMessage).tool_calls?.length)) {
          throw new BadRequestError('all messages must have non-empty content');
        }
        return messages.at(-1)!.text === 'Hello' ? new AIMessage('') : super.reply(...args);
      }
    })({});
    const c = conversation(langgraph.chat({ model }), 'empty');
    expect(await c.attempt('inv1', 'Hello')).toBe('');
    expect(await c.attempt('inv2', 'Hello again')).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
  });

  it('gives the model its system prompt', async () => {
    const c = conversation(langgraph.chat({ system: 'You are Ada.' }), 'ada');
    expect(await c.attempt('inv1', 'Who are you?')).toBe('You are Ada.');
  });

  it('answers a message once per invocation', async () => {
    const c = conversation(prompt, 'a');
    const first = await c.attempt('inv1', 'Please move 5 from 1 to 2');
    expect(first).toBe('Done: moved 5 from account 1 to account 2');
    // Its attempt retried: the same answer, no new transfer.
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toEqual(first);
    expect(c.ledger.calls).toHaveLength(1);
    expect([...c.ledger.transfers.keys()]).toEqual([expect.stringMatching(/^GraphAgent\/a\/call_/)]);
    // The next prompt goes on in the same thread.
    const audit = await c.attempt('inv3', 'audit the books');
    expect(audit).toMatch(/^Done: .*"transfers":1/);
  });

  it('resumes a crashed attempt from its last step, with the same tool call', async () => {
    const c = conversation(prompt, 'b');
    const reply = vi.spyOn(Teller.prototype, 'reply');
    try {
      const input = 'Please move 7 from 3 to 4';
      await c.crash('inv1', input);
      expect(reply).toHaveBeenCalledTimes(1);
      // The retried attempt runs the tool again, not the model.
      expect(await c.attempt('inv1', input)).toBe('Done: moved 7 from account 3 to account 4');
      expect(reply).toHaveBeenCalledTimes(2); // the answer after the tool
    } finally {
      reply.mockRestore();
    }
    // The same transfer id and idempotency key both times: the money moved once.
    const id = c.ledger.calls[0]!.id.split('/').at(-1)!;
    expect(id).toMatch(/^call_/);
    expect(c.ledger.calls).toEqual([
      { name: 'transfer', id: `GraphAgent/b/${id}`, key: `inv1:${id}` },
      { name: 'transfer', id: `GraphAgent/b/${id}`, key: `inv1:${id}` },
    ]);
    expect(c.ledger.transfers.size).toBe(1);
  });

  it("fails the attempt on a tool's error, rather than hand it to the model", async () => {
    const c = conversation(prompt, 'd');
    c.ledger.failNext = 1;
    const input = 'Please move 3 from 5 to 6';
    await expect(c.attempt('inv1', input)).rejects.toThrow('crash after the transfer');
    expect(await c.attempt('inv1', input)).toBe('Done: moved 3 from account 5 to account 6');
    expect(c.ledger.transfers.size).toBe(1);
  });

  it('closes a turn its gone invocation left, by the next message: never finishes it', async () => {
    const c = conversation(prompt, 'c');
    // Killed in its transfer: its invocation is gone, and the next message comes.
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    const reply = vi.spyOn(Teller.prototype, 'reply');
    try {
      expect(await c.attempt('inv2', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
      // The model was asked for the second message only, and saw how the first ended.
      expect(reply).toHaveBeenCalledTimes(2);
      expect(reply.mock.calls[0]![0].map((m) => m.text)).toContain(ENDED);
    } finally {
      reply.mockRestore();
    }
    expect(c.ledger.transfers.size).toBe(2);
    const { messages } = await c.read(langgraph.messages());
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages[2]!.parts).toEqual([{ type: 'text', text: ENDED }]);
    await expect(c.attempt('inv1', 'Please move 1 from 0 to 1')).rejects.toThrow(ENDED);
  });

  it('answers a stored final reply without asking the model again', async () => {
    let stored = 0;
    for (let at = 1; ; at++) {
      const c = conversation(prompt, `final-${at}`);
      const reply = vi.spyOn(Teller.prototype, 'reply');
      try {
        if ((await c.attempt('inv1', 'Hello', at)) !== 'crashed') break;
        const replied = (await c.read(langgraph.messages())).messages.length > 1;
        const asked = reply.mock.calls.length;
        expect(await c.attempt('inv1', 'Hello')).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
        if (replied) stored++;
        expect(reply.mock.calls.length - asked).toBe(replied ? 0 : 1);
      } finally {
        reply.mockRestore();
      }
    }
    expect(stored).toBeGreaterThan(0);
  });

  it('closes a turn that failed for good, and answers the next message', async () => {
    let failing = true;
    const model = new (class extends Teller {
      override reply(...args: Parameters<Teller['reply']>) {
        if (failing) throw new restate.TerminalError('the model is gone for good');
        return super.reply(...args);
      }
    })({});
    const c = conversation(langgraph.chat({ model, tools: bank('GraphAgent') }), 'terminal');
    await expect(c.attempt('inv1', 'Please move 5 from 1 to 2')).rejects.toThrow('gone for good');
    failing = false;
    expect(await c.attempt('inv2', 'Hello')).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    const { messages } = await c.read(langgraph.messages());
    expect(messages[1]!.parts).toEqual([{ type: 'text', text: 'Error: the model is gone for good' }]);
  });

  it('ends a turn that runs past its recursion limit, for good', async () => {
    // A model that calls a tool forever.
    const model = new (class extends Teller {
      override reply(messages: Parameters<Teller['reply']>[0]) {
        return new AIMessage({ content: '', tool_calls: [{ id: `loop_${messages.length}`, name: 'audit', args: {} }] });
      }
    })({});
    const c = conversation(langgraph.chat({ model, tools: bank('GraphAgent'), recursionLimit: 20 }), 'loop');
    const failed = await c.attempt('inv1', 'audit forever').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect(String(failed)).toMatch(/Recursion limit/i);
    // The turn is closed with the error, for the next message to start afresh.
    const { messages } = await c.read(langgraph.messages());
    expect(messages.at(-1)!.parts).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(/^Error: the graph stopped at its recursion limit: Recursion limit/),
      },
    ]);
  });

  it("ends a turn on LangGraph's own errors, which a retry would meet again", async () => {
    for (const [error, why] of [
      [new InvalidUpdateError('two values for one field'), 'the graph made an invalid state update'],
      [new EmptyInputError('no input'), 'the graph got no input'],
    ] as const) {
      let runs = 0;
      const model = new (class extends Teller {
        override reply(): never {
          runs++;
          throw error;
        }
      })({});
      const c = conversation(langgraph.chat({ model, tools: bank('GraphAgent') }), why);
      const failed = await c.attempt('inv1', 'Hello').catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(restate.TerminalError);
      expect(String(failed)).toContain(`${why}: ${error.message}`);
      // A retry answers as the turn ended, without running the graph again.
      await expect(c.attempt('inv1', 'Hello')).rejects.toThrow(why);
      expect(runs).toBe(1);
    }
  });
});

/** Whether the turn of `chat` (on an object of its own) says, as it starts, that it takes steered messages. */
async function steersOf(chat: ReturnType<typeof langgraph.chat>, key: string) {
  const map = new Map<string, Uint8Array>();
  const said: (boolean | undefined)[] = [];
  const published = async () => void said.push(followingOf(map).answering?.steers);
  const sql = sqlAttempt({ map, key, id: 'inv1', published });
  await sql.end(() => chat.handler(sql.ctx, 'Hello'));
  return said[0];
}

describe('the LangGraph agent, steered', () => {
  it('takes a message steered while a tool runs at its next step: the next request ends with it', async () => {
    const { answer, said, audits, taken } = await steeredAtAStep(
      (tools) => langgraph.chat({ tools, model: new Teller({}) }),
      langgraph.messages(),
    );
    expect(answer).toBe('Done: the books are fine');
    expect(said).toEqual([
      ['user', 'Please move 5 from 1 to 2'],
      ['assistant', 'On it. + transfer'],
      ['user', 'audit the books'],
      ['assistant', 'audit'],
      ['assistant', 'Done: the books are fine'],
    ]);
    expect(audits).toBe(1);
    expect(taken).toEqual(['steer-1']);
  });

  it('retries a turn that failed after it took the message with the message, once', async () => {
    const { answer, failed, said, audits, taken } = await steeredAtAStep(
      (tools) => langgraph.chat({ tools, model: new Teller({}) }),
      langgraph.messages(),
      {
        failAudit: true,
      },
    );
    expect(failed).toBeInstanceOf(Error);
    expect(answer).toBe('Done: the books are fine');
    expect(said).toEqual([
      ['user', 'Please move 5 from 1 to 2'],
      ['assistant', 'On it. + transfer'],
      ['user', 'audit the books'],
      ['assistant', 'audit'],
      ['assistant', 'Done: the books are fine'],
    ]);
    expect(audits).toBe(2);
    expect(taken).toEqual(['steer-1']);
  });

  it('takes none in a graph of your own: each steered message is a turn of its own', async () => {
    const { chatOf } = await import('../src/common.ts');
    const graph = new (await import('@langchain/langgraph')).StateGraph(
      (await import('@langchain/langgraph')).MessagesAnnotation,
    )
      .addNode('echo', () => ({ messages: [new AIMessage('echo')] }))
      .addEdge('__start__', 'echo');
    expect(chatOf(langgraph.chat({ graph }))?.steers).toBe(false);
    expect(chatOf(langgraph.chat({}))?.steers).toBe(true);
    // Options a function gives: each turn says, as it starts, what its options' graph takes.
    expect(
      await steersOf(
        langgraph.chat(async () => ({ graph })),
        'graph',
      ),
    ).toBeUndefined();
    expect(
      await steersOf(
        langgraph.chat(async () => ({ model: new Teller({}) })),
        'loop',
      ),
    ).toBe(true);
  });
});
