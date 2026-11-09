// pi's chat without a Restate server or an API key: Anthropic's provider is a
// fake model (../fakes/pi.ts).
import * as restate from '@restatedev/sessions';
import { CANCELLED, chatHandler, subagent, tool } from '@restatedev/agents';
import { z } from 'zod';
import * as pi from '@restatedev/agents/pi';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { describe, expect, it, vi } from 'vitest';
import { callTools, fakeProvider, say, textOf, unavailable } from './fakes/pi.ts';
import { AttemptEnded } from '../src/common.ts';
import { Conversation } from '../src/conversation.ts';
import {
  afterCancel,
  cancelledTransfer,
  cancelledWhileWorking,
  endedWhileWorking,
  invalidArguments,
  followedWhileWorking,
  withoutIds,
  type Made,
  type Entry,
  handlerOf,
  followingOf,
  sqlAttempt,
  steeredAtAStep,
} from './support.ts';

/** How many more requests the provider fails, unavailable, before it answers again. */
const outage = vi.hoisted(() => ({ left: 0 }));

// It repeats what it was told so far; asked to delegate, it hands out two
// tasks, and then reports their results.
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  builtinProviders: () => [
    fakeProvider('openai', 'gpt-6-sol', ({ messages }) => {
      if (outage.left > 0) {
        outage.left--;
        return unavailable('503 Service Unavailable');
      }
      const last = messages.at(-1)!;
      if (last.role === 'toolResult') {
        return say(
          messages
            .filter((m) => m.role === 'toolResult')
            .map((m) => textOf(m.content))
            .join('\n'),
        );
      }
      // Asked who it is, it repeats its system prompt.
      if (textOf(last.content) === 'Who are you?') {
        const system = messages.find((m) => m.role === 'system') as { sections?: Record<string, string> } | undefined;
        return say(Object.values(system?.sections ?? {}).join('\n'));
      }
      if (textOf(last.content) === 'Break it') return callTools([['boom', {}]]);
      if (textOf(last.content) === 'Look it up') return callTools([['lookup', {}]]);
      if (textOf(last.content) === 'audit the books') return callTools([['audit', {}]]);
      if (textOf(last.content) === 'Please move 5 from 1 to 2') {
        return callTools([['transfer', { from: 1, to: 2, amount: 5 }]], 'On it.');
      }
      if (textOf(last.content).startsWith('delegate')) {
        return callTools([
          ['coder', { name: 'fizzbuzz', task: 'write fizzbuzz.py' }],
          ['coder', { name: 'primes', task: 'write primes.py' }],
        ]);
      }
      return say(
        messages
          .filter((m) => m.role === 'user')
          .map((m) => textOf(m.content))
          .join(' / '),
      );
    }),
  ],
}));

interface Call {
  service: string;
  key?: string;
  method: string;
  parameter: unknown;
  idempotencyKey?: string;
}

/** An object with key `key`: its database lives across invocations, and its calls are recorded. */
function object(key: string) {
  const map = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const route = async (call: Made) => {
    calls.push(call);
    return `${call.key}: done`;
  };
  return {
    calls,
    /** Invocation `id` of `handler`. */
    invoke<I, O>(handler: Entry<(ctx: restate.SessionContext, input: I) => Promise<O>>, id: string, input: I) {
      const sql = sqlAttempt({ map, key, id, route });
      return sql.end(() => handlerOf(handler)(sql.ctx, input));
    },
  };
}

/** Message `id` of `messages`: `text` of `role`. */
const said = (id: number, role: string, text: string) => ({ id, role, parts: [{ type: 'text', text }] });

describe('pi.messages', () => {
  it('answers arguments that do not fit a tool with what is wrong, for the model to fix', async () => {
    const { answer, ran } = await invalidArguments((tools) => pi.chat({ tools }));
    expect(answer).toMatch(/error/i);
    expect(answer).toMatch(/amount/);
    expect(ran).toBe(false);
  });

  it("marks a tool's error", async () => {
    const alice = object('alice');
    const lookup = tool({
      name: 'lookup',
      description: 'Finds nothing.',
      input: z.object({}),
      run: () => {
        throw new restate.TerminalError('no such page');
      },
    });
    await alice.invoke(pi.chat({ tools: [lookup] }), 'inv1', 'Look it up');
    const { messages } = await alice.invoke(pi.messages(), 'read', {});
    expect(messages[1]?.parts).toEqual([
      { type: 'tool', id: expect.any(String), name: 'lookup', input: {}, output: 'Error: no such page', error: true },
    ]);
  });

  it("reads without MODEL's provider", async () => {
    const alice = object('alice');
    await alice.invoke(pi.chat(), 'inv1', 'Hi, I am Alice');
    vi.stubEnv('MODEL', 'nowhere/nothing');
    try {
      expect((await alice.invoke(pi.messages(), 'read', {})).messages).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives the conversation: what was said, in order, a page at a time', async () => {
    const alice = object('alice');
    await alice.invoke(pi.chat(), 'inv1', 'Hi, I am Alice');
    await alice.invoke(pi.chat(), 'inv2', 'What is my name?');
    expect(await alice.invoke(pi.messages(), 'read', {})).toEqual({
      messages: [
        said(0, 'user', 'Hi, I am Alice'),
        said(1, 'assistant', 'Hi, I am Alice'),
        said(2, 'user', 'What is my name?'),
        said(3, 'assistant', 'Hi, I am Alice / What is my name?'),
      ],
      more: false,
      cursor: expect.any(Number),
    });
    expect(await alice.invoke(pi.messages(), 'read2', { limit: 1, before: 3 })).toEqual({
      messages: [said(2, 'user', 'What is my name?')],
      more: true,
      cursor: expect.any(Number),
    });
  });

  it('keeps what was said through a reset, and follows on after it with new ids', async () => {
    const alice = object('alice');
    await alice.invoke(pi.chat(), 'inv1', 'Hi, I am Alice');
    const { cursor } = await alice.invoke(pi.messages(), 'read', {});
    await alice.invoke(reset, 'inv2', undefined);
    await alice.invoke(pi.chat(), 'inv3', 'Who am I?');
    // The model starts over (it does not know Alice); clients still read what was said.
    const since = await alice.invoke(pi.messages(), 'read2', { cursor });
    expect(since.messages).toEqual([said(2, 'user', 'Who am I?'), said(3, 'assistant', 'Who am I?')]);
    const all = await alice.invoke(pi.messages(), 'read3', {});
    expect(all.messages.map((m: { id: number }) => m.id)).toEqual([0, 1, 2, 3]);
  });
});

/** A handler that starts the conversation over. */
const reset = (ctx: restate.SessionContext) =>
  pi.withPi(ctx, {}, async ({ conversation, context }) => (await conversation()).reset(undefined, context));

/** A handler that prompts as in 0.3.0, with an id: from JavaScript, as TypeScript refuses it. */
const byItsId = (ctx: restate.SessionContext) =>
  pi.withPi(ctx, {}, (session) => session.prompt('Hi', 'greeting' as unknown as undefined));

/** A handler that prompts twice. */
const twice = async (ctx: restate.SessionContext) => [
  await pi.prompt(ctx, 'One'),
  await pi.withPi(ctx, {}, (session) => session.prompt('Two')),
];

describe('pi.chat', () => {
  it("answers through a provider's outage, however many times its requests fail", async () => {
    // More failures than pi-durable's own 3 retries, which ended the turn unanswered.
    outage.left = 6;
    const alice = object('alice');
    const chat = pi.chat({ retry: { baseDelayMs: 1, maxAgentDelayMs: 1 } });
    const answer = await alice.invoke(chat, 'inv1', 'Hi, I am Alice');
    expect([outage.left, answer]).toEqual([0, 'Hi, I am Alice']);
  });

  it('ends a turn cancelled at any moment as one cancelled while a tool waits', async () => {
    const now = await cancelledWhileWorking((tools) => pi.chat({ tools }), pi.messages());
    const waiting = await afterCancel(pi.chat({ tools: [cancelledTransfer] }), pi.messages());
    expect(now.failed).toBeInstanceOf(restate.CancelledError);
    expect(now.answer).toBe(waiting.answer);
    expect(withoutIds(now.parts)).toEqual(withoutIds(waiting.parts));
  });

  it('stops a turn whose attempt ended, and the next attempt goes on with it', async () => {
    const { failed, closed, answer } = await endedWhileWorking((tools) => pi.chat({ tools }));
    // Stopped, not cancelled: the turn is not closed, and the retry answers it.
    expect(failed).toBeInstanceOf(AttemptEnded);
    expect(closed).toEqual([]);
    // This model answers with the tool results: the transfer's alone.
    expect(answer).toBe('moved 5 from account 1 to account 2');
  });

  it('fails with the cancellation of work that is not a prompt, as a prompt does', async () => {
    const started = Promise.withResolvers<void>();
    const lookup = tool({
      name: 'lookup',
      description: 'Look it up.',
      input: z.object({}),
      run: async () => {
        started.resolve();
        return new Promise<string>(() => {});
      },
    });
    // Its work hands pi a message of its own, and waits for pi to be idle: the cancellation's abort ends that.
    const waiting = chatHandler((ctx) =>
      pi.withPi(ctx, { tools: [lookup] }, async (session) => {
        const root = await session.conversation();
        await root.submit({ type: 'input', content: 'Look it up' }, session.context);
        await root.waitForIdle(session.context);
        return 'idle';
      }),
    );
    const sql = sqlAttempt({ map: new Map(), key: 'k', id: 'inv1' });
    const answer = sql.end(() => handlerOf(waiting)(sql.ctx, 'Look it up'));
    await started.promise;
    sql.cancel();
    await expect(answer).rejects.toBeInstanceOf(restate.CancelledError);
  });

  it('ends a cancelled turn, and answers the next message afresh', async () => {
    const { failed, answer, parts } = await afterCancel(pi.chat({ tools: [cancelledTransfer] }), pi.messages());
    expect(failed).toBeInstanceOf(restate.CancelledError);
    // The next model is told how the turn before ended, with the message.
    expect(answer).toBe(`Please move 5 from 1 to 2 / (${CANCELLED})\n\nHello`);
    // The turn's close ends the tool call, and the turn, as cancelled.
    expect(parts).toEqual([
      [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
      [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool',
          id: expect.any(String),
          name: 'transfer',
          input: { from: 1, to: 2, amount: 5 },
          output: CANCELLED,
          error: true,
        },
      ],
      [{ type: 'text', text: CANCELLED }],
      [{ type: 'text', text: 'Hello' }],
      [{ type: 'text', text: `Please move 5 from 1 to 2 / (${CANCELLED})\n\nHello` }],
    ]);
  });

  it('publishes the conversation as a turn and its tool calls start and end', async () => {
    const { answer, parts, published, outputs } = await followedWhileWorking(
      (tools) => pi.chat({ tools }),
      pi.messages(),
    );
    expect(answer).toBe('moved 5 from account 1 to account 2');
    expect(parts).toEqual([
      [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
      [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool',
          name: 'transfer',
          input: { from: 1, to: 2, amount: 5 },
          output: 'moved 5 from account 1 to account 2',
        },
      ],
      [{ type: 'text', text: answer }],
    ]);
    // Published at its start, as its tool call starts and ends, and at its end.
    expect(published).toBe(4);
    // A follower reads the call as it starts, and its output as it ends.
    expect(outputs).toEqual([undefined, answer]);
  });

  it('in the background, publishes only the end of a turn', async () => {
    const unwatched = pi.agent({ name: 'unwatched', background: true });
    const { published } = await followedWhileWorking((tools) => pi.chat({ tools }), pi.messages(), {
      object: unwatched,
    });
    expect(published).toBe(1);
  });

  it('takes options for each invocation', async () => {
    const ada = object('ada');
    const chat = pi.chat(async (ctx) => ({ system: `You are ${ctx.key}.` }));
    expect(await ada.invoke(chat, 'inv1', 'Who are you?')).toContain('You are ada.');
  });

  it('gives the model its system prompt', async () => {
    const ada = object('ada');
    expect(await ada.invoke(pi.chat({ system: 'You are Ada.' }), 'inv1', 'Who are you?')).toContain('You are Ada.');
  });

  it("fails the attempt on a tool's error, and the retry runs the tool call again", async () => {
    const alice = object('alice');
    const calls: string[] = [];
    const boom = tool({
      name: 'boom',
      description: 'Fails the first time.',
      input: z.object({}),
      run: async (_input, { callId }) => {
        calls.push(callId);
        if (calls.length === 1) throw new Error('the disk is on fire');
        return 'fixed';
      },
    });
    const chat = pi.chat({ tools: [boom] });
    await expect(alice.invoke(chat, 'inv1', 'Break it')).rejects.toThrow('the disk is on fire');
    expect(await alice.invoke(chat, 'inv1', 'Break it')).toBe('fixed');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
  });

  it("never takes a pi tool's error for the provider refusing the model", async () => {
    // A tool of pi's own, whose request fails as a provider's would (an HTTP library's 404, say).
    class NotFoundError extends Error {}
    const boom = defineTool({
      name: 'boom',
      description: 'Looks a page up.',
      parameters: Type.Object({}),
      execute: async () => {
        throw new NotFoundError('no such page');
      },
    });
    const failed = object('alice').invoke(pi.chat({ tools: [boom] }), 'inv1', 'Break it');
    await expect(failed).rejects.toThrow('no such page');
    await expect(failed).rejects.not.toBeInstanceOf(restate.TerminalError);
  });

  it("reads only the latest turns of a long conversation, as pi keeps the model's history", async () => {
    const alice = object('alice');
    for (let n = 0; n < 8; n++) await alice.invoke(pi.chat(), `inv${n}`, `message ${n}`);
    const load = vi.spyOn(Conversation, 'load');
    try {
      await alice.invoke(pi.chat(), 'inv8', 'message 8');
      const loaded = (await load.mock.results[0]!.value) as Conversation<unknown>;
      // The turn before (the model is told how it ended) and the one it answers: not the 7 before them.
      expect(loaded.transcript).toHaveLength(2);
    } finally {
      load.mockRestore();
    }
  });

  it('answers each prompt of an invocation, and each once', async () => {
    const alice = object('alice');
    expect(await alice.invoke(twice, 'inv1', undefined)).toEqual(['One', 'One / Two']);
    expect(await alice.invoke(twice, 'inv1', undefined)).toEqual(['One', 'One / Two']);
  });

  it("fails for good, saying why, given a prompt's id as 0.3.0's prompt(text, id) took", async () => {
    const alice = object('alice');
    const failed = await alice.invoke(byItsId, 'inv1', undefined).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect(String(failed)).toMatch(/takes a check of the answer, not "greeting"/);
  });

  it('remembers the conversation across messages, and answers a retried message once', async () => {
    const alice = object('alice');
    const chat = pi.chat();
    expect(await alice.invoke(chat, 'inv1', 'Hi, I am Alice')).toBe('Hi, I am Alice');
    expect(await alice.invoke(chat, 'inv2', 'What is my name?')).toBe('Hi, I am Alice / What is my name?');
    // The same invocation again: its prompt is answered already.
    expect(await alice.invoke(chat, 'inv2', 'What is my name?')).toBe('Hi, I am Alice / What is my name?');
  });
});

/** A sub-agent with a `code` handler. */
const coder = { name: 'coder' } as restate.VirtualObjectDefinition<
  'coder',
  { code: (ctx: restate.SessionContext, task: string) => Promise<string> }
>;

describe('subagent', () => {
  it('hands each task to the sub-agent of its name, once per tool call', async () => {
    const alice = object('alice');
    const chat = pi.chat({ tools: [subagent(coder, { handler: 'code' })] });
    expect(await alice.invoke(chat, 'inv1', 'delegate fizzbuzz and primes')).toBe(
      'alice.fizzbuzz: done\nalice.primes: done',
    );
    expect(alice.calls.map((c) => [c.service, c.key, c.method, c.parameter])).toEqual([
      ['coder', 'alice.fizzbuzz', 'code', 'write fizzbuzz.py'],
      ['coder', 'alice.primes', 'code', 'write primes.py'],
    ]);
    // One idempotency key per tool call, made from the invocation id.
    expect(new Set(alice.calls.map((c) => c.idempotencyKey)).size).toBe(2);
    expect(alice.calls.every((c) => c.idempotencyKey?.startsWith('inv1:'))).toBe(true);
  });
});

describe('pi, steered', () => {
  /** The steered message, placed by pi as the transfer's round ends, after its result: the model audits. */
  const SAID_STEERED = [
    ['user', 'Please move 5 from 1 to 2'],
    ['assistant', 'On it. + transfer'],
    ['user', 'audit the books'],
    ['assistant', 'audit'],
    ['assistant', 'moved 5 from account 1 to account 2\nthe books are fine'],
  ];

  it('submits a message steered while a tool runs to its inbox as the round ends: the next request has it', async () => {
    const { answer, said: shown, audits, taken } = await steeredAtAStep((tools) => pi.chat({ tools }), pi.messages());
    expect(shown).toEqual(SAID_STEERED);
    expect(answer).toBe('moved 5 from account 1 to account 2\nthe books are fine');
    expect(audits).toBe(1);
    expect(taken).toEqual(['steer-1']);
  });

  it('submits no message as a round that ends the run ends: pi would answer it in a run of its own', async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    // A tool of pi's own that ends the run, while a message waits.
    const transfer = defineTool({
      name: 'transfer',
      description: 'Move money, and end the run.',
      parameters: Type.Object({ from: Type.Number(), to: Type.Number(), amount: Type.Number() }),
      execute: async () => {
        following.steering = [{ id: 'steer-1', text: 'audit the books' }];
        return { output: [{ type: 'text' as const, text: 'moved' }], control: { terminate: true } };
      },
    });
    const sql = sqlAttempt({ map, key: 'ending', id: 'inv1' });
    const answer = await sql.end(() => handlerOf(pi.chat({ tools: [transfer] }))(sql.ctx, 'Please move 5 from 1 to 2'));
    expect(answer).toBe('On it.');
    // Not taken: the message waits for the turn's end, then its own turn (`steered`) answers it.
    expect(following.taken).toEqual([]);
    const read = sqlAttempt({ map, key: 'ending', id: 'read', shared: true });
    const { messages } = await read.end(() => pi.messages()(read.view, {}));
    const texts = messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])));
    expect(texts).not.toContain('audit the books');
  });

  it('retries a turn that failed after it placed the message with the message, once', async () => {
    const {
      answer,
      failed,
      said: shown,
      audits,
      taken,
    } = await steeredAtAStep((tools) => pi.chat({ tools }), pi.messages(), {
      failAudit: true,
    });
    expect(failed).toBeInstanceOf(Error);
    expect(shown).toEqual(SAID_STEERED);
    expect(answer).toBe('moved 5 from account 1 to account 2\nthe books are fine');
    expect(audits).toBe(2);
    expect(taken).toEqual(['steer-1']);
  });
});
