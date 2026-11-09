// The agent's handler without a Restate server, through crashes of the
// handler (see ../testing.ts): the runner gets no chance to save anything on
// the way out of a crashed attempt. `pnpm --filter @restatedev/agents test claude`. Its client is the teller's (../fakes/claude.ts).
import * as restate from '@restatedev/sessions';
import { describe, expect, it, vi } from 'vitest';
import { CANCELLED, REFUSED, tool, UNANSWERED } from '@restatedev/agents';
import { invoke } from '@restatedev/sessions/internal';
import { fakeContext, type Made } from '@restatedev/sessions/test/support';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { AttemptEnded, ENDED } from '../src/common.ts';
import { SUMMARY } from '../src/conversation.ts';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
import {
  afterCancel,
  cancelledTransfer,
  cancelledWhileWorking,
  endedWhileWorking,
  invalidArguments,
  followedWhileWorking,
  conversation,
  crashedAnywhere,
  followingOf,
  SAID_IN_TURNS as SAID,
  handlerOf,
  type PromptHandler,
  sqlAttempt,
  steeredAtAStep,
  withoutIds,
} from './support.ts';
import { HttpError, reply as tellerReply, teller } from './fakes/claude.ts';
import * as claude from '@restatedev/agents/claude';
import { bank } from './bank.ts';
import { prompt } from './claude.ts';

vi.mock('@anthropic-ai/sdk', () => import('./fakes/claude.ts'));

/** A handler that prompts twice, with the bank's tools. */
const twice = async (ctx: restate.SessionContext) =>
  JSON.stringify([
    await claude.prompt(ctx, 'Please move 5 from 1 to 2', { tools: bank('ClaudeAgent') }),
    await claude.prompt(ctx, 'Hello', { tools: bank('ClaudeAgent') }),
  ]);

describe('the Claude agent', () => {
  it('answers arguments that do not fit a tool with what is wrong, for the model to fix', async () => {
    const { answer, ran } = await invalidArguments((tools) => claude.chat({ tools }));
    expect(answer).toMatch(/error/i);
    expect(answer).toMatch(/amount/);
    expect(ran).toBe(false);
  });

  it('ends a turn cancelled at any moment as one cancelled while a tool waits', async () => {
    const now = await cancelledWhileWorking((tools) => claude.chat({ tools }), claude.messages());
    const waiting = await afterCancel(claude.chat({ tools: [cancelledTransfer] }), claude.messages());
    expect(now.failed).toBeInstanceOf(restate.CancelledError);
    expect(now.answer).toBe(waiting.answer);
    expect(withoutIds(now.parts)).toEqual(withoutIds(waiting.parts));
  });

  it('stops a turn whose attempt ended, and the next attempt goes on with it', async () => {
    const { failed, closed, answer } = await endedWhileWorking((tools) => claude.chat({ tools }));
    // Stopped, not cancelled: the turn is not closed, and the retry answers it.
    expect(failed).toBeInstanceOf(AttemptEnded);
    expect(closed).toEqual([]);
    expect(answer).toBe('Done: moved 5 from account 1 to account 2');
  });

  it('publishes the conversation as a turn and its tool calls start and end', async () => {
    const { answer, published, outputs } = await followedWhileWorking(
      (tools) => claude.chat({ tools }),
      claude.messages(),
    );
    expect(answer).toBe('Done: moved 5 from account 1 to account 2');
    // A follower reads the call as it starts, and its output as it ends.
    expect(outputs).toEqual([undefined, 'moved 5 from account 1 to account 2']);
    // Published at its start, as its tool call starts and ends, and at its end.
    expect(published).toBe(4);
  });

  it('ends a cancelled turn, and answers the next message afresh', async () => {
    const { failed, answer, parts } = await afterCancel(claude.chat({ tools: [cancelledTransfer] }), claude.messages());
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(answer).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    expect(parts).toEqual([
      [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
      [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool',
          id: expect.stringMatching(/^toolu_/),
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

  it('gives the conversation while it answers: the tool calls made so far', async () => {
    const map = new Map<string, Uint8Array>();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: async () => {
        started.resolve();
        await gate.promise;
        return 'moved 5 from account 1 to account 2';
      },
    });
    const owner = sqlAttempt({ map, key: 'mid', id: 'inv1' });
    const answer = owner.end(() =>
      handlerOf(claude.chat({ tools: [transfer] }))(owner.ctx, 'Please move 5 from 1 to 2'),
    );
    await started.promise;
    const reader = sqlAttempt({ map, key: 'mid', id: 'read', shared: true });
    const page = await reader.end(() => claude.messages()(reader.view, {}));
    expect(page.messages.map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
      [
        { type: 'text', text: 'On it.' },
        { type: 'tool', id: expect.stringMatching(/^toolu_/), name: 'transfer', input: { from: 1, to: 2, amount: 5 } },
      ],
    ]);
    gate.resolve();
    expect(await answer).toBe('Done: moved 5 from account 1 to account 2');
  });

  it('answers a message once after a crash at any of its state requests', async () => {
    expect(await crashedAnywhere(prompt, claude.messages())).toEqual([]);
  }, 600_000);

  it('tells the model a tool it does not have is not there', async () => {
    // The teller audits with a tool `audit`, which this agent lacks.
    const c = conversation(claude.chat(), 'unknown');
    expect(await c.attempt('inv1', 'audit the books')).toMatch(/^Done: .*audit/s);
  });

  it('gives the conversation: what was said, in order, with the tool calls', async () => {
    const c = conversation(prompt, 'm');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'audit the books');
    expect(await c.read(claude.messages())).toEqual({ messages: SAID, more: false, cursor: expect.any(Number) });
  });

  it('gives the conversation a page at a time', async () => {
    const c = conversation(prompt, 'p');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'audit the books');
    // The latest, then older ones before the oldest so far.
    expect(await c.read(claude.messages(), { limit: 2 })).toEqual({
      messages: SAID.slice(4),
      more: true,
      cursor: expect.any(Number),
    });
    expect(await c.read(claude.messages(), { limit: 3, before: SAID[4]!.id })).toEqual({
      messages: SAID.slice(1, 4),
      more: true,
      cursor: expect.any(Number),
    });
    expect(await c.read(claude.messages(), { before: SAID[1]!.id })).toEqual({
      messages: SAID.slice(0, 1),
      more: false,
      cursor: expect.any(Number),
    });
    // What is new or changed since a cursor, a page at a time, then nothing more.
    const first = await c.read(claude.messages(), { cursor: 0, limit: 4 });
    expect(first.more).toBe(true);
    const rest = await c.read(claude.messages(), { cursor: first.cursor });
    expect(rest.more).toBe(false);
    const latest = new Map([...first.messages, ...rest.messages].map((m) => [m.id, m]));
    expect([...latest.values()].toSorted((a, b) => a.id - b.id)).toEqual(SAID);
    expect(await c.read(claude.messages(), { cursor: rest.cursor })).toEqual({
      messages: [],
      more: false,
      cursor: rest.cursor,
    });
  });

  it('answers a message once per invocation', async () => {
    const c = conversation(prompt, 'a');
    const first = await c.attempt('inv1', 'Please move 5 from 1 to 2');
    expect(first).toBe('Done: moved 5 from account 1 to account 2');
    // Its attempt retried: the same answer, no new transfer.
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toEqual(first);
    expect(c.ledger.calls).toHaveLength(1);
    expect([...c.ledger.transfers.keys()]).toEqual([expect.stringMatching(/^ClaudeAgent\/a\/toolu_/)]);
    // The next prompt goes on in the same thread.
    const audit = await c.attempt('inv3', 'audit the books');
    expect(audit).toMatch(/^Done: .*"transfers":1/);
  });

  it('answers each prompt of an invocation, and each once', async () => {
    const c = conversation(twice, 't');
    const both = JSON.stringify([
      'Done: moved 5 from account 1 to account 2',
      'Ask me to "move 5 from 1 to 2", or to "audit" the books.',
    ]);
    expect(await c.attempt('inv1', '')).toBe(both);
    expect(await c.attempt('inv1', '')).toBe(both);
    expect(c.ledger.calls).toHaveLength(1);
  });

  it('asks the model for the effort it is given', async () => {
    const requests: unknown[] = [];
    const reply = teller.reply;
    teller.reply = (messages, request) => {
      requests.push(request?.output_config);
      return reply(messages);
    };
    try {
      await conversation(claude.chat({ tools: bank('ClaudeAgent'), effort: 'medium' }), 'e').attempt('inv1', 'Hello');
      await conversation(prompt, 'f').attempt('inv2', 'Hello');
    } finally {
      teller.reply = reply;
    }
    expect(requests).toEqual([{ effort: 'medium' }, undefined]);
  });

  it('resumes a crashed attempt from its last step, with the same tool call', async () => {
    const c = conversation(prompt, 'b');
    const calls = { model: 0 };
    const reply = teller.reply;
    teller.reply = (messages) => {
      calls.model++;
      return reply(messages);
    };
    try {
      const input = 'Please move 7 from 3 to 4';
      await c.crash('inv1', input);
      expect(calls.model).toBe(1);
      // The retried attempt runs the tool again, not the model.
      expect(await c.attempt('inv1', input)).toBe('Done: moved 7 from account 3 to account 4');
      expect(calls.model).toBe(2); // the answer after the tool
    } finally {
      teller.reply = reply;
    }
    // The same transfer id and idempotency key both times: the money moved once.
    const id = c.ledger.calls[0]!.id.split('/').at(-1)!;
    expect(id).toMatch(/^toolu_/);
    expect(c.ledger.calls).toEqual([
      { name: 'transfer', id: `ClaudeAgent/b/${id}`, key: `inv1:${id}` },
      { name: 'transfer', id: `ClaudeAgent/b/${id}`, key: `inv1:${id}` },
    ]);
    expect(c.ledger.transfers.size).toBe(1);
  });

  it("fails the attempt on a tool's error, rather than hand it to the model", async () => {
    const c = conversation(prompt, 'd');
    c.ledger.failNext = 1;
    const input = 'Please move 3 from 5 to 6';
    const failed = await c.attempt('inv1', input).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toMatch('crash after the transfer');
    // Not terminal: Restate retries the attempt.
    expect(failed).not.toBeInstanceOf(restate.TerminalError);
    expect(await c.attempt('inv1', input)).toBe('Done: moved 3 from account 5 to account 6');
    expect(c.ledger.transfers.size).toBe(1);
  });

  it('fails the attempt on a failed model request, and the retry goes on', async () => {
    const c = conversation(prompt, 'e');
    const reply = teller.reply;
    teller.reply = () => {
      teller.reply = reply;
      throw new HttpError(529, 'overloaded_error', 'Overloaded');
    };
    const input = 'Please move 4 from 6 to 7';
    try {
      const failed = await c.attempt('inv1', input).catch((error: unknown) => error);
      // The model's own error, not a terminal one: the attempt is retried.
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toMatch(/^529 .*Overloaded/);
      expect(failed).not.toBeInstanceOf(restate.TerminalError);
    } finally {
      teller.reply = reply;
    }
    expect(await c.attempt('inv1', input)).toBe('Done: moved 4 from account 6 to account 7');
    expect(c.ledger.transfers.size).toBe(1);
  });

  it('ends a prompt whose reply was cut off at maxTokens, its tool calls not run', async () => {
    const c = conversation(claude.chat({ tools: bank('ClaudeAgent'), maxTokens: 100 }), 'cut');
    const reply = teller.reply;
    teller.reply = (messages) => ({ ...reply(messages), stop_reason: 'max_tokens' });
    let failed: unknown;
    try {
      failed = await c.attempt('inv1', 'Please move 5 from 1 to 2').catch((error: unknown) => error);
    } finally {
      teller.reply = reply;
    }
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect((failed as Error).message).toMatch(/maxTokens \(100\)/);
    expect(c.ledger.calls).toEqual([]);
    // The next message is answered, not the one cut off again.
    expect(await c.attempt('inv2', 'Hello')).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    expect(c.ledger.calls).toEqual([]);
  });

  it("goes on from a reply the API paused (a server tool's long turn), in the same turn", async () => {
    const c = conversation(prompt, 'paused');
    const reply = teller.reply;
    const asked: MessageParam[][] = [];
    teller.reply = (messages) => {
      asked.push(messages);
      const [text, stop] = asked.length === 1 ? ['Searching...', 'pause_turn'] : ['Found it.', 'end_turn'];
      return { ...reply(messages), content: [{ type: 'text', text }], stop_reason: stop } as never;
    };
    let answer: string;
    try {
      answer = await c.attempt('inv1', 'Hello');
    } finally {
      teller.reply = reply;
    }
    expect(answer).toBe('Found it.');
    // Asked again with the paused reply, to go on from.
    expect(asked).toHaveLength(2);
    expect(asked[1]!.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Searching...' }] });
  });

  it('sends a reply of the model with nothing in it back as one that says so: the API refuses it empty', async () => {
    const c = conversation(prompt, 'empty');
    const reply = teller.reply;
    teller.reply = (messages) => {
      // As the API: only the last message may be empty.
      const empty = messages
        .slice(0, -1)
        .some((m) => (typeof m.content === 'string' ? !m.content.trim() : m.content.length === 0));
      if (empty) throw new HttpError(400, 'invalid_request_error', 'all messages must have non-empty content');
      return messages.length === 1 ? { ...reply(messages), content: [] } : reply(messages);
    };
    const answers: string[] = [];
    try {
      answers.push(await c.attempt('inv1', 'Hello'), await c.attempt('inv2', 'Hello again'));
    } finally {
      teller.reply = reply;
    }
    expect(answers).toEqual(['', 'Ask me to "move 5 from 1 to 2", or to "audit" the books.']);
  });

  it('ends a prompt the provider refused, and answers the next message afresh', async () => {
    const c = conversation(prompt, 'refused');
    const reply = teller.reply;
    teller.reply = () => {
      teller.reply = reply;
      throw new HttpError(401, 'authentication_error', 'invalid x-api-key');
    };
    await expect(c.attempt('inv1', 'Please move 5 from 1 to 2')).rejects.toMatchObject({ code: REFUSED });
    // Retried (a crash after its end was stored), it fails again, rather than answer.
    await expect(c.attempt('inv1', 'Please move 5 from 1 to 2')).rejects.toMatchObject({ code: REFUSED });
    expect(await c.attempt('inv2', 'Hello')).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    expect(c.ledger.calls).toEqual([]);
    const { messages } = await c.read(claude.messages());
    expect(messages[1]!.parts).toEqual([{ type: 'text', text: UNANSWERED }]);
  });

  it('closes a turn its gone invocation left, by the next message: never finishes it', async () => {
    const c = conversation(prompt, 'c');
    const asked: MessageParam[][] = [];
    const reply = teller.reply;
    teller.reply = (messages) => {
      asked.push(messages);
      return reply(messages);
    };
    try {
      // Killed in its transfer: its invocation is gone, and the next message comes.
      await c.crash('inv1', 'Please move 1 from 0 to 1');
      asked.length = 0;
      const second = await c.attempt('inv2', 'Please move 2 from 0 to 1');
      expect(second).toBe('Done: moved 2 from account 0 to account 1');
    } finally {
      teller.reply = reply;
    }
    // The model was asked for the second message only, and saw how the first ended.
    expect(asked).toHaveLength(2);
    expect(JSON.stringify(asked[0])).toContain(ENDED);
    // The first's transfer was not made again; its call has the note as its result.
    expect(c.ledger.transfers.size).toBe(2);
    const { messages } = await c.read(claude.messages());
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages[2]!.parts).toEqual([{ type: 'text', text: ENDED }]);
    // Its invocation, should it come again, fails with the note.
    await expect(c.attempt('inv1', 'Please move 1 from 0 to 1')).rejects.toThrow(ENDED);
    expect(c.ledger.transfers.size).toBe(2);
  });

  it("closes a turn its gone invocation left on its companion's `settle`", async () => {
    const c = conversation(prompt, 'settled');
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    const agent = claude.agent({ name: 'ClaudeAgent', tools: bank('ClaudeAgent') });
    const map = c.state as Map<string, Uint8Array>;
    const settle = (id: string) =>
      invoke(agent, 'settle', fakeContext({ map, service: 'ClaudeAgent', key: 'settled', id: `inv_s${id}` }), 'inv1');
    expect(await settle('1')).toBe(true);
    expect(await settle('2')).toBe(false);
    const { messages } = await c.read(claude.messages());
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: ENDED }]);
  });

  it('answers a stored final reply without asking the model again', async () => {
    const reply = teller.reply;
    let requests = 0;
    teller.reply = (messages) => {
      requests++;
      return reply(messages);
    };
    let stored = 0;
    try {
      // Crashed at each state request in turn: once the final reply is stored, the retry does not ask for it again.
      for (let at = 1; ; at++) {
        const c = conversation(prompt, `final-${at}`);
        requests = 0;
        if ((await c.attempt('inv1', 'Hello', at)) !== 'crashed') break;
        const replied = (await c.read(claude.messages())).messages.length > 1;
        const asked = requests;
        expect(await c.attempt('inv1', 'Hello')).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
        if (replied) stored++;
        expect(requests - asked).toBe(replied ? 0 : 1);
      }
    } finally {
      teller.reply = reply;
    }
    // Some crash came after the reply was stored, and before the turn's answer.
    expect(stored).toBeGreaterThan(0);
  });

  it('gives the model earlier turns as their prompt and answer only', async () => {
    const c = conversation(prompt, 'earlier');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'Hello');
    const reply = teller.reply;
    const asked: MessageParam[][] = [];
    teller.reply = (messages) => {
      asked.push(messages);
      return reply(messages);
    };
    try {
      await c.attempt('inv3', 'Hello again');
    } finally {
      teller.reply = reply;
    }
    // The first turn, out of the window: its prompt and answer, without its tool call.
    expect(asked[0]).toEqual([
      { role: 'user', content: 'Please move 5 from 1 to 2' },
      { role: 'assistant', content: 'Done: moved 5 from account 1 to account 2' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Ask me to "move 5 from 1 to 2", or to "audit" the books.' }],
      },
      { role: 'user', content: 'Hello again' },
    ]);
  });

  it('summarizes a long conversation rather than refuse it', async () => {
    const reply = teller.reply;
    const summaries: string[] = [];
    teller.reply = (messages) => {
      const first = messages[0]!.content;
      if (typeof first === 'string' && first.startsWith('Summarize the conversation')) {
        summaries.push(first);
        return {
          ...reply([{ role: 'user', content: 'hi' }]),
          content: [{ type: 'text', text: 'they chatted', citations: null }],
        };
      }
      return reply(messages);
    };
    const agent = claude.agent({ name: 'ClaudeAgent', tools: bank('ClaudeAgent'), budget: 20 });
    const map = new Map<string, Uint8Array>();
    const sends: Made[] = [];
    let n = 0;
    const run = (handler: string, input?: unknown) =>
      invoke(agent, handler, fakeContext({ map, service: 'ClaudeAgent', key: 'long', id: `inv_${++n}`, sends }), input);
    try {
      for (let i = 0; i < 5; i++) await run('chat', `Hello ${i}`);
      // The turns before the window outgrew the budget: the agent was sent `compact`, which summarizes them.
      expect(sends.some((s) => s.method === 'compact')).toBe(true);
      expect(await run('compact')).toBe(true);
      expect(summaries[0]).toContain('User: Hello 0');
      const asked: MessageParam[][] = [];
      const summarizing = teller.reply;
      teller.reply = (messages) => {
        asked.push(messages);
        return summarizing(messages);
      };
      await run('chat', 'Hello 5');
      expect(asked[0]![0]).toEqual({ role: 'user', content: `${SUMMARY}they chatted` });
    } finally {
      teller.reply = reply;
    }
  });

  it("hands the SDK's ToolError to the model, rather than fail the attempt", async () => {
    const strict = {
      type: 'custom' as const,
      name: 'transfer',
      description: 'Move money.',
      input_schema: { type: 'object' as const, properties: {} },
      parse: (args: unknown) => args,
      run: () => {
        throw new ToolError('the bank is closed');
      },
    };
    const c = conversation(claude.chat({ tools: [strict] }), 'tool-error');
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe('Done: the bank is closed');
  });
});

const Plan = z.object({ summary: z.string(), parts: z.array(z.string()) });
const PLAN = { summary: 'A calculator', parts: ['parser', 'history'] };
type Message = ReturnType<typeof teller.reply>;
type Request = { system?: string; messages: MessageParam[]; output_config?: Record<string, unknown> };

/** The teller's reply to `messages`, saying `text`. */
const say = (messages: MessageParam[], text: string): Message => ({
  ...tellerReply(messages),
  content: [{ type: 'text', text, citations: null }],
  stop_reason: 'end_turn',
});

/** A summary of a calculator too long for `Short`. */
const Short = z.object({ summary: z.string().max(10) });
const long = (messages: MessageParam[]) => say(messages, JSON.stringify({ summary: 'A calculator, at length' }));

/** The requests of a prompt of `options` to the teller, whose replies `replies` gives, and its answer or error. */
async function prompted(
  key: string,
  options: claude.Options,
  replies: (messages: MessageParam[], said: string) => Message,
  text = 'Plan it',
) {
  const reply = teller.reply;
  const requests: Request[] = [];
  teller.reply = (messages, request) => {
    requests.push(request as Request);
    const last = messages.at(-1)!.content;
    return replies(messages, typeof last === 'string' ? last : '');
  };
  try {
    const chat = claude.chat(options) as unknown as PromptHandler;
    const answer = await conversation(chat, key)
      .attempt('inv1', text)
      .catch((error: unknown) => error);
    return { answer, requests };
  } finally {
    teller.reply = reply;
  }
}

/** How an agent of `options` asks for the plan: natively, or in the system prompt and the prompt. */
async function howAsked(options: claude.Options) {
  const key = `${options.model}-${options.nativeOutput}`;
  const { answer, requests } = await prompted(key, { output: Plan, ...options }, (messages) =>
    say(messages, JSON.stringify(PLAN)),
  );
  const [request] = requests;
  return {
    answer,
    natively: request!.output_config?.format !== undefined,
    system: request!.system,
    prompt: request!.messages[0]!.content,
  };
}

const NATIVELY = { answer: PLAN, natively: true, system: undefined, prompt: 'Plan it' };
const IN_THE_PROMPT = {
  answer: PLAN,
  natively: false,
  // The system prompt asks for it, with the schema, and the prompt is reminded of it.
  system: expect.stringMatching(/^Your final reply is your answer, as JSON only .*\n\{"\$schema"/),
  prompt: expect.stringMatching(/^Plan it\n\nWhen you are done, reply with your answer as JSON/),
};

describe("the Claude agent's output", () => {
  it('is asked for natively: its JSON schema on each request, with tool calls, and nothing in the prompt', async () => {
    // A tool call, then the plan once the tool answered.
    const { answer, requests } = await prompted(
      'native',
      { system: 'Plan briefly.', tools: bank('ClaudeAgent'), effort: 'low', output: Plan },
      (messages) => {
        const made = tellerReply(messages);
        return made.content.some((c) => c.type === 'tool_use') ? made : say(messages, JSON.stringify(PLAN));
      },
      'Please move 5 from 1 to 2',
    );
    expect(answer).toEqual(PLAN);
    const format = {
      type: 'json_schema',
      schema: expect.objectContaining({
        type: 'object',
        properties: { summary: { type: 'string' }, parts: { type: 'array', items: { type: 'string' } } },
        required: ['summary', 'parts'],
        additionalProperties: false,
      }),
    };
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.output_config).toEqual({ effort: 'low', format });
      // The system prompt and the prompt as they are: the API holds the reply to the schema.
      expect(request.system).toBe('Plan briefly.');
      expect(request.messages[0]).toEqual({ role: 'user', content: 'Please move 5 from 1 to 2' });
    }
  });

  it('is asked for natively by the models with structured outputs, and in the prompt by the others', async () => {
    const natively = [
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-5-5',
      'claude-opus-4-8',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-mythos-preview',
    ];
    const inThePrompt = [
      'claude-3-7-sonnet-latest',
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
      'claude-sonnet-4-0',
      'a-gateway-model',
    ];
    for (const model of natively) {
      expect([model, await howAsked({ model: `anthropic/${model}` })]).toEqual([model, NATIVELY]);
    }
    for (const model of inThePrompt) {
      expect([model, await howAsked({ model: `anthropic/${model}` })]).toEqual([model, IN_THE_PROMPT]);
    }
    // `nativeOutput` decides, whatever the model.
    expect(await howAsked({ nativeOutput: false })).toEqual(IN_THE_PROMPT);
    expect(await howAsked({ model: 'anthropic/a-gateway-model', nativeOutput: true })).toEqual(NATIVELY);
  });

  it('is asked for again, natively, if the reply does not fit what the API cannot hold it to; then the turn fails', async () => {
    // A string's maxLength is not the API's to keep: the SDK puts it in the description, and the check asks again.
    const fixed = await prompted('again', { output: Short }, (messages, said) =>
      said.startsWith('Your reply is not') ? say(messages, JSON.stringify({ summary: 'Calculator' })) : long(messages),
    );
    expect(fixed.answer).toEqual({ summary: 'Calculator' });
    expect(fixed.requests).toHaveLength(2);
    for (const request of fixed.requests) {
      expect(request.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: expect.objectContaining({
            properties: { summary: { type: 'string', description: '{maxLength: 10}' } },
          }),
        },
      });
    }
    expect(fixed.requests[1]!.messages.at(-1)!.content).toMatch(
      /^Your reply is not the answer asked for: .*<=10 characters/,
    );
    // Asked again, a reply that still does not fit fails the turn.
    const failed = await prompted('again-failed', { output: Short }, long);
    expect(failed.answer).toBeInstanceOf(restate.TerminalError);
    expect((failed.answer as Error).message).toMatch(/^The agent's reply is not the answer asked for: /);
    expect(failed.requests).toHaveLength(2);
  });

  it('ends a turn the model declined, natively asked, without asking again', async () => {
    const { answer, requests } = await prompted('declined', { output: Plan }, (messages) => ({
      ...say(messages, 'I cannot help with that.'),
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        explanation: null,
        fallback_credit_token: null,
        fallback_has_prefill_claim: null,
        recommended_model: null,
      },
    }));
    expect(answer).toBeInstanceOf(restate.TerminalError);
    expect((answer as Error).message).toBe('the model declined to answer (cyber)');
    expect(requests).toHaveLength(1);
  });
});

describe('the Claude agent, steered', () => {
  it('takes a message steered while a tool runs at its next step: the next request ends with it', async () => {
    const { answer, said, audits, taken } = await steeredAtAStep((tools) => claude.chat({ tools }), claude.messages());
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
      (tools) => claude.chat({ tools }),
      claude.messages(),
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

  it('takes a message steered before its first request in that request', async () => {
    const c = conversation(prompt, 'early');
    followingOf(c.state).steering = [{ id: 'early', text: 'audit the books' }];
    const asked: MessageParam[][] = [];
    const reply = teller.reply;
    teller.reply = (messages, request) => {
      asked.push(structuredClone(messages));
      return reply(messages, request);
    };
    let answer: unknown;
    try {
      answer = await c.attempt('inv1', 'Hello');
    } finally {
      teller.reply = reply;
    }
    expect(asked[0]).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'audit the books' },
    ]);
    expect(answer).toMatch(/^Done: /);
    expect(followingOf(c.state).taken).toEqual([['early']]);
  });

  it('takes no message after a paused reply, which goes back as the last message', async () => {
    const c = conversation(prompt, 'paused-steer');
    const reply = teller.reply;
    const asked: MessageParam[][] = [];
    teller.reply = (messages) => {
      asked.push(structuredClone(messages));
      // The attempt fails once the paused reply is stored: the retry goes on from it.
      if (asked.length === 2) throw new Error('the connection dropped');
      const [text, stop] = asked.length === 1 ? ['Searching...', 'pause_turn'] : ['Found it.', 'end_turn'];
      return { ...reply(messages), content: [{ type: 'text', text }], stop_reason: stop } as never;
    };
    let answer: unknown;
    try {
      await expect(c.attempt('inv1', 'Hello')).rejects.toThrow(/connection/i);
      // Listed to the retried attempt as it starts, with the paused reply last in the turn.
      followingOf(c.state).steering = [{ id: 'late', text: 'audit the books' }];
      answer = await c.attempt('inv1', 'Hello');
    } finally {
      teller.reply = reply;
    }
    expect(answer).toBe('Found it.');
    expect(asked[2]!.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Searching...' }] });
    expect(followingOf(c.state).taken).toEqual([]);
  });

  it("puts the message after the tools' results, in a request the API takes, and every request after it keeps it", async () => {
    const requests: MessageParam[][] = [];
    const reply = teller.reply;
    teller.reply = (messages, request) => {
      requests.push(structuredClone(messages));
      return reply(messages, request);
    };
    try {
      await steeredAtAStep((tools) => claude.chat({ tools }), claude.messages());
    } finally {
      teller.reply = reply;
    }
    const steered = (messages: MessageParam[]) => messages.filter((m) => m.content === 'audit the books').length;
    expect(requests.map(steered)).toEqual([0, 1, 1]);
    // After the transfer's result: the request's last two messages.
    const [result, said] = requests[1]!.slice(-2);
    expect(Array.isArray(result!.content) && result!.content[0]!.type).toBe('tool_result');
    expect(said).toEqual({ role: 'user', content: 'audit the books' });
  });
});
