// The bank agent on pi (./pi.ts) without a Restate server, through crashes of
// the handler (see ../testing.ts). Its model is the teller (../fakes/pi.ts).
// `pnpm --filter @restatedev/agents test pi`.
import { describe, expect, it, vi } from 'vitest';
import { ENDED } from '../src/common.ts';
import { conversation, crashedAnywhere, handlerOf, SAID_IN_TURNS as SAID } from './support.ts';
import type * as restate from '@restatedev/sessions';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import * as pi from '@restatedev/agents/pi';
import { prompt, tools } from './pi.ts';

// The default model's provider, OpenAI's, is the teller.
vi.mock('@earendil-works/pi-ai/providers/all', async () => {
  const { fakeProvider, teller } = await import('./fakes/pi.ts');
  return { builtinProviders: () => [fakeProvider('openai', 'gpt-6-sol', teller)] };
});

/** The bank agent, but for the message `idle`: then it waits for pi to be idle, and prompts nothing. */
const idling = async (ctx: restate.SessionContext, message: string) =>
  message === 'idle'
    ? pi.withPi(ctx, { tools: tools(ctx) }, async (session) => {
        await (await session.conversation()).waitForIdle(session.context);
        return 'idle';
      })
    : handlerOf(prompt)(ctx, message);

/** A note for pi's conversation: a user's message, which pi queues while a run is busy. */
const NOTE = { kind: 'test.note', model: [{ role: 'user' as const, content: 'A note', timestamp: 0 }] };

/**
 * The bank agent, whose transfer first writes {@link NOTE} to pi's
 * conversation: the run is busy, so pi queues it until the run's next step,
 * as it does a compaction's.
 */
const noting = (ctx: restate.SessionContext, message: string) => {
  const [transfer, audit] = tools(ctx);
  let session: pi.Pi | undefined;
  const noted: ToolRegistration = {
    ...transfer,
    execute: async (args, api, task) => {
      const root = await session!.conversation();
      await root.submit({ type: 'write', requestId: 'compaction:t1', entry: NOTE }, session!.context);
      return transfer.execute(args, api, task);
    },
  };
  return pi.withPi(ctx, { tools: [noted, audit] }, async (opened) => {
    session = opened;
    return opened.prompt(message);
  });
};

/** The bank agent, after making a table of yours named as one of pi-durable's. */
const besideYours = async (ctx: restate.SessionContext, message: string) => {
  await ctx.db.execute('CREATE TABLE IF NOT EXISTS tasks (task TEXT)');
  return handlerOf(prompt)(ctx, message);
};

describe('the bank agent on pi', () => {
  it('answers a message once after a crash at any of its state requests', async () => {
    // One at a time: pi-ai's faux provider answers from one queue.
    expect(await crashedAnywhere(prompt, pi.messages(), { concurrency: 1 })).toEqual([]);
  }, 600_000);

  it('runs a tool call again however often a crash cuts it off', async () => {
    // pi-durable parks a task cut off 5 times in a row by default: Restate's retries decide here.
    const c = conversation(prompt, 'restarts');
    for (let crash = 0; crash < 8; crash++) await c.crash('inv1', 'Please move 5 from 1 to 2');
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toMatch(/^Done: moved 5/);
    expect(c.ledger.transfers.size).toBe(1);
  }, 120_000);

  it('tells the model a tool it does not have is not there', async () => {
    // The teller audits with a tool `audit`, which this agent lacks.
    const c = conversation(pi.chat(), 'unknown');
    expect(await c.attempt('inv1', 'audit the books')).toMatch(/^Done: .*audit/s);
  });

  it('keeps its tables apart from yours: each is restate_pi_<name>', async () => {
    const c = conversation(besideYours, 'tables');
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toMatch(/^Done: /);
    const names = await c.read(async (ctx) =>
      (await ctx.db.values("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")).map(([name]) => name),
    );
    expect(names.filter((name) => !String(name).startsWith('restate_'))).toEqual(['tasks']);
  });

  it('gives the conversation: what was said, in order, with the tool calls', async () => {
    const c = conversation(prompt, 'm');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'audit the books');
    expect(await c.read(pi.messages(), {})).toEqual({ messages: SAID, more: false, cursor: expect.any(Number) });
  });

  it('closes a turn its gone invocation left, by the next message: aborts its run, never finishes it', async () => {
    const c = conversation(prompt, 'dead');
    // Killed in its transfer: its invocation is gone, and the next message comes.
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    expect(await c.attempt('inv2', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
    // The dead run's transfer was not made again under the new invocation.
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1', 'inv2']);
    const { messages } = await c.read(pi.messages());
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages[2]!.parts).toEqual([{ type: 'text', text: ENDED }]);
    expect(messages[3]!.parts).toEqual([{ type: 'text', text: 'Please move 2 from 0 to 1' }]);
    await expect(c.attempt('inv1', 'Please move 1 from 0 to 1')).rejects.toThrow(ENDED);
  });

  it("goes on with its own run after a crash, beside a write of pi's that waits for it", async () => {
    const c = conversation(noting, 'noted');
    await c.crash('inv1', 'Please move 5 from 1 to 2');
    // Answered, not aborted (the model's last read is pi's note): its transfer made once, its result the turn's.
    expect(typeof (await c.attempt('inv1', 'Please move 5 from 1 to 2'))).toBe('string');
    expect(c.ledger.transfers.size).toBe(1);
    const { messages } = await c.read(pi.messages());
    expect(messages[1]!.parts.at(-1)).toMatchObject({ type: 'tool', output: 'moved 5 from account 1 to account 2' });
  });

  it("aborts a gone invocation's run whatever the next handler does with pi, not only a prompt", async () => {
    const c = conversation(idling, 'idle');
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    expect(await c.attempt('inv2', 'idle')).toBe('idle');
    // The dead run's transfer was not made again under the new invocation.
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1']);
    expect(await c.attempt('inv3', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1', 'inv3']);
  });
});
