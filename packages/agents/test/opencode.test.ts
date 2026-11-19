// The OpenCode agent without a Restate server, through crashes and kills of
// the handler (see ./support.ts): a crashed attempt gets no chance to store
// anything on the way out. Its model is the teller of ./fakes/opencode.ts,
// given to every boot of OpenCode (the mock below).
//
// OpenCode needs Node 24 (its sources use syntax Node 22 does not parse): on
// older Node the suite is skipped, and nothing of OpenCode is imported.
// `pnpm --filter @restatedev/agents exec vitest run test/opencode.test.ts`.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from '@ai-sdk/provider';
import * as restate from '@restatedev/sessions';
import { database as databaseOf, invoke } from '@restatedev/sessions/internal';
import { fakeContext } from '@restatedev/sessions/test/support';
import { z } from 'zod';
import { tool } from '@restatedev/agents';
import { callOf } from '../src/calls.ts';
import { CANCELLED, ENDED, REFUSED, RETURNED_UNRECORDED } from '../src/common.ts';
import type * as Db from '../src/opencode/db.ts';
import type * as OpenCode from '../src/opencode/index.ts';
import type * as Fake from './fakes/opencode.ts';
import type * as Bank from './opencode.ts';
import { bank } from './bank.ts';
import {
  afterCancel,
  cancelledTransfer,
  conversation,
  crashedAnywhere,
  followedWhileWorking,
  followingOf,
  handlerOf,
  scopes,
  sqlAttempt,
  steeredAtAStep,
  type PromptHandler,
  SAID_IN_TURNS as SAID,
} from './support.ts';
import { followedRound, THREE_TOOLS } from './following.ts';

const NODE_24 = Number(process.versions.node.split('.')[0]) >= 24;

/**
 * How often OpenCode was booted; `prompted`, if a test sets it, is told of each prompt OpenCode took, as it
 * returns; `transaction`, if a test sets it, runs each of OpenCode's transactions (`run`), and is given the
 * parameters of each statement of it that writes, as it runs; `interrupting`, if a test sets it, is awaited
 * before each interrupt of OpenCode's turn goes to OpenCode.
 */
const boots = vi.hoisted(() => ({
  n: 0,
  prompted: undefined as ((input: { id?: unknown }) => void) | undefined,
  transaction: undefined as ((run: () => Promise<unknown>, writes: unknown[][]) => Promise<unknown>) | undefined,
  interrupting: undefined as (() => Promise<void>) | undefined,
}));

// Every boot of OpenCode has the teller's provider.
vi.mock('@restatedev/agents/opencode/db', async (original) => {
  const db = await original<typeof Db>();
  const { scriptedPlugin } = await import('./fakes/opencode.ts');
  const { Effect } = await import('effect');
  const openOpenCode: typeof db.openOpenCode = async (database, fence, options) => {
    boots.n++;
    // OpenCode's database, whose transactions `boots.transaction` runs.
    const transaction: typeof database.transaction = (body) => {
      const writes: unknown[][] = [];
      const execute = (sql: string, params: unknown[] = []) => {
        if (/^\s*(insert|update|delete|replace)\b/i.test(sql)) writes.push(params);
      };
      const run = () =>
        database.transaction((tx) => {
          const watched = new Proxy(tx, {
            get: (t, key) => {
              const value: unknown = Reflect.get(t, key);
              if (typeof value !== 'function') return value;
              return (sql: string, params?: never) => {
                if (key === 'query' || key === 'values' || key === 'execute' || key === 'get') execute(sql, params);
                return (value as (s: string, p?: unknown) => unknown).call(t, sql, params);
              };
            },
          });
          return body(watched);
        });
      return (boots.transaction ? boots.transaction(run, writes) : run()) as ReturnType<typeof body>;
    };
    const watched = new Proxy(database, {
      get: (t, key) => {
        const value: unknown = Reflect.get(t, key);
        if (key === 'transaction') return transaction;
        return typeof value === 'function' ? (value as () => unknown).bind(t) : value;
      },
    });
    const host = await db.openOpenCode(watched, fence, {
      ...options,
      plugins: [scriptedPlugin, ...(options.plugins ?? [])],
    });
    // `session.prompt`, which tells `boots.prompted` once OpenCode took the prompt.
    const prompt = (input: Parameters<typeof host.client.session.prompt>[0]) =>
      host.client.session.prompt(input).pipe(Effect.tap(() => Effect.sync(() => boots.prompted?.(input))));
    // `session.interrupt`, once `boots.interrupting` lets it.
    const interrupt = (input: Parameters<typeof host.client.session.interrupt>[0]) =>
      Effect.promise(async () => boots.interrupting?.()).pipe(
        Effect.flatMap(() => host.client.session.interrupt(input)),
      );
    const session = new Proxy(host.client.session, {
      get: (target, key, receiver) => {
        if (key === 'prompt') return prompt;
        if (key === 'interrupt') return interrupt;
        return Reflect.get(target, key, receiver);
      },
    });
    const client = new Proxy(host.client, {
      get: (target, key, receiver) => (key === 'session' ? session : Reflect.get(target, key, receiver)),
    });
    return { ...host, client };
  };
  return { ...db, openOpenCode };
});
vi.stubEnv('MODEL', 'scripted/scripted');

// Imported only on Node 24: OpenCode does not load on older Node.
let opencode: typeof OpenCode;
let fake: typeof Fake;
let prompt: typeof Bank.prompt;
beforeAll(async () => {
  if (!NODE_24) return;
  opencode = await import('@restatedev/agents/opencode');
  fake = await import('./fakes/opencode.ts');
  ({ prompt } = await import('./opencode.ts'));
});

beforeEach(() => {
  if (!NODE_24) return;
  fake.script.requests.length = 0;
  fake.script.reply = fake.teller;
  boots.prompted = undefined;
  boots.transaction = undefined;
  boots.interrupting = undefined;
});

/** The texts of the user's messages of the model's latest request, in order. */
const userTexts = () =>
  fake.script.requests
    .at(-1)!
    .prompt.filter((m) => m.role === 'user')
    .map((m) => fake.textOf(m));

/** Whether a request to the model went on with a turn after a restart: OpenCode's "Continue". */
const continued = () =>
  fake.script.requests.some((r) => r.prompt.some((m) => m.role === 'user' && fake.CONTINUE.test(fake.textOf(m))));

describe.skipIf(!NODE_24)('the OpenCode agent', () => {
  it('answers a message once: a retried attempt of an answered prompt boots nothing', async () => {
    const c = conversation(prompt, 'once');
    const first = await c.attempt('inv1', 'Please move 5 from 1 to 2');
    expect(first).toBe('Done: moved 5 from account 1 to account 2');
    const booted = boots.n;
    const asked = fake.script.requests.length;
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe(first);
    expect(boots.n).toBe(booted);
    expect(fake.script.requests.length).toBe(asked);
    expect(c.ledger.transfers.size).toBe(1);
    // The next prompt goes on in the same session.
    expect(await c.attempt('inv2', 'audit the books')).toMatch(/^Done: .*"transfers":1/);
  }, 60_000);

  it('resumes a crashed attempt in its tool call: the transfer is made once', async () => {
    const c = conversation(prompt, 'crash');
    const input = 'Please move 7 from 3 to 4';
    await c.crash('inv1', input);
    // The retried attempt resumes OpenCode's turn: the model retries the interrupted transfer, then answers.
    expect(await c.attempt('inv1', input)).toBe('Done: moved 7 from account 3 to account 4');
    expect(continued()).toBe(true);
    expect(c.ledger.transfers.size).toBe(1);
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'Done: moved 7 from account 3 to account 4' }]);
  }, 60_000);

  it('resumes a turn however many attempts crash: Restate decides', async () => {
    const c = conversation(prompt, 'crashes');
    const input = 'Please move 4 from 2 to 3';
    // More than the ten resumes OpenCode allows a turn by default.
    for (let n = 0; n < 12; n++) await c.crash('inv1', input);
    expect(await c.attempt('inv1', input)).toBe('Done: moved 4 from account 2 to account 3');
    expect(c.ledger.transfers.size).toBe(1);
  }, 120_000);

  it('closes a killed turn by the next message: never finished, the note told to the model', async () => {
    const c = conversation(prompt, 'dead');
    // Killed in its transfer: its invocation is gone, and the next message comes.
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    expect(await c.attempt('inv2', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
    // The dead turn's transfer was not made again under the new invocation.
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1', 'inv2']);
    expect(continued()).toBe(false);
    // The next model request: the note, then the prompt.
    expect(userTexts().at(-1)).toBe(`(${ENDED})\n\nPlease move 2 from 0 to 1`);
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages[2]!.parts).toEqual([{ type: 'text', text: ENDED }]);
    expect(messages[3]!.parts).toEqual([{ type: 'text', text: 'Please move 2 from 0 to 1' }]);
    // The store has the turn ended.
    const statuses = await c.read(async (ctx) => ctx.db.values('SELECT status FROM restate_agent_turns ORDER BY n'));
    expect(statuses).toEqual([['ended'], ['answered']]);
    // Its invocation, should it come again, fails with the note.
    await expect(c.attempt('inv1', 'Please move 1 from 0 to 1')).rejects.toThrow(ENDED);
    expect(c.ledger.transfers.size).toBe(2);
  }, 60_000);

  it('tells the model which calls of a killed turn did happen', async () => {
    // A transfer whose Restate call returned, and whose attempt was killed before OpenCode stored its result.
    const returned = Promise.withResolvers<void>();
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: async (input, { ctx, callId }) => {
        await (await callOf(ctx, 'transfer', input, callId)).answered();
        returned.resolve();
        return new Promise<never>(() => {});
      },
    });
    const chat = handlerOf(opencode.chat({ tools: [transfer] }));
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    const first = sqlAttempt({ map, fence, key: 'happened', id: 'inv1' });
    void first.end(() => chat(first.ctx, 'Please move 5 from 1 to 2')).catch(() => {});
    await returned.promise;
    fence.closed = true;
    first.abort();
    const second = sqlAttempt({ map, key: 'happened', id: 'inv2' });
    expect(await second.end(() => chat(second.ctx, 'Hello'))).toMatch(/^Ask me/);
    const read = sqlAttempt({ map, key: 'happened', id: 'read', shared: true });
    const { messages } = await read.end(() => opencode.messages()(read.view, {}));
    // The store has the call done, its result not recorded.
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: RETURNED_UNRECORDED });
    const id = (messages[1]!.parts[1] as { id: string }).id;
    expect(userTexts().at(-1)).toBe(`(${ENDED} These calls did happen: transfer (${id}).)\n\nHello`);
    expect(continued()).toBe(false);
  }, 60_000);

  it('never runs a prompt killed once OpenCode queued it, before its turn began', async () => {
    const ran: string[] = [];
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: ({ from, to, amount }, { ctx }) => {
        ran.push(`${ctx.request.id}: ${amount}`);
        return `moved ${amount} from account ${from} to account ${to}`;
      },
    });
    const chat = handlerOf(opencode.chat({ tools: [transfer] }));
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    const first = sqlAttempt({ map, fence, key: 'queued', id: 'inv1' });
    // Killed as OpenCode took the prompt: nothing more is stored, the turn's claim neither.
    boots.prompted = () => {
      fence.closed = true;
      first.abort();
    };
    await first.end(() => chat(first.ctx, 'Please move 1 from 0 to 1')).catch(() => {});
    boots.prompted = undefined;
    const asked = fake.script.requests.length;
    const second = sqlAttempt({ map, key: 'queued', id: 'inv2' });
    expect(await second.end(() => chat(second.ctx, 'Please move 2 from 0 to 1'))).toBe(
      'Done: moved 2 from account 0 to account 1',
    );
    // The dead prompt's transfer is never made, by any invocation; the model is asked for the next prompt alone.
    expect(ran).toEqual(['inv2: 2']);
    for (const request of fake.script.requests.slice(asked)) {
      const said = request.prompt.filter((m) => m.role === 'user').map((m) => fake.textOf(m));
      expect(said).toEqual([`(${ENDED})\n\nPlease move 2 from 0 to 1`]);
    }
  }, 60_000);

  it("closes a killed turn on its companion's `settle`: never finished", async () => {
    const c = conversation(prompt, 'settled');
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    const agent = opencode.agent({ name: 'OpenCodeAgent', tools: bank('OpenCodeAgent') });
    const map = c.state as Map<string, Uint8Array>;
    const asked = fake.script.requests.length;
    const settle = (id: string) =>
      invoke(agent, 'settle', fakeContext({ map, service: 'OpenCodeAgent', key: 'settled', id: `inv_s${id}` }), 'inv1');
    expect(await settle('1')).toBe(true);
    expect(await settle('2')).toBe(false);
    // Closed without the model.
    expect(fake.script.requests.length).toBe(asked);
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: ENDED }]);
    const summary = await c.read(opencode.messages(), { view: 'summary' });
    expect(summary.messages.at(-1)!.parts).toEqual([{ type: 'text', text: ENDED }]);
    // The next message is a turn of its own: the dead transfer not made again, the note told.
    expect(await c.attempt('inv2', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
    expect(continued()).toBe(false);
    expect(userTexts().at(-1)).toBe(`(${ENDED})\n\nPlease move 2 from 0 to 1`);
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1', 'inv2']);
  }, 60_000);

  it('closes a stopped turn cancelled, and answers the next message afresh with the note', async () => {
    const { failed, answer, parts } = await afterCancel(
      opencode.chat({ tools: [cancelledTransfer] }),
      opencode.messages(),
    );
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(answer).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    expect(userTexts().at(-1)).toBe(`(${CANCELLED})\n\nHello`);
    expect(continued()).toBe(false);
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
      [{ type: 'text', text: 'Ask me to "move 5 from 1 to 2", or to "audit" the books.' }],
    ]);
  }, 60_000);

  it('fails a prompt its provider refuses with 424, and closes its turn', async () => {
    // A wrong API key: the provider answers 401, which no retry changes.
    fake.script.reply = () => {
      throw new APICallError({
        message: 'Incorrect API key provided',
        url: 'https://scripted.invalid/v1',
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      });
    };
    const c = conversation(prompt, 'refused');
    const failed = await c.attempt('inv1', 'Hello').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect((failed as restate.TerminalError).code).toBe(REFUSED);
    fake.script.reply = fake.teller;
    expect(await c.attempt('inv2', 'Hello')).toMatch(/^Ask me/);
  }, 60_000);

  it('publishes the conversation as a turn starts, after each copy of its steps, and as it ends', async () => {
    const { answer, parts, published } = await followedWhileWorking(
      (tools) => opencode.chat({ tools }),
      opencode.messages(),
    );
    expect(answer).toBe('Done: moved 5 from account 1 to account 2');
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
    // At its start, once the reply with the call is copied, once the call's result is, and at its end.
    expect(published).toBe(4);
  }, 60_000);

  it('publishes a round of tool calls once its reply is copied and once each result is, not as the calls start', async () => {
    fake.script.reply = (request) => {
      const last = request.prompt.at(-1)!;
      if (last.role === 'tool') return { text: 'Done' };
      if (!fake.textOf(last).endsWith(THREE_TOOLS)) return fake.teller(request);
      const [call, ...calls] = ['t1', 't2', 't3'].map((name) => ({ id: `call_${name}`, name, input: {} }));
      return { text: 'On it.', call, calls };
    };
    const { answer, published, seen } = await followedRound((tools) => opencode.chat({ tools }), opencode.messages());
    expect(answer).toBe('Done');
    // OpenCode runs the calls at once; each result is copied as its tool returns it, then published.
    expect(seen.slice(0, 2)).toEqual([[], [null, null, null]]);
    expect(seen.at(-1)).toEqual(['result of t1', 'result of t2', 'result of t3']);
    // One publish per copy of the reply and of each result: never one that shows nothing new.
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((s) => JSON.stringify(s))).size).toBe(5);
    // Those publishes, and the turn's close.
    expect(published).toBe(6);
  }, 60_000);

  it('gives the conversation from the store: what was said, in order, with the tool calls', async () => {
    const c = conversation(prompt, 'm');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'audit the books');
    expect(await c.read(opencode.messages(), {})).toEqual({ messages: SAID, more: false, cursor: expect.any(Number) });
  }, 60_000);

  it("forgets the conversation on `clear`, OpenCode's database too", async () => {
    const c = conversation(prompt, 'clear');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    const agent = opencode.agent({ name: 'OpenCodeAgent', tools: bank('OpenCodeAgent') });
    const map = c.state as Map<string, Uint8Array>;
    await invoke(agent, 'erase', fakeContext({ map, service: 'OpenCodeAgent', key: 'clear', id: 'inv_erase' }));
    expect((await c.read(opencode.messages(), {})).messages).toEqual([]);
    expect(await c.attempt('inv2', 'Hello')).toMatch(/^Ask me/);
    // OpenCode's session starts anew: the model sees only the new prompt.
    expect(userTexts()).toEqual(['Hello']);
  }, 60_000);

  it('asks again within the turn for an answer that is not the output asked for', async () => {
    fake.script.reply = ({ prompt: asked }) =>
      fake.textOf(asked.at(-1)!).startsWith('Your reply is not the answer') ? { text: '{"n":1}' } : { text: 'one' };
    const c = conversation(
      opencode.chat({ output: z.object({ n: z.number() }) }) as unknown as PromptHandler,
      'output',
    );
    expect(await c.attempt('inv1', 'How many?')).toEqual({ n: 1 });
    // One turn: its prompt, the reply, the ask again, and its answer.
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: '{"n":1}' }]);
    expect(fake.script.requests).toHaveLength(2);
  }, 60_000);

  it('gives the model its system prompt', async () => {
    const c = conversation(opencode.chat({ system: 'You are Ada.' }), 'ada');
    expect(await c.attempt('inv1', 'Who are you?')).toContain('You are Ada.');
  }, 60_000);

  it('answers a message once after a crash at any of its state requests', async () => {
    // One at a time: the teller's script is shared.
    expect(
      await crashedAnywhere(prompt, opencode.messages(), {
        concurrency: 1,
        stride: Number(process.env.CRASH_STRIDE ?? 7),
      }),
    ).toEqual([]);
  }, 600_000);
});

/** The user's messages and tool results of each of the model's requests after its first, after the prompt. */
const steps = () =>
  fake.script.requests.slice(1).map((r) =>
    r.prompt
      .filter((m) => m.role === 'user' || m.role === 'tool')
      .slice(1)
      .map((m) => fake.textOf(m)),
  );

/** The texts of the conversation's messages, as the `messages` view of `map`'s key `key` gives them. */
const textsOf = async (map: Map<string, Uint8Array>, key: string) => {
  const read = sqlAttempt({ map, key, id: 'read', shared: true });
  const { messages } = await read.end(() => opencode.messages()(read.view, {}));
  return messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])));
};

describe.skipIf(!NODE_24)('the OpenCode agent, steered', () => {
  /** The steered message, placed by OpenCode at the step after the transfer's round, after its result: the model audits. */
  const SAID_STEERED = [
    ['user', 'Please move 5 from 1 to 2'],
    ['assistant', 'On it. + transfer'],
    ['user', 'audit the books'],
    ['assistant', 'audit'],
    ['assistant', 'moved 5 from account 1 to account 2\nthe books are fine'],
  ];
  const STEERED = 'audit the books';
  const INTERRUPTED = /Tool execution interrupted/;

  /** How many tool calls the model made: each has an id of its own. */
  let calls = 0;
  const call = (name: string, input: Record<string, unknown>) => ({ id: `call_${++calls}`, name, input });
  /**
   * The model of `steeredAtAStep`: it transfers as asked, audits when told
   * to (again, after a restart cut the audit off), and answers with its
   * tools' results.
   */
  const steeredModel = ({ prompt: asked }: Fake.Request): Fake.Reply => {
    const last = asked.at(-1)!;
    const text = fake.textOf(last);
    if (last.role === 'tool') {
      const results = asked.flatMap((m) => (m.role === 'tool' ? [fake.textOf(m)] : []));
      return { text: results.filter((r) => !INTERRUPTED.test(r)).join('\n') };
    }
    if (text === STEERED || fake.CONTINUE.test(text)) return { call: call('audit', {}) };
    if (/move 5 from 1 to 2/.test(text))
      return { text: 'On it.', call: call('transfer', { from: 1, to: 2, amount: 5 }) };
    throw new Error(`unexpected request: ${text}`);
  };

  /** Whether any request to the model had the steered message. */
  const asked = () => fake.script.requests.some((r) => r.prompt.some((m) => fake.textOf(m) === STEERED));

  beforeEach(() => {
    if (!NODE_24) return;
    fake.script.reply = steeredModel;
  });

  it('submits a message steered while a tool runs as the round is done: the next request has it, after the results', async () => {
    const { answer, said, audits, taken } = await steeredAtAStep(
      (tools) => opencode.chat({ tools }),
      opencode.messages(),
    );
    // Stored once, in its place: after the transfer's round.
    expect(said).toEqual(SAID_STEERED);
    expect(answer).toBe('moved 5 from account 1 to account 2\nthe books are fine');
    expect(audits).toBe(1);
    expect(taken).toEqual(['steer-1']);
    // The model's request after the transfer's result has the message, after it: the turn's next step.
    expect(steps()).toEqual([
      ['moved 5 from account 1 to account 2', STEERED],
      ['moved 5 from account 1 to account 2', STEERED, 'the books are fine'],
    ]);
  }, 60_000);

  it('retries a turn that failed after it took the message with the message, once', async () => {
    const { answer, failed, said, audits, taken } = await steeredAtAStep(
      (tools) => opencode.chat({ tools }),
      opencode.messages(),
      { failAudit: true },
    );
    expect(failed).toBeInstanceOf(Error);
    // OpenCode resumes the turn: the cut-off audit keeps OpenCode's result, and the model audits again.
    expect(said).toEqual([...SAID_STEERED.slice(0, 4), ['assistant', 'audit'], SAID_STEERED[4]]);
    expect(answer).toBe('moved 5 from account 1 to account 2\nthe books are fine');
    expect(audits).toBe(2);
    expect(taken).toEqual(['steer-1']);
    // OpenCode has it once too: each request since has it once.
    for (const step of steps()) expect(step.filter((s) => s === STEERED)).toHaveLength(1);
  }, 60_000);

  /**
   * `steeredAtAStep`'s turn, whose attempt dies (killed: nothing more is
   * stored) once OpenCode took the message (`submitted`: before OpenCode
   * stored the transfer's result, or placed the message), or once the model
   * is asked with it (`asked`: OpenCode placed it); then the next attempt.
   * Its answer, the message's `taken`s, whether the turn had stored it when
   * the attempt died, and the conversation's texts and steered rows then.
   */
  async function diedAfterSteer(at: 'submitted' | 'asked') {
    const key = `died-${at}`;
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: () => {
        if (!following.taken.flat().includes('steer-1')) following.steering = [{ id: 'steer-1', text: STEERED }];
        return 'moved 5 from account 1 to account 2';
      },
    });
    const audit = tool({ name: 'audit', description: 'Check the books.', input: z.object({}), run: () => 'fine' });
    const chat = handlerOf(opencode.chat({ tools: [transfer, audit] }));
    const fence = { closed: false };
    const first = sqlAttempt({ map, fence, key, id: 'inv1' });
    const died = Promise.withResolvers<void>();
    let storedThen: boolean | undefined;
    const die = () => {
      if (fence.closed) return;
      storedThen = following.taken.length > 0;
      fence.closed = true;
      first.abort();
      died.resolve();
    };
    if (at === 'submitted') boots.prompted = (input) => String(input.id).startsWith('msg_steer_') && die();
    fake.script.reply = (request) => {
      if (at === 'asked' && fake.textOf(request.prompt.at(-1)!) === STEERED) die();
      return steeredModel(request);
    };
    const answering = first.end(() => chat(first.ctx, 'Please move 5 from 1 to 2')).catch(() => {});
    await died.promise;
    await answering;
    boots.prompted = undefined;
    const second = sqlAttempt({ map, key, id: 'inv1' });
    const answer = await second.end(() => chat(second.ctx, 'Please move 5 from 1 to 2'));
    const read = sqlAttempt({ map, key, id: 'rows', shared: true });
    const rows = await read.end(() => read.view.db.values('SELECT turn, id FROM restate_agent_steers'));
    // Each `taken` once: the outbox sends one again after a crash, under the same idempotency key.
    const taken = [...new Set(following.taken.flat())];
    return { answer, taken, storedThen, texts: await textsOf(map, key), rows };
  }

  it('stores the message once when the attempt dies once OpenCode took it, before OpenCode placed it', async () => {
    const { answer, taken, storedThen, texts, rows } = await diedAfterSteer('submitted');
    expect(storedThen).toBe(false);
    // The resumed turn places it, after OpenCode's "Continue": the model audits. OpenCode never stored the
    // transfer's result, which it then gives as cut off (the turn keeps it as the tool returned it).
    expect(steps()[0]!.slice(-2)).toEqual([expect.stringMatching(fake.CONTINUE), STEERED]);
    expect(answer).toBe('fine');
    expect(taken).toEqual(['steer-1']);
    // The view has it once, after the transfer's round; the store holds it once, as the turn's.
    expect(texts.filter((t) => t === STEERED)).toHaveLength(1);
    expect(texts.indexOf(STEERED)).toBe(texts.indexOf('On it.') + 1);
    expect(rows).toEqual([[0, 'steer-1']]);
    for (const step of steps()) expect(step.filter((s) => s === STEERED).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('stores the message once when the attempt dies once the model is asked with it', async () => {
    const { answer, taken, texts, rows } = await diedAfterSteer('asked');
    expect(answer).toBe('moved 5 from account 1 to account 2\nfine');
    expect(taken).toEqual(['steer-1']);
    expect(texts.filter((t) => t === STEERED)).toHaveLength(1);
    expect(texts.indexOf(STEERED)).toBe(texts.indexOf('On it.') + 1);
    expect(rows).toEqual([[0, 'steer-1']]);
    for (const step of steps()) expect(step.filter((s) => s === STEERED).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('takes no message steered as the model writes the final answer: a turn of its own answers it', async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    fake.script.reply = (request) => {
      // The final answer: no step follows it.
      if (request.prompt.at(-1)!.role === 'tool') following.steering = [{ id: 'steer-1', text: STEERED }];
      return steeredModel(request);
    };
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: () => 'moved 5 from account 1 to account 2',
    });
    const sql = sqlAttempt({ map, key: 'late', id: 'inv1' });
    const chat = handlerOf(opencode.chat({ tools: [transfer] }));
    expect(await sql.end(() => chat(sql.ctx, 'Please move 5 from 1 to 2'))).toBe('moved 5 from account 1 to account 2');
    // Not taken: the message waits for the turn's end, then its own turn (`steered`) answers it.
    expect(following.taken).toEqual([]);
    expect(asked()).toBe(false);
    expect(await textsOf(map, 'late')).not.toContain(STEERED);
  }, 60_000);

  it('takes no message into a turn that is stopped', async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    const first = sqlAttempt({ map, key: 'stopped', id: 'inv1' });
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      // The message comes as the turn is stopped; the call returns anyway.
      run: async () => {
        following.steering = [{ id: 'steer-1', text: STEERED }];
        first.cancel();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'moved 5 from account 1 to account 2';
      },
    });
    const chat = handlerOf(opencode.chat({ tools: [transfer] }));
    const failed = await first
      .end(() => chat(first.ctx, 'Please move 5 from 1 to 2'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(following.taken).toEqual([]);
    expect(asked()).toBe(false);
    const texts = await textsOf(map, 'stopped');
    expect(texts).not.toContain(STEERED);
    expect(texts.at(-1)).toBe(CANCELLED);
  }, 60_000);

  it('answers once a message OpenCode took as its turn was stopped', async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    const first = sqlAttempt({ map, key: 'stopped-after', id: 'inv1' });
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: () => {
        following.steering = [{ id: 'steer-1', text: STEERED }];
        return 'moved 5 from account 1 to account 2';
      },
    });
    const audit = tool({ name: 'audit', description: 'Check the books.', input: z.object({}), run: () => 'fine' });
    const chat = handlerOf(opencode.chat({ tools: [transfer, audit] }));
    fake.script.reply = steeredModel;
    // Stopped once OpenCode took the steered message, before the turn's next step.
    boots.prompted = (input) => {
      if (String(input.id).startsWith('msg_steer_')) first.cancel();
    };
    const failed = await first
      .end(() => chat(first.ctx, 'Please move 5 from 1 to 2'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    boots.prompted = undefined;
    expect(failed).toBeInstanceOf(restate.CancelledError);
    const taken = [...new Set(following.taken.flat())];
    const texts = await textsOf(map, 'stopped-after');
    // The message is the stopped turn's if OpenCode placed it, and then the turn holds it, once: the
    // companion answers as a turn of its own only a message no turn took.
    expect(texts.filter((t) => t === STEERED)).toHaveLength(taken.length);
    // The next prompt's model has it as often as OpenCode's history does: never twice.
    fake.script.reply = () => ({ text: 'Hi.' });
    const second = sqlAttempt({ map, key: 'stopped-after', id: 'inv2' });
    expect(await second.end(() => chat(second.ctx, 'Hello'))).toBe('Hi.');
    const said = fake.script.requests.at(-1)!.prompt.map((m) => fake.textOf(m));
    expect(said.filter((t) => t === STEERED)).toHaveLength(taken.length);
  }, 60_000);

  it('answers once a message OpenCode placed after the stopped turn was last copied, before its interrupt', async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    const first = sqlAttempt({ map, key: 'placed-at-stop', id: 'inv1' });
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: () => {
        following.steering = [{ id: 'steer-1', text: STEERED }];
        return 'moved 5 from account 1 to account 2';
      },
    });
    // The audit runs once the model was asked with the message, which OpenCode placed: it never returns,
    // so the turn ends only by its interrupt.
    const { promise: placed, resolve: auditing } = Promise.withResolvers<void>();
    const audit = tool({
      name: 'audit',
      description: 'Check the books.',
      input: z.object({}),
      run: () => {
        auditing();
        return new Promise<string>(() => {});
      },
    });
    const chat = handlerOf(opencode.chat({ tools: [transfer, audit] }));
    fake.script.reply = steeredModel;
    // Stopped once OpenCode took the message; OpenCode stores nothing more (its transactions wait) until
    // the stop's copy is done and its interrupt is under way: then OpenCode places the message, and the
    // model is asked with it, before the interrupt reaches OpenCode.
    const { promise: interrupting, resolve: interrupted } = Promise.withResolvers<void>();
    let holding = false;
    boots.prompted = (input) => {
      if (!String(input.id).startsWith('msg_steer_')) return;
      holding = true;
      first.cancel();
    };
    boots.transaction = async (run) => {
      if (holding) await interrupting;
      return run();
    };
    boots.interrupting = async () => {
      boots.interrupting = undefined;
      holding = false;
      interrupted();
      await placed;
    };
    const failed = await first
      .end(() => chat(first.ctx, 'Please move 5 from 1 to 2'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    boots.prompted = undefined;
    boots.transaction = undefined;
    expect(failed).toBeInstanceOf(restate.CancelledError);
    // OpenCode's history has the message: the stopped turn holds it, once, and the companion is told it
    // is taken (it answers no turn of its own).
    expect([...new Set(following.taken.flat())]).toEqual(['steer-1']);
    const texts = await textsOf(map, 'placed-at-stop');
    expect(texts.filter((t) => t === STEERED)).toHaveLength(1);
    expect(texts.at(-1)).toBe(CANCELLED);
    // The next prompt's model has it once.
    fake.script.reply = () => ({ text: 'Hi.' });
    const second = sqlAttempt({ map, key: 'placed-at-stop', id: 'inv2' });
    expect(await second.end(() => chat(second.ctx, 'Hello'))).toBe('Hi.');
    const said = fake.script.requests.at(-1)!.prompt.map((m) => fake.textOf(m));
    expect(said.filter((t) => t === STEERED)).toHaveLength(1);
  }, 60_000);

  it("closes a stopped turn cancelled although a tool's error ended the attempt as OpenCode was interrupted", async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    const first = sqlAttempt({ map, key: 'failed-at-stop', id: 'inv1' });
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: () => {
        following.steering = [{ id: 'steer-1', text: STEERED }];
        return 'moved 5 from account 1 to account 2';
      },
    });
    // As in the test before, but the audit, which runs as the interrupt waits, fails: its error closes
    // the attempt's fence, before the interrupt reaches OpenCode. An OpenCode tool, whose error is its
    // own (a Restate tool's error after the cancellation is the cancellation).
    const { promise: failing, resolve: failed } = Promise.withResolvers<void>();
    const audit: OpenCode.OpenCodeTool = {
      name: 'audit',
      description: 'Check the books.',
      input: z.object({}),
      execute: () => {
        setTimeout(failed, 20);
        return Promise.reject(new Error('the books are locked'));
      },
    };
    const chat = handlerOf(opencode.chat({ tools: [transfer, audit] }));
    fake.script.reply = steeredModel;
    const { promise: interrupting, resolve: interrupted } = Promise.withResolvers<void>();
    let holding = false;
    boots.prompted = (input) => {
      if (!String(input.id).startsWith('msg_steer_')) return;
      holding = true;
      first.cancel();
    };
    boots.transaction = async (run) => {
      if (holding) await interrupting;
      return run();
    };
    boots.interrupting = async () => {
      boots.interrupting = undefined;
      holding = false;
      interrupted();
      await failing;
    };
    const ended = await first
      .end(() => chat(first.ctx, 'Please move 5 from 1 to 2'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    boots.prompted = undefined;
    boots.transaction = undefined;
    // OpenCode refuses the interrupt, and anything more of the over attempt: the turn closes cancelled all
    // the same, without the message OpenCode placed before the fence closed (the attempt stores nothing more).
    expect(ended).toBeInstanceOf(restate.CancelledError);
    expect(following.taken).toEqual([]);
    const texts = await textsOf(map, 'failed-at-stop');
    expect(texts).not.toContain(STEERED);
    expect(texts.at(-1)).toBe(CANCELLED);
  }, 60_000);
});

/** The provider's error of a request, with HTTP `statusCode` (and `headers`). */
const failure = (statusCode: number, headers?: Record<string, string>) =>
  new APICallError({
    message: statusCode === 401 ? 'Incorrect API key provided' : 'Service Unavailable',
    url: 'https://scripted.invalid/v1',
    requestBodyValues: {},
    statusCode,
    ...(headers && { responseHeaders: headers }),
    isRetryable: statusCode >= 500 || statusCode === 429,
  });

/** OpenCode's own error of a request that timed out (its HTTP transport's: code `Timeout`), as OpenCode's `ai` makes it. */
const timedOut = async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  // `@opencode/ai`, beside OpenCode's core (not a dependency of ours): the one whose errors OpenCode knows.
  const core = fs.realpathSync(
    url.fileURLToPath(new URL('../node_modules/@opencode/core/package.json', import.meta.url)),
  );
  const at = fs.realpathSync(path.join(path.dirname(core), '../ai/dist/effect.js'));
  type Made = new (fields: Record<string, unknown>) => Error;
  const ai = (await import(url.pathToFileURL(at).href)) as {
    AIError: Made;
    TransportError: Made;
  };
  return () =>
    new ai.AIError({
      reason: new ai.TransportError({
        message: 'request timed out',
        transport: 'http',
        operation: 'read',
        code: 'Timeout',
      }),
    });
};

/**
 * The teller, behind a provider that fails the next `n` requests with
 * `error`'s, or with HTTP status `error`. When each request came (ms).
 */
const failing = (n: number, error: number | (() => unknown) = 503) => {
  let left = n;
  const times: number[] = [];
  fake.script.reply = (request) => {
    times.push(Date.now());
    if (left-- > 0) throw typeof error === 'number' ? failure(error) : error();
    return fake.teller(request);
  };
  return times;
};

/** The bank's chat, asking again within a millisecond. */
const quickChat = () => opencode.chat({ tools: bank('OpenCodeAgent'), retry: { baseDelayMs: 1, maxAgentDelayMs: 1 } });

/** The parts of each message of conversation `c`. */
const partsOf = async (c: ReturnType<typeof conversation>) =>
  (await c.read(opencode.messages(), {})).messages.map((m) => m.parts);

// A provider's outage is asked again, as pi does; a refusal ends the turn at once.
describe.skipIf(!NODE_24)("the OpenCode agent through a provider's outage", () => {
  const transferred = [
    [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
    [
      { type: 'text', text: 'On it.' },
      {
        type: 'tool',
        id: expect.any(String),
        name: 'transfer',
        input: { from: 1, to: 2, amount: 5 },
        output: 'moved 5 from account 1 to account 2',
      },
    ],
    [{ type: 'text', text: 'Done: moved 5 from account 1 to account 2' }],
  ];

  it('answers through an outage: the model is asked again, and nothing is copied twice', async () => {
    failing(3);
    const c = conversation(quickChat(), 'outage');
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe('Done: moved 5 from account 1 to account 2');
    // Three failed requests, then the step's and the next one's.
    expect(fake.script.requests).toHaveLength(5);
    expect(c.ledger.transfers.size).toBe(1);
    expect(await partsOf(c)).toEqual(transferred);
  }, 60_000);

  it('fails the attempt past the retries OpenCode makes, and the next attempt answers the turn', async () => {
    failing(12);
    const c = conversation(quickChat(), 'long-outage');
    const failed = await c.attempt('inv1', 'Please move 5 from 1 to 2').then(
      () => undefined,
      (error: unknown) => error,
    );
    // Not terminal: Restate retries the attempt, and the turn stays open.
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(restate.TerminalError);
    expect(fake.script.requests).toHaveLength(10);
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe('Done: moved 5 from account 1 to account 2');
    expect(fake.script.requests).toHaveLength(14);
    expect(c.ledger.transfers.size).toBe(1);
    expect(await partsOf(c)).toEqual(transferred);
  }, 60_000);

  it('fails the attempt at the timeout OpenCode no longer retries, and the next attempt answers the turn', async () => {
    // OpenCode retries 3 timeouts of a step, and proposes no retry of the 4th.
    failing(4, await timedOut());
    const c = conversation(quickChat(), 'timeouts');
    const failed = await c.attempt('inv1', 'Please move 5 from 1 to 2').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(restate.TerminalError);
    expect(fake.script.requests).toHaveLength(4);
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe('Done: moved 5 from account 1 to account 2');
    expect(fake.script.requests).toHaveLength(6);
    expect(c.ledger.transfers.size).toBe(1);
    expect(await partsOf(c)).toEqual(transferred);
  }, 60_000);

  it("asks a rate-limited request again no sooner than the provider's retry-after", async () => {
    const times = failing(1, () => failure(429, { 'retry-after': '1' }));
    const c = conversation(quickChat(), 'retry-after');
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe('Done: moved 5 from account 1 to account 2');
    expect(times).toHaveLength(3);
    // A second, though the backoff is a millisecond.
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1_000);
    expect(await partsOf(c)).toEqual(transferred);
  }, 60_000);

  it('fails a refused request with 424 at once, never asking again', async () => {
    failing(1, 401);
    const c = conversation(quickChat(), 'refused-once');
    const failed = await c.attempt('inv1', 'Hello').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect((failed as restate.TerminalError).code).toBe(REFUSED);
    expect(fake.script.requests).toHaveLength(1);
  }, 60_000);

  it('ends a turn stopped while it waits to ask again, cancelled, at once', async () => {
    failing(Infinity);
    const map = new Map<string, Uint8Array>();
    const slow = handlerOf(opencode.chat({ tools: bank('OpenCodeAgent'), retry: { baseDelayMs: 60_000 } }));
    const first = sqlAttempt({ map, key: 'stopped-retrying', id: 'inv1' });
    const answering = first.end(() => slow(first.ctx, 'Please move 5 from 1 to 2'));
    // The first request failed: OpenCode waits a minute to ask again.
    while (fake.script.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopped = Date.now();
    first.cancel();
    const failed = await answering.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(Date.now() - stopped).toBeLessThan(10_000);
    expect(fake.script.requests).toHaveLength(1);
    fake.script.reply = fake.teller;
    const second = sqlAttempt({ map, key: 'stopped-retrying', id: 'inv2' });
    expect(await second.end(() => slow(second.ctx, 'Hello'))).toMatch(/^Ask me/);
    const read = sqlAttempt({ map, key: 'stopped-retrying', id: 'read', shared: true });
    const page = await read.end(() => opencode.messages()(read.view, {}));
    expect(page.messages.map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
      [{ type: 'text', text: CANCELLED }],
      [{ type: 'text', text: 'Hello' }],
      [{ type: 'text', text: 'Ask me to "move 5 from 1 to 2", or to "audit" the books.' }],
    ]);
  }, 60_000);
});

/** A workspace of its own, with a `.env`, which OpenCode's build agent asks about before it reads it. */
async function workspaceOf() {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-permission-'));
  await writeFile(join(dir, '.env'), 'SECRET=42\n');
  return dir;
}

/** The model of the permission asks: it reads `.env`, then answers with what the read returned. */
function reader({ prompt: asked }: Fake.Request): Fake.Reply {
  const last = asked.at(-1)!;
  if (last.role === 'tool') return { text: `Read: ${fake.textOf(last)}` };
  return { call: { id: `call_${randomUUID()}`, name: 'read', input: { path: '.env' } } };
}

/** A permission's denial with `message`, as the model gets it: OpenCode's tool error. */
const refusalOf = (message: string) => JSON.stringify({ error: { type: 'permission.rejected', message }, content: [] });

/** What the shell runs: it appends a line to `ran.txt` of the workspace, once each time it runs. */
const COMMAND = 'echo ran >> ran.txt';

/** How often {@link COMMAND} ran in `workspace`. */
const runs = async (workspace: string) =>
  (await readFile(join(workspace, 'ran.txt'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

/** OpenCode's rules, as a plugin's: every shell command asks. */
const askShell: NonNullable<OpenCode.Options['plugins']>[number] = {
  id: 'test.ask-shell',
  async setup(ctx) {
    const transform = await ctx.agent.transform((editor) => {
      for (const agent of editor.list()) {
        editor.update(agent.id, (a) => a.permissions.push({ action: 'shell', resource: '*', effect: 'ask' }));
      }
    });
    return () => transform.dispose();
  },
};

/**
 * The model: it runs the command, again under a new id when a restart cut
 * it off, then answers with its result.
 */
const runner = ({ prompt: asked }: Fake.Request): Fake.Reply => {
  const last = asked.at(-1)!;
  if (last.role === 'tool' && !/Tool execution interrupted/.test(fake.textOf(last)))
    return { text: `Done: ${fake.textOf(last)}` };
  return { call: { id: `call_${randomUUID()}`, name: 'shell', input: { command: COMMAND } } };
};

/** The wait of invocation `inv1` for the approval of the command's tool call `callId`. */
const approvalOf = (callId: string) => ({
  id: `inv1:${callId}`,
  name: opencode.APPROVAL,
  input: { tool: 'shell', args: { command: COMMAND }, action: 'shell', resources: expect.any(Array) },
});
/** The agent, whose asks wait for a person's approval, in `workspace`. */
const approving = (workspace: string) => opencode.chat({ workspace, approval: true, plugins: [askShell] });

describe.skipIf(!NODE_24)("the OpenCode agent's permission asks", () => {
  it('OpenCode alone asks in memory, and waits for a reply that nothing gives: the turn never ends', async () => {
    // OpenCode's build agent allows every action but `read` of `*.env`, which it asks about.
    const db = await import('@restatedev/agents/opencode/db');
    fake.script.reply = reader;
    const workspace = await workspaceOf();
    const sql = sqlAttempt({ map: new Map(), key: 'alone', id: 'inv1' });
    const { asked, ended } = await sql.end(async () => {
      const host = await db.openOpenCode(
        databaseOf(sql.ctx.db, 'restate-agents.opencode'),
        { closed: false },
        { config: { default_agent: 'build' }, local: true },
      );
      try {
        const sessionID = 'ses_alone' as never;
        await host.call(
          host.client.session.create({
            id: sessionID,
            model: fake.MODEL as never,
            agent: 'build' as never,
            location: { directory: workspace as never },
          }),
        );
        await host.call(host.client.session.prompt({ sessionID, text: 'Read .env', delivery: 'queue' }));
        let pending: unknown[] = [];
        for (let n = 0; n < 400 && pending.length === 0; n++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          pending = (await host.call(host.client.permission.list({ sessionID }))) as unknown[];
        }
        // Nothing replies: the turn still runs a while later.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const turns: Record<string, unknown> = await host.call(host.client.session.active());
        return { asked: pending, ended: turns[sessionID as string] === undefined };
      } finally {
        await host.close();
      }
    });
    expect(asked).toMatchObject([{ action: 'read', resources: ['.env'] }]);
    expect(ended).toBe(false);
  }, 60_000);

  it('denies an ask by default, as OpenCode denies one nobody is present for: the model is told, the turn ends', async () => {
    fake.script.reply = reader;
    const c = conversation(opencode.chat({ workspace: await workspaceOf() }), 'denied');
    const denial = 'Permission read needs approval, and nobody is present to give it';
    expect(await c.attempt('inv1', 'Read .env')).toBe(`Read: ${refusalOf(denial)}`);
    expect(c.signals.waits).toEqual([]);
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages[1]!.parts).toEqual([
      { type: 'tool', id: expect.any(String), name: 'read', input: { path: '.env' }, output: denial, error: true },
    ]);
  }, 60_000);

  it('runs a tool call OpenCode asks about once a person approved it, and not before', async () => {
    fake.script.reply = runner;
    const workspace = await workspaceOf();
    const c = conversation(approving(workspace), 'approved');
    // How often the command had run as each wait was made.
    const before: number[] = [];
    c.signals.answer = async () => {
      before.push(await runs(workspace));
      return 'approved';
    };
    expect(await c.attempt('inv1', 'Run it')).toBe('Done: (no output)');
    expect(before).toEqual([0]);
    expect(await runs(workspace)).toBe(1);
    const { messages } = await c.read(opencode.messages(), {});
    const call = messages[1]!.parts[0] as { id: string };
    expect(call).toMatchObject({ type: 'tool', name: 'shell', input: { command: COMMAND } });
    // The wait is the call's, and shows its tool and arguments, and the permission asked.
    expect(c.signals.waits).toEqual([approvalOf(call.id)]);
  }, 60_000);

  it('never runs a tool call a person denied, and the model is told why', async () => {
    fake.script.reply = runner;
    const workspace = await workspaceOf();
    const c = conversation(approving(workspace), 'refused');
    c.signals.answer = () => 'no, not today';
    const denied = 'The user denied tool "shell": no, not today';
    expect(await c.attempt('inv1', 'Run it')).toBe(`Done: ${refusalOf(denied)}`);
    expect(await runs(workspace)).toBe(0);
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages[1]!.parts).toEqual([
      { type: 'tool', id: expect.any(String), name: 'shell', input: { command: COMMAND }, output: denied, error: true },
    ]);
  }, 60_000);

  it('waits for an approval through a crash: the person is asked once, and the tool runs once, after it', async () => {
    fake.script.reply = runner;
    const workspace = await workspaceOf();
    const c = conversation(approving(workspace), 'approval-crash');
    const before: number[] = [];
    const asked = Promise.withResolvers<void>();
    // No decision yet: the attempt crashes (or is suspended) while it waits.
    c.signals.answer = async () => {
      before.push(await runs(workspace));
      asked.resolve();
      return new Promise(() => {});
    };
    c.attempt('inv1', 'Run it').catch(() => {});
    await asked.promise;
    c.signals.answer = async () => {
      before.push(await runs(workspace));
      return 'approved';
    };
    // The resumed turn cuts the call off, and the model makes it again under a new id: it joins the first's wait.
    expect(await c.attempt('inv1', 'Run it')).toBe('Done: (no output)');
    expect(continued()).toBe(true);
    const [wait, again] = c.signals.waits;
    expect(c.signals.waits).toHaveLength(2);
    expect(again).toEqual(wait);
    expect(before).toEqual([0, 0]);
    expect(await runs(workspace)).toBe(1);
  }, 60_000);

  it('ends a turn stopped while it waits for an approval cancelled, and never runs the tool', async () => {
    fake.script.reply = runner;
    const workspace = await workspaceOf();
    const map = new Map<string, Uint8Array>();
    const chat = handlerOf(opencode.chat({ workspace, approval: true, plugins: [askShell] }));
    const asked = Promise.withResolvers<void>();
    const sql = sqlAttempt({
      map,
      key: 'approval-cancel',
      id: 'inv1',
      signal: () => {
        asked.resolve();
        return new Promise(() => {});
      },
    });
    const answering = sql.end(() => chat(sql.ctx, 'Run it'));
    await asked.promise;
    sql.cancel();
    await expect(answering).rejects.toBeInstanceOf(restate.CancelledError);
    expect(await runs(workspace)).toBe(0);
    const read = sqlAttempt({ map, key: 'approval-cancel', id: 'read', shared: true });
    const { messages } = await read.end(() => opencode.messages()(read.view, {}));
    expect(messages.map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'Run it' }],
      [
        {
          type: 'tool',
          id: expect.any(String),
          name: 'shell',
          input: { command: COMMAND },
          output: CANCELLED,
          error: true,
        },
      ],
      [{ type: 'text', text: CANCELLED }],
    ]);
  }, 60_000);
});

/** Whether `writes` (one of OpenCode's transactions) stores its idle marker: its turn ended, its claim released. */
const idles = (writes: unknown[][]) => writes.some((p) => p[2] === 'idle');

describe.skipIf(!NODE_24)('the OpenCode agent, killed at the end of a turn', () => {
  const ASKED = 'Please move 5 from 1 to 2';
  const DONE = 'Done: moved 5 from account 1 to account 2';

  /** The data of the final reply's step that `writes` (one of OpenCode's transactions) stores, if it does. */
  const doneIn = (writes: unknown[][]) =>
    writes.map((p) => (p[0] === 'assistant' ? String(p[3]) : '')).find((data) => data.includes(DONE));
  /** Whether `writes` stores the final reply's step as its stream ended (before OpenCode stores how the step ended). */
  const streamsDone = (writes: unknown[][]) => doneIn(writes)?.includes('"streamed"') === true;
  /** Whether `writes` stores the final reply's step as ended. */
  const endsDone = (writes: unknown[][]) => doneIn(writes)?.includes('"completed"') === true;

  /**
   * The bank's turn, whose attempt dies (killed: nothing more is stored) at
   * its end: `streamed`, as OpenCode commits the final reply's stream end,
   * before it stores how the step ended; `stored`, as it commits the step's
   * end, before the copy; `copied`, once the turn has the reply copied,
   * before OpenCode ends its turn (its claim held); `idle`, once OpenCode
   * ended its turn too, before the turn's answer is stored. Then the next
   * attempt (`retry`), or, the invocation gone, the next message (`killed`,
   * 'Hello'). Its answer, the conversation's texts, the requests to the
   * model since the death, and the transfers.
   */
  async function diedAtTheEnd(at: 'streamed' | 'stored' | 'copied' | 'idle', next: 'retry' | 'killed') {
    const key = `end-${at}-${next}`;
    const c = conversation(prompt, key);
    const map = c.state as Map<string, Uint8Array>;
    const { promise: dead, resolve: died } = Promise.withResolvers<void>();
    let ended = false;
    /** Once the turn holds the final reply: read beside the attempt. */
    const copied = async () => {
      while (!(await textsOf(map, key)).includes(DONE)) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    boots.transaction = async (run, writes) => {
      if (ended && (at === 'copied' || at === 'idle')) {
        // OpenCode's next transaction waits for the copy (which reads OpenCode outside of it).
        await copied();
        if (at === 'copied') {
          boots.transaction = undefined;
          died();
          throw new Error('killed');
        }
      }
      const result = await run();
      if (endsDone(writes)) ended = true;
      const dies =
        (at === 'streamed' && streamsDone(writes)) ||
        (at === 'stored' && endsDone(writes)) ||
        (at === 'idle' && idles(writes));
      if (dies) {
        boots.transaction = undefined;
        died();
      }
      return result;
    };
    // The attempt is abandoned (fenced) as it dies: the next attempt closes its fence.
    void c.attempt('inv1', ASKED).catch(() => {});
    await dead;
    const asked = fake.script.requests.length;
    const answer = await (next === 'retry' ? c.attempt('inv1', ASKED) : c.attempt('inv2', 'Hello'));
    return {
      answer,
      texts: await textsOf(map, key),
      requests: fake.script.requests.slice(asked),
      transfers: c.ledger.transfers.size,
      c,
    };
  }

  it('resumes a turn whose final step failed past the retries OpenCode makes: no final reply is stored', async () => {
    // The transfer's step is answered; the final step's requests fail, past OpenCode's ten.
    let left = 12;
    fake.script.reply = (request) => {
      if (request.prompt.at(-1)!.role === 'tool' && left-- > 0) throw failure(503);
      return fake.teller(request);
    };
    const c = conversation(quickChat(), 'end-outage');
    const failed = await c.attempt('inv1', ASKED).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(restate.TerminalError);
    // The retry resumes OpenCode's turn, which asks the model for the final step again.
    expect(await c.attempt('inv1', ASKED)).toBe(DONE);
    expect(continued()).toBe(true);
    expect(c.ledger.transfers.size).toBe(1);
    expect(await textsOf(c.state as Map<string, Uint8Array>, 'end-outage')).toEqual([ASKED, 'On it.', DONE]);
  }, 60_000);

  it('resumes a turn killed once its final reply streamed, before OpenCode stored how its step ended', async () => {
    const { answer, texts, requests, transfers } = await diedAtTheEnd('streamed', 'retry');
    expect(answer).toBe(DONE);
    // The step might yet have failed: the turn holds no final reply, and OpenCode's turn is resumed.
    expect(requests.map((r) => fake.textOf(r.prompt.at(-1)!))).toEqual([expect.stringMatching(fake.CONTINUE)]);
    // The step left without its end is no reply: the view has the resumed turn's, once.
    expect(texts).toEqual([ASKED, 'On it.', DONE]);
    expect(transfers).toBe(1);
  }, 60_000);

  it('closes a turn killed once its final reply streamed by the next message: never finished', async () => {
    const { answer, texts, requests, transfers } = await diedAtTheEnd('streamed', 'killed');
    expect(answer).toMatch(/^Ask me/);
    expect(texts).toEqual([ASKED, 'On it.', ENDED, 'Hello', answer]);
    expect(requests.map((r) => fake.textOf(r.prompt.findLast((m) => m.role === 'user')!))).toEqual([
      `(${ENDED})\n\nHello`,
    ]);
    expect(transfers).toBe(1);
  }, 60_000);

  /** OpenCode's message after a step whose stream failed with output: it goes on in a step of its own. */
  const INCOMPLETE = /^The previous response was interrupted/;
  /** The bank's teller, whose final reply's stream fails once, after `Done: mov`; asked to go on, it answers. */
  const failingMidStream = () => {
    let failed = false;
    fake.script.reply = (request) => {
      const last = request.prompt.at(-1)!;
      if (last.role === 'tool' && !failed) {
        failed = true;
        return { text: 'Done: mov', error: failure(503) };
      }
      if (last.role === 'user' && (INCOMPLETE.test(fake.textOf(last)) || fake.CONTINUE.test(fake.textOf(last))))
        return { text: DONE };
      return fake.teller(request);
    };
  };

  it('never stores a step whose stream failed after its text as a reply: the step asked again answers', async () => {
    failingMidStream();
    const c = conversation(quickChat(), 'mid-stream');
    expect(await c.attempt('inv1', ASKED)).toBe(DONE);
    // OpenCode kept the failed step, and asked again after it.
    expect(fake.textOf(fake.script.requests.at(-1)!.prompt.at(-1)!)).toMatch(INCOMPLETE);
    expect(await textsOf(c.state as Map<string, Uint8Array>, 'mid-stream')).toEqual([ASKED, 'On it.', DONE]);
    expect(c.ledger.transfers.size).toBe(1);
  }, 60_000);

  it('resumes a turn killed once a step whose stream failed after its text was stored: never its answer', async () => {
    failingMidStream();
    const c = conversation(quickChat(), 'mid-stream-killed');
    const { promise: dead, resolve: died } = Promise.withResolvers<void>();
    boots.transaction = async (run, writes) => {
      const result = await run();
      // OpenCode stored the step as failed: the attempt dies before OpenCode asks again.
      const failedStep = writes.some((p) => p[0] === 'assistant' && /"error"/.test(String(p[3])));
      if (failedStep) {
        boots.transaction = undefined;
        died();
      }
      return result;
    };
    void c.attempt('inv1', ASKED).catch(() => {});
    await dead;
    expect(await c.attempt('inv1', ASKED)).toBe(DONE);
    // Not answered with the failed step's text: OpenCode's turn was resumed.
    expect(continued()).toBe(true);
    expect(await textsOf(c.state as Map<string, Uint8Array>, 'mid-stream-killed')).toEqual([ASKED, 'On it.', DONE]);
    expect(c.ledger.transfers.size).toBe(1);
  }, 60_000);

  /** OpenCode's message after a step without tool calls cut off at the model's output limit: it goes on. */
  const OUTPUT_LIMIT = /^Your last response hit the output token limit/;
  /** The bank's teller, whose final reply is cut off once at its output limit, after `Done: mov`; told so, it answers. */
  const cutOff = () => {
    let cut = false;
    fake.script.reply = (request) => {
      const last = request.prompt.at(-1)!;
      if (last.role === 'tool' && !cut) {
        cut = true;
        return { text: 'Done: mov', finish: 'length' };
      }
      if (last.role === 'user' && (OUTPUT_LIMIT.test(fake.textOf(last)) || fake.CONTINUE.test(fake.textOf(last))))
        return { text: DONE };
      return fake.teller(request);
    };
  };

  it('never stores a step cut off at the output limit as a reply: OpenCode asks the model to go on', async () => {
    cutOff();
    const c = conversation(quickChat(), 'cut-off');
    expect(await c.attempt('inv1', ASKED)).toBe(DONE);
    expect(fake.textOf(fake.script.requests.at(-1)!.prompt.at(-1)!)).toMatch(OUTPUT_LIMIT);
    expect(await textsOf(c.state as Map<string, Uint8Array>, 'cut-off')).toEqual([ASKED, 'On it.', DONE]);
    expect(c.ledger.transfers.size).toBe(1);
  }, 60_000);

  it('resumes a turn killed once a step cut off at the output limit was stored: never its answer', async () => {
    cutOff();
    const c = conversation(quickChat(), 'cut-off-killed');
    const { promise: dead, resolve: died } = Promise.withResolvers<void>();
    boots.transaction = async (run, writes) => {
      const result = await run();
      // OpenCode stored how the cut-off step ended: the attempt dies before OpenCode asks the model to go on.
      const ended = writes.some((p) => p[0] === 'assistant' && /"finish":"length"/.test(String(p[3])));
      if (ended) {
        boots.transaction = undefined;
        died();
      }
      return result;
    };
    void c.attempt('inv1', ASKED).catch(() => {});
    await dead;
    const asked = fake.script.requests.length;
    expect(await c.attempt('inv1', ASKED)).toBe(DONE);
    // Not answered with the cut-off text: OpenCode's turn was resumed, and the model asked again.
    expect(fake.script.requests.length).toBeGreaterThan(asked);
    expect(await textsOf(c.state as Map<string, Uint8Array>, 'cut-off-killed')).toEqual([ASKED, 'On it.', DONE]);
    expect(c.ledger.transfers.size).toBe(1);
  }, 60_000);

  /**
   * The bank's teller, whose final reply's stream ends once with `finish`, with its text (or `Done: mov` for
   * `other`); told to go on, it answers.
   */
  const endingWith = (finish: 'error' | 'other') => {
    let ended = false;
    fake.script.reply = (request) => {
      const last = request.prompt.at(-1)!;
      if (last.role === 'tool' && !ended) {
        ended = true;
        return { text: finish === 'other' ? 'Done: mov' : DONE, finish };
      }
      if (last.role === 'user' && (INCOMPLETE.test(fake.textOf(last)) || fake.CONTINUE.test(fake.textOf(last))))
        return { text: DONE };
      return fake.teller(request);
    };
  };

  /** `endingWith(finish)`'s turn, whose attempt dies once OpenCode stored how the final step ended; then the retry. */
  async function diedAtTheFinish(finish: 'error' | 'other') {
    endingWith(finish);
    const key = `finish-${finish}-killed`;
    // Stored as `error` either way: as the provider named it, or (`other`) as OpenCode stores a failed step.
    const stored = '"finish":"error"';
    const c = conversation(quickChat(), key);
    const { promise: dead, resolve: died } = Promise.withResolvers<void>();
    boots.transaction = async (run, writes) => {
      const result = await run();
      if (writes.some((p) => p[0] === 'assistant' && String(p[3]).includes(stored))) {
        boots.transaction = undefined;
        died();
      }
      return result;
    };
    void c.attempt('inv1', ASKED).catch(() => {});
    await dead;
    const asked = fake.script.requests.length;
    const answer = await c.attempt('inv1', ASKED);
    const texts = await textsOf(c.state as Map<string, Uint8Array>, key);
    return { answer, requests: fake.script.requests.slice(asked), texts };
  }

  // A step that ended with `error` (as a provider names how it ended, no error of the request's) ends
  // OpenCode's turn with its text: the turn's answer, live and after a crash alike.
  it('answers with a final reply whose step ended with `error`, as OpenCode does', async () => {
    endingWith('error');
    const c = conversation(quickChat(), 'finish-error');
    expect(await c.attempt('inv1', ASKED)).toBe(DONE);
    expect(fake.textOf(fake.script.requests.at(-1)!.prompt.at(-1)!)).toBe('moved 5 from account 1 to account 2');
    expect(await textsOf(c.state as Map<string, Uint8Array>, 'finish-error')).toEqual([ASKED, 'On it.', DONE]);
  }, 60_000);

  it('answers with a final reply whose step ended with `error` when the attempt dies once it was stored', async () => {
    const { answer, requests, texts } = await diedAtTheFinish('error');
    expect(answer).toBe(DONE);
    // The model is not asked again: the turn has its final reply, once.
    expect(requests).toEqual([]);
    expect(texts).toEqual([ASKED, 'On it.', DONE]);
  }, 60_000);

  // A step that ended with no reason OpenCode knows (`other`: OpenCode's `unknown`) failed, as a stream cut off does:
  // OpenCode asks the model to go on, live and after a crash alike.
  it('never stores a step that ended with no known reason as a reply: OpenCode asks the model to go on', async () => {
    endingWith('other');
    const c = conversation(quickChat(), 'finish-other');
    expect(await c.attempt('inv1', ASKED)).toBe(DONE);
    expect(fake.textOf(fake.script.requests.at(-1)!.prompt.at(-1)!)).toMatch(INCOMPLETE);
    expect(await textsOf(c.state as Map<string, Uint8Array>, 'finish-other')).toEqual([ASKED, 'On it.', DONE]);
  }, 60_000);

  it('resumes a turn killed once a step that ended with no known reason was stored: never its answer', async () => {
    const { answer, requests, texts } = await diedAtTheFinish('other');
    expect(answer).toBe(DONE);
    expect(requests).not.toEqual([]);
    expect(texts).toEqual([ASKED, 'On it.', DONE]);
  }, 60_000);

  it('copies a step whose call ran before its stream ended, when the attempt died there: resumed, each call with its result', async () => {
    const c = conversation(prompt, 'ran-unstreamed');
    const { promise: dead, resolve: died } = Promise.withResolvers<void>();
    let gone = false;
    // OpenCode runs a call as its stream goes on: the attempt dies once the call is stored running, before
    // OpenCode stores the stream's end. From then on, none of its writes is stored.
    boots.transaction = async (run, writes) => {
      if (gone) throw new Error('the attempt is gone');
      const result = await run();
      const running = writes.some(
        (p) => p[0] === 'assistant' && /"running"/.test(String(p[3])) && !/"streamed"/.test(String(p[3])),
      );
      if (running) {
        gone = true;
        died();
      }
      return result;
    };
    void c.attempt('inv1', ASKED).catch(() => {});
    await dead;
    boots.transaction = undefined;
    expect(await c.attempt('inv1', ASKED)).toBe(DONE);
    expect(continued()).toBe(true);
    const { messages } = await c.read(opencode.messages(), {});
    const tools = messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === 'tool' ? [p as { id: string; output?: string; error?: boolean }] : [])),
    );
    // The cut-off step, with its call (interrupted), the call made again with its result, then the answer once.
    expect(messages.map((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [p.type])))).toEqual([
      [ASKED],
      ['On it.', 'tool'],
      ['tool'],
      [DONE],
    ]);
    expect(tools).toHaveLength(2);
    for (const t of tools) expect(t.output).toBeDefined();
    expect(tools[0]).toMatchObject({ error: true, output: expect.stringMatching(/interrupted/) });
    expect(tools[1]).toMatchObject({ output: 'moved 5 from account 1 to account 2' });
    expect(c.ledger.transfers.size).toBe(1);
  }, 60_000);

  for (const at of ['stored', 'copied', 'idle'] as const) {
    it(`answers with the final reply OpenCode stored, once, when the attempt dies at its end (${at})`, async () => {
      const { answer, texts, requests, transfers, c } = await diedAtTheEnd(at, 'retry');
      expect(answer).toBe(DONE);
      // The model is not asked again: the turn has its final reply, once.
      expect(requests).toEqual([]);
      expect(texts).toEqual([ASKED, 'On it.', DONE]);
      expect(transfers).toBe(1);
      // The next message's model has the reply once, and the turn as answered: no note, no "Continue".
      expect(await c.attempt('inv2', 'Hello')).toMatch(/^Ask me/);
      const said = fake.script.requests.at(-1)!.prompt.map((m) => fake.textOf(m));
      expect(said.filter((t) => t === DONE)).toHaveLength(1);
      expect(said.at(-1)).toBe('Hello');
      expect(continued()).toBe(false);
    }, 60_000);

    it(`closes a turn killed at its end (${at}) by the next message: the reply kept, once, then the note`, async () => {
      const { answer, texts, requests, transfers } = await diedAtTheEnd(at, 'killed');
      expect(answer).toMatch(/^Ask me/);
      expect(texts).toEqual([ASKED, 'On it.', DONE, ENDED, 'Hello', answer]);
      // The model is asked for the next message alone.
      expect(requests.map((r) => fake.textOf(r.prompt.findLast((m) => m.role === 'user')!))).toEqual([
        `(${ENDED})\n\nHello`,
      ]);
      expect(transfers).toBe(1);
    }, 60_000);
  }
});

/** The model: it calls each of `names`, one reply each, then answers. */
const calling =
  (names: string[], requests: number[], kept: ReturnType<typeof scopes>) =>
  ({ prompt: asked }: Fake.Request): Fake.Reply => {
    requests.push(kept.open);
    const done = asked.filter((m) => m.role === 'tool').length;
    if (done < names.length) return { call: { id: `call_${randomUUID()}`, name: names[done]!, input: {} } };
    return { text: 'All done' };
  };

/** The model: it runs the long command, then answers. */
const sleeper = ({ prompt: asked }: Fake.Request): Fake.Reply =>
  asked.at(-1)!.role === 'tool'
    ? { text: 'Slept' }
    : {
        call: {
          id: `call_${randomUUID()}`,
          name: 'shell',
          input: { command: 'echo go > started.txt; sleep 1.5; echo end > ended.txt' },
        },
      };
/** What `open` was at each sample while the command ran. */
const sampled = async () => {
  const kept = scopes();
  fake.script.reply = sleeper;
  const workspace = await workspaceOf();
  const exists = (name: string) =>
    readFile(join(workspace, name)).then(
      () => true,
      () => false,
    );
  const samples: number[] = [];
  const timer = setInterval(() => {
    void (async () => {
      if ((await exists('started.txt')) && !(await exists('ended.txt'))) samples.push(kept.open);
    })();
  }, 50);
  try {
    const c = conversation(opencode.chat({ workspace }), 'shell', undefined, {
      working: kept.working,
    });
    expect(await c.attempt('inv1', 'Sleep')).toBe('Slept');
  } finally {
    clearInterval(timer);
  }
  expect(kept.open).toBe(0);
  return samples;
};

describe.skipIf(!NODE_24)("the OpenCode agent's scopes of ctx.working", () => {
  /** The tools' input: nothing. */
  const NOTHING = z.object({});
  /** What a tool saw of the scopes, as it ran: `[name, open]`. */
  const seen: [string, number][] = [];
  const watched = (kept: ReturnType<typeof scopes>) => [
    tool({
      name: 'plain',
      description: 'A tool that is not kept alive',
      input: NOTHING,
      run: async () => (seen.push(['plain', kept.open]), 'plain done'),
    }),
    tool({
      name: 'long',
      description: 'A tool that is kept alive',
      input: NOTHING,
      keepalive: true,
      run: async () => (seen.push(['long', kept.open]), 'long done'),
    }),
  ];
  beforeEach(() => {
    seen.length = 0;
  });

  it('keeps the attempt alive as the model answers, and a tool only if it says so', async () => {
    const kept = scopes();
    const requests: number[] = [];
    fake.script.reply = calling(['plain', 'long'], requests, kept);
    const c = conversation(opencode.chat({ tools: watched(kept) }), 'scopes', undefined, { working: kept.working });
    expect(await c.attempt('inv1', 'Go')).toBe('All done');
    // Every request of the model ran in a scope.
    expect(requests).toHaveLength(3);
    expect(requests.every((open) => open > 0)).toBe(true);
    // The plain tool ran with none. The tool kept alive ran with exactly one: its own scope (the turn's is
    // paused while any tool runs, as OpenCode has no hook to tell which of them keeps itself alive).
    expect(seen).toEqual([
      ['plain', 0],
      ['long', 1],
    ]);
    expect(kept.open).toBe(0);
  }, 60_000);

  it('holds no scope once a turn is stopped', async () => {
    const kept = scopes();
    const chat = handlerOf(opencode.chat({ tools: [] }));
    const entered = Promise.withResolvers<void>();
    const sql = sqlAttempt({ map: new Map(), key: 'scopes-stopped', id: 'inv1', working: kept.working });
    // The model's reply never comes, as the turn is stopped.
    fake.script.reply = () => {
      entered.resolve();
      throw new Error('stopped');
    };
    const answering = sql.end(() => chat(sql.ctx, 'Go'));
    answering.catch(() => {});
    await entered.promise;
    expect(kept.open).toBeGreaterThan(0);
    sql.cancel();
    await answering.catch(() => {});
    expect(kept.open).toBe(0);
  }, 60_000);

  it('holds no scope while a turn waits for an approval, nor once it is stopped there', async () => {
    const kept = scopes();
    fake.script.reply = runner;
    const workspace = await workspaceOf();
    const chat = handlerOf(opencode.chat({ workspace, approval: true, plugins: [askShell] }));
    const asked = Promise.withResolvers<void>();
    const open: number[] = [];
    const sql = sqlAttempt({
      map: new Map(),
      key: 'scopes-approval',
      id: 'inv1',
      working: kept.working,
      signal: () => {
        open.push(kept.open);
        asked.resolve();
        return new Promise(() => {});
      },
    });
    const answering = sql.end(() => chat(sql.ctx, 'Run it'));
    answering.catch(() => {});
    await asked.promise;
    // Even OpenCode's shell, kept alive, waits for its approval outside a scope.
    expect(open).toEqual([0]);
    expect(kept.open).toBe(0);
    sql.cancel();
    await expect(answering).rejects.toBeInstanceOf(restate.CancelledError);
    expect(kept.open).toBe(0);
  }, 60_000);

  it("runs OpenCode's shell in the turn's scope", async () => {
    const samples = await sampled();
    expect(samples.length).toBeGreaterThan(5);
    expect(samples.every((open) => open === 1)).toBe(true);
  }, 60_000);
});
