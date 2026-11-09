// Test support for the agents, without a Restate server: an attempt of an
// agent's handler with the `signals` object, and a conversation with a ledger
// that records its calls, through crashes of the handler.
import { expect } from 'vitest';
import * as restate from '@restatedev/sessions';
import { tool, type Tool } from '@restatedev/agents';
import { type AttemptContext, contextOf } from '@restatedev/sessions/internal';
import { type AttemptOptions, sqlAttempt as baseAttempt } from '@restatedev/sessions/test/support';
import { z } from 'zod';
import type { Audit, Transfer } from '@restatedev/sessions/test/ledger';

/**
 * The `signals` object of an agent's tests, as far as following goes: the
 * message being answered, the turns closed, and how often the conversation
 * was published.
 */
export class Following {
  /** The conversation's revision: how often it was published. */
  revision = 0;
  /** Each turn closed, by its invocation id. */
  readonly closed: string[] = [];
  /** The message being answered, from its turn's start to its close, whether its agent settles it, and whether it takes steered messages. */
  answering: { invocationId: string; since: string; settles?: boolean; steers?: boolean } | null = null;
  /** Each turn the companion would have its agent `settle`: closed as gone, by its invocation id. */
  readonly settled: string[] = [];
  /**
   * The messages steered to the turn being answered that it has not taken
   * yet: each `publish` answers them to a turn that takes steered messages,
   * as the companion's does.
   */
  steering: { id: string; text: string }[] = [];
  /** The ids of each `taken` the turns sent, in order. */
  readonly taken: string[][] = [];
}

/** The following of each object's state. */
const followings = new WeakMap<Map<string, Uint8Array>, Following>();

/** The following of the object of state `map`. */
export const followingOf = (map: ReadonlyMap<string, Uint8Array>) => {
  const object = map as Map<string, Uint8Array>;
  if (!followings.has(object)) followings.set(object, new Following());
  return followings.get(object)!;
};

/** A call or send an attempt makes, as the SDK gets it (`ctx.rpc`, `ctx.send`). */
export interface Made {
  service: string;
  method: string;
  key?: string;
  parameter: unknown;
  idempotencyKey?: string;
}

/** A call as the SDK gets it, but its serdes. */
const made = (c: Made): Made => ({
  service: c.service,
  method: c.method,
  key: c.key,
  parameter: c.parameter,
  idempotencyKey: c.idempotencyKey,
});

/**
 * An attempt of a handler, @restatedev/sessions's own, with the `signals` object
 * of following over `map`: `ctx`, a handler's context, and `view`, a view's.
 * `route` answers the calls to anything but `signals`.
 */
export function sqlAttempt(
  options: AttemptOptions & {
    route?: (call: Made) => Promise<unknown>;
    /** What the companion's `wait` answers a wait with: by default, it waits forever. */
    signal?: (wait: { id: string; name: string; input?: unknown }) => unknown;
    /** Run at each publish, before it answers: a follower reading the conversation, say. */
    published?: () => Promise<void>;
  },
) {
  const following = followingOf(options.map);
  // A transaction's sends to the companion (`taken`), made from its outbox as it commits, reach the companion here.
  const base = baseAttempt({
    ...options,
    send: (sent) => {
      if (sent.service === 'signals') void route(sent);
      options.send?.(sent);
    },
  });
  // The `signals` object, as the agents call it.
  const signals: Record<string, (input: never) => unknown> = {
    publish: async () => {
      await options.published?.();
      const revision = ++following.revision;
      const steering = following.answering?.steers ? following.steering : [];
      return steering.length > 0 ? { revision, steering: [...steering] } : { revision };
    },
    // A transaction's send: its parameter as it was stored, JSON.
    taken: (parameter: Uint8Array | string[]) => {
      const ids = (
        parameter instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(parameter)) : parameter
      ) as string[];
      following.taken.push(ids);
      following.steering = following.steering.filter((m) => !ids.includes(m.id));
      following.revision++;
    },
    start: (turn: { invocationId: string; since: string; settles?: boolean; steers?: boolean }) => {
      if (following.answering?.invocationId === turn.invocationId) return;
      if (following.answering) closed(following.answering.invocationId, true);
      following.answering = turn;
    },
    // As the companion's: a turn's close publishes it.
    close: (turn: string) => closed(turn),
    ended: (turn: string) => closed(turn, true),
    wait: (wait: { id: string; name: string; input?: unknown }) =>
      options.signal ? options.signal(wait) : new Promise(() => {}),
  };
  /** As the companion's close: a gone turn that settles is sent to its agent's `settle`. */
  function closed(turn: string, gone = false) {
    if (following.answering?.invocationId === turn) {
      if (gone && following.answering.settles) following.settled.push(turn);
      following.answering = null;
    }
    following.closed.push(turn);
    following.revision++;
  }
  const route = (c: Made) => {
    if (c.service !== 'signals') {
      if (options.route) return options.route(made(c));
      throw new Error(`no ${c.service} in this test`);
    }
    const method = signals[c.method];
    if (!method) throw new Error(`no signals.${c.method} in this test`);
    return method(c.parameter as never);
  };
  const sdk = {
    key: options.key ?? 'k',
    request: () => ({
      ...base.request(),
      target: { service: options.object?.name ?? options.service ?? 'agent', key: options.key ?? 'k', handler: 'chat' },
    }),
    genericCall: async (c: Made) => route(c),
    genericSend: (c: Made) => void route(c),
    cancellation: base.cancellation,
    cancelPreviousCalls: base.cancelPreviousCalls,
    invocation: (id: string) => ({ cancel: () => options.cancel?.(id) }),
  } as unknown as AttemptContext;
  // A chat handler's: with explicit cancellation.
  const definition = options.object;
  const ctx = contextOf(sdk, base.db, { explicitCancellation: true, definition });
  return { ...base, ctx, view: contextOf(sdk, base.db, { view: true, definition }) };
}

/** A handler: a function, or one with options (as `chat()` gives). */
export type Entry<F> = F | { handler: F };

/** A chat handler, or a handler with options (`chat()`'s): its function. */
export const handlerOf = <F>(entry: F | { handler: F }): F =>
  typeof entry === 'function' ? entry : (entry as { handler: F }).handler;

export type PromptHandler =
  | ((ctx: restate.SessionContext, message: string) => Promise<string>)
  | { handler: (ctx: restate.SessionContext, message: string) => Promise<string> };

/** A wait for a signal, as the companion's `wait` gets it. */
export interface Wait {
  id: string;
  name: string;
  input?: unknown;
}

/** The fake ledger of a conversation. */
export interface FakeLedger {
  /** Each transfer, once, by id. */
  transfers: Map<string, Transfer>;
  /** Each call to `transfer`, with its idempotency key. */
  calls: { name: 'transfer'; id: string; key: string | undefined }[];
  /** The next transfers are recorded, and their attempts stop there. */
  crashNext: number;
  /** The next transfers are recorded, and then throw. */
  failNext: number;
  /** Called when an attempt stops in a transfer. */
  crashed: () => void;
}

/**
 * An agent's conversation, the object with key `key` whose handler is
 * `handler`: its database lives across attempts, like the object's state.
 *
 * A crash is an attempt that stops in a transfer and is abandoned: what it
 * stored stays, as with a crashed process, and the handler gets no chance to
 * store anything on the way out. Like Restate, the next attempt fences it, so
 * it stores nothing afterwards.
 */
export function conversation(
  handler: PromptHandler,
  key: string,
  from?: { state: ReadonlyMap<string, Uint8Array>; ledger: FakeLedger },
) {
  // From another conversation: a copy of its state.
  const map = new Map<string, Uint8Array>(from?.state);
  let fence: { closed: boolean } = { closed: false };
  // Ends the attempt before: Restate fences it once the next one starts.
  let abort: (() => void) | undefined;
  const ledger: FakeLedger = { transfers: new Map(), calls: [], crashNext: 0, failNext: 0, crashed: () => {} };
  /** Each call the attempts made, but a fenced one's. */
  const calls: Made[] = [];
  // The books as an attempt calls them: a fenced (crashed) attempt's calls
  // never reach them, as a dead process's do not.
  const booksOf = (attempt: { closed: boolean }) => ({
    async transfer(transfer: Transfer, idempotencyKey: string | undefined) {
      if (attempt.closed) return new Promise<Transfer>(() => {});
      ledger.calls.push({ name: 'transfer', id: transfer.id, key: idempotencyKey });
      if (!ledger.transfers.has(transfer.id)) ledger.transfers.set(transfer.id, transfer);
      const applied = ledger.transfers.get(transfer.id)!;
      if (ledger.crashNext > 0) {
        ledger.crashNext--;
        ledger.crashed();
        return new Promise<Transfer>(() => {});
      }
      if (ledger.failNext > 0) {
        ledger.failNext--;
        throw new Error('crash after the transfer');
      }
      return applied;
    },
    async audit(): Promise<Audit> {
      return { accounts: 8, total: 8000, transfers: ledger.transfers.size, inconsistent: 0 };
    },
  });
  if (from) for (const [id, transfer] of from.ledger.transfers) ledger.transfers.set(id, transfer);
  // The companion's waits: each wait the attempts made, but a fenced one's, and what answers them.
  const signals: { waits: Wait[]; answer?: (wait: Wait) => unknown } = { waits: [] };
  return {
    ledger,
    /**
     * Each wait for a signal the attempts made (`waits`), but a fenced
     * attempt's, and what the companion answers a wait with (`answer`): by
     * default, it waits forever.
     */
    signals,
    /** Each call the attempts made to the books (`transfer` or else `audit`), but a fenced attempt's. */
    calls: calls as readonly Made[],
    /** The object's state. */
    state: map as ReadonlyMap<string, Uint8Array>,
    /**
     * One attempt of the handler, as Restate makes it, with request id
     * `requestId`; with `crashAt`, it crashes at that state request (from 1),
     * and is abandoned there.
     */
    async attempt(requestId: string, prompt: string, crashAt?: number) {
      fence.closed = true;
      fence = { closed: false };
      const current = fence;
      abort?.();
      let requests = 0;
      const crashed = Promise.withResolvers<'crashed'>();
      const onRequest = () => {
        if (++requests !== crashAt) return;
        current.closed = true;
        crashed.resolve('crashed');
        throw new Error('crash at a state request');
      };
      const books = booksOf(current);
      const route = async (call: Made) => {
        if (!current.closed) calls.push(call);
        return call.method === 'transfer'
          ? books.transfer(call.parameter as Transfer, call.idempotencyKey)
          : books.audit();
      };
      const signal = (wait: Wait) => {
        if (current.closed) return new Promise(() => {});
        signals.waits.push(wait);
        return signals.answer ? signals.answer(wait) : new Promise(() => {});
      };
      const sql = sqlAttempt({ map, fence, key, id: requestId, onRequest, route, signal });
      abort = sql.abort;
      const answer = sql.end(() => handlerOf(handler)(sql.ctx, prompt));
      if (crashAt === undefined) return answer;
      answer.catch(() => {});
      return Promise.race([crashed.promise, answer]);
    },
    /**
     * A view of the object (such as `messages`), with `input`, in an
     * attempt of its own: it reads beside an attempt that runs, if any.
     */
    async read<T, I>(other: (ctx: restate.ViewContext, input: I) => Promise<T>, input?: I, requestId = 'read') {
      const sql = sqlAttempt({ map, key, id: requestId, shared: true });
      return sql.end(() => other(sql.view, input as I));
    },
    /** An attempt that crashes in its next transfer. */
    async crash(requestId: string, prompt: string) {
      ledger.crashNext = 1;
      const crashed = new Promise<void>((resolve) => (ledger.crashed = resolve));
      const attempt = this.attempt(requestId, prompt);
      await Promise.race([crashed, attempt.then(() => Promise.reject(new Error('did not crash')))]);
    },
  };
}

/** A tool call of `messages`, by `name`, with any id. */
const toolCall = (name: string, input: unknown, output: string) => ({
  type: 'tool',
  id: expect.any(String),
  name,
  input,
  output,
});

/** The messages of the bank conversation of the agents' tests: a transfer, then an audit. */
export const SAID = [
  { role: 'user', parts: [{ type: 'text', text: 'Please move 5 from 1 to 2' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'text', text: 'On it.' },
      toolCall('transfer', { from: 1, to: 2, amount: 5 }, 'moved 5 from account 1 to account 2'),
    ],
  },
  { role: 'assistant', parts: [{ type: 'text', text: 'Done: moved 5 from account 1 to account 2' }] },
  { role: 'user', parts: [{ type: 'text', text: 'audit the books' }] },
  {
    role: 'assistant',
    parts: [toolCall('audit', {}, '{"accounts":8,"total":8000,"transfers":1,"inconsistent":0}')],
  },
  {
    role: 'assistant',
    parts: [{ type: 'text', text: 'Done: {"accounts":8,"total":8000,"transfers":1,"inconsistent":0}' }],
  },
].map((m, id) => ({ id, role: m.role, parts: m.parts }));

/**
 * {@link SAID} as a framework on the conversation of turns gives it: each
 * message's id is its position, and the rows that only add to a message
 * (tool results) take positions of their own.
 */
export const SAID_IN_TURNS = SAID.map(({ role, parts }, i) => ({ id: [0, 1, 3, 4, 5, 7][i]!, role, parts }));

/**
 * What goes wrong when `prompt` crashes at a state request of a message and
 * is retried, at every `stride`th request (CRASH_STRIDE, default 3), some at
 * once, until it answers without crashing: each should answer it, with one transfer, and one
 * stored prompt in `messages`. From a conversation with a message before.
 */
export async function crashedAnywhere(
  prompt: PromptHandler,
  messages: (
    ctx: restate.ViewContext,
    request: object,
  ) => Promise<{ messages: { role: string; parts: { type: string; text?: string }[] }[] }>,
  {
    stride = Number(process.env.CRASH_STRIDE ?? 3),
    concurrency = 8,
  }: {
    /** Crash at every `stride`th state request. */
    stride?: number;
    /** How many crash points at once; 1 for a model fake that is not safe to share. */
    concurrency?: number;
  } = {},
) {
  const before = conversation(prompt, 'anywhere');
  await before.attempt('inv0', 'Please move 1 from 3 to 4');
  const crashAt = async (n: number) => {
    const c = conversation(prompt, 'anywhere', before);
    if ((await c.attempt('inv1', 'Please move 5 from 1 to 2', n)) !== 'crashed') return 'finished';
    const answer = await Promise.race([
      c.attempt('inv1', 'Please move 5 from 1 to 2'),
      new Promise((resolve) => setTimeout(() => resolve('no answer'), 10_000)),
    ]).catch((error: unknown) => String(error));
    const users = (await c.read(messages, {})).messages.filter((m) => m.role === 'user');
    const ok =
      answer === 'Done: moved 5 from account 1 to account 2' && c.ledger.transfers.size === 2 && users.length === 2;
    return ok ? 'ok' : `${n}: ${String(answer)}, ${c.ledger.transfers.size} transfers, ${users.length} prompts`;
  };
  // A batch at a time, until one answers without crashing.
  const wrong: string[] = [];
  for (let from = 1, done = false; !done; from += concurrency * stride) {
    const batch = await Promise.all(Array.from({ length: concurrency }, (_, i) => crashAt(from + i * stride)));
    wrong.push(...batch.filter((r) => r !== 'ok' && r !== 'finished'));
    done = batch.includes('finished');
  }
  return wrong;
}

/** A transfer whose invocation is cancelled while it runs (while it waits for an approval, say). */
export const cancelledTransfer = tool({
  name: 'transfer',
  description: 'Move money.',
  input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
  run: () => {
    throw new restate.CancelledError();
  },
});

/**
 * `chat` (with {@link cancelledTransfer}) on an object of its own: its first
 * message (a transfer) cancelled, then a second one, `Hello`. What the first
 * failed with, the second's answer, and the conversation then: each
 * message's parts.
 */
export async function afterCancel(
  chat: PromptHandler,
  messages: (ctx: restate.ViewContext, request: object) => Promise<{ messages: { parts: unknown[] }[] }>,
) {
  const map = new Map<string, Uint8Array>();
  const invoke = (id: string, input: string) => {
    const sql = sqlAttempt({ map, key: 'cancel', id });
    return sql.end(() => handlerOf(chat)(sql.ctx, input));
  };
  const failed = await invoke('inv1', 'Please move 5 from 1 to 2').then(
    () => undefined,
    (error: unknown) => error,
  );
  const answer = await invoke('inv2', 'Hello');
  const read = sqlAttempt({ map, key: 'cancel', id: 'read', shared: true });
  const page = await read.end(() => messages(read.view, {}));
  return { failed, answer, parts: page.messages.map((m) => m.parts) };
}

/**
 * `chat` (with `tools`) on an object of its own, its first message (a
 * transfer) cancelled while `transfer` runs (when it calls `started`), not
 * while a Restate call is pending: as during a model request.
 */
export async function cancelledWhileWorking(
  chat: (tools: Tool[]) => PromptHandler,
  messages: (ctx: restate.ViewContext, request: object) => Promise<{ messages: { parts: unknown[] }[] }>,
) {
  const map = new Map<string, Uint8Array>();
  const started = Promise.withResolvers<void>();
  const transfer = tool({
    name: 'transfer',
    description: 'Move money.',
    input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
    run: async () => {
      started.resolve();
      return new Promise<never>(() => {}); // as long as it takes
    },
  });
  const handler = handlerOf(chat([transfer]));
  const attempt = (id: string, shared = false) => {
    const sql = sqlAttempt({ map, key: 'cancel', id, shared });
    return { sql, ctx: sql.ctx, view: sql.view };
  };
  const first = attempt('inv1');
  const answering = first.sql.end(() => handler(first.ctx, 'Please move 5 from 1 to 2'));
  await started.promise;
  first.sql.cancel();
  const failed = await answering.then(
    () => undefined,
    (error: unknown) => error,
  );
  const second = attempt('inv2');
  const answer = await second.sql.end(() => handler(second.ctx, 'Hello'));
  const read = attempt('read', true);
  const page = await read.sql.end(() => messages(read.view, {}));
  return { failed, answer, parts: page.messages.map((m) => m.parts) };
}

/**
 * `chat` (with `tools`) on an object of its own, the attempt of its message
 * (a transfer) ended while `transfer` runs (as when Restate suspends it, or
 * loses its connection), then the next attempt of the same invocation: what
 * the first attempt failed with, the turns closed by then, and the answer.
 */
export async function endedWhileWorking(chat: (tools: Tool[]) => PromptHandler) {
  const map = new Map<string, Uint8Array>();
  const started = Promise.withResolvers<void>();
  const transfer = tool({
    name: 'transfer',
    description: 'Move money.',
    input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
    // The first attempt's never returns; the next one's does.
    run: async () => {
      if (fence.closed) return 'moved 5 from account 1 to account 2';
      started.resolve();
      return new Promise<never>(() => {});
    },
  });
  const handler = handlerOf(chat([transfer]));
  const fence = { closed: false };
  const first = sqlAttempt({ map, fence, key: 'ended', id: 'inv1' });
  const answering = first.end(() => handler(first.ctx, 'Please move 5 from 1 to 2'));
  await started.promise;
  fence.closed = true;
  first.abort();
  const failed = await answering.then(
    () => undefined,
    (error: unknown) => error,
  );
  const closed = [...followingOf(map).closed];
  const next = sqlAttempt({ map, key: 'ended', id: 'inv1' });
  const answer = await next.end(() => handler(next.ctx, 'Please move 5 from 1 to 2'));
  return { failed, closed, answer };
}

/**
 * `chat` (with `tools`) on an object of its own, its message a transfer:
 * its answer, the conversation then (each message's parts), and how often
 * the turn published its conversation.
 */
export async function followedWhileWorking(
  chat: (tools: Tool[]) => PromptHandler,
  messages: (ctx: restate.ViewContext, request: object) => Promise<{ messages: { parts: unknown[] }[] }>,
  { object }: { object?: { readonly name: string } } = {},
) {
  const map = new Map<string, Uint8Array>();
  const transfer = tool({
    name: 'transfer',
    description: 'Move money.',
    input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
    run: () => 'moved 5 from account 1 to account 2',
  });
  // What a follower reads at each publish: the transfer's output, once the page has its call.
  const outputs: unknown[] = [];
  const read = async () => {
    const reading = sqlAttempt({ map, key: 'follow', id: `read${outputs.length}`, shared: true, object });
    return reading.end(() => messages(reading.view, {}));
  };
  const published = async () => {
    const parts = (await read()).messages.flatMap((m) => m.parts) as { type: string; output?: unknown }[];
    const call = parts.find((p) => p.type === 'tool');
    if (call) outputs.push(call.output);
  };
  const turn = sqlAttempt({ map, key: 'follow', id: 'inv1', object, published });
  const answer = await turn.end(() => handlerOf(chat([transfer]))(turn.ctx, 'Please move 5 from 1 to 2'));
  const page = await read();
  return {
    answer,
    parts: withoutIds(page.messages.map((m) => m.parts)),
    published: followingOf(map).revision,
    outputs,
  };
}

/**
 * `chat` (with a `transfer` and an `audit` tool) on an object of its own,
 * asked to move 5 from 1 to 2: while the transfer runs, `audit the books`
 * is steered to the turn, which takes it at its next step. The model's next
 * request then ends with it, and the model audits: the turn's answer is the
 * audit's. With `failAudit`, the audit fails its first attempt (once the
 * message is stored, and the model asked again with it), and a retried
 * attempt goes on. The answer, the messages, the audits run, and the ids of
 * each `taken` the companion got.
 */
export async function steeredAtAStep(
  chat: (tools: Tool[]) => PromptHandler,
  messages: (
    ctx: restate.ViewContext,
    request: object,
  ) => Promise<{ messages: { role: string; parts: { type: string; text?: string; name?: string }[] }[] }>,
  { failAudit = false, object }: { failAudit?: boolean; object?: { readonly name: string } } = {},
) {
  const map = new Map<string, Uint8Array>();
  const following = followingOf(map);
  let failing = failAudit;
  let audits = 0;
  const tools = [
    tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: () => {
        // Sent to the turn while the tool runs: the companion lists it from the next publish on.
        if (!following.taken.flat().includes('steer-1')) {
          following.steering = [{ id: 'steer-1', text: 'audit the books' }];
        }
        return 'moved 5 from account 1 to account 2';
      },
    }),
    tool({
      name: 'audit',
      description: 'Check the books.',
      input: z.object({}),
      run: () => {
        audits += 1;
        if (failing) {
          failing = false;
          throw new Error('the books are busy');
        }
        return 'the books are fine';
      },
    }),
  ];
  const handler = handlerOf(chat(tools));
  const attempt = () => {
    const turn = sqlAttempt({ map, key: 'steer', id: 'inv1', object });
    return turn.end(() => handler(turn.ctx, 'Please move 5 from 1 to 2'));
  };
  const first = await attempt().then(
    (answer) => ({ answer }),
    (error: unknown) => ({ error }),
  );
  const answer = 'answer' in first ? first.answer : await attempt();
  const read = sqlAttempt({ map, key: 'steer', id: 'read', shared: true, object });
  const page = await read.end(() => messages(read.view, {}));
  return {
    answer,
    failed: 'error' in first ? first.error : undefined,
    audits,
    taken: [...new Set(following.taken.flat())],
    said: page.messages.map(({ role, parts }) => [
      role,
      parts.map((p) => (p.type === 'text' ? p.text : p.name)).join(' + '),
    ]),
  };
}

/** `parts` without their tool calls' ids, which differ from run to run. */
export const withoutIds = (parts: unknown[][]) =>
  parts.map((message) =>
    message.map((part) => {
      if (typeof part !== 'object' || part === null) return part;
      return Object.fromEntries(Object.entries(part).filter(([key]) => key !== 'id'));
    }),
  );

/**
 * `chat` (with `tools`) on an object of its own, asked to transfer 5 with a
 * `transfer` that takes at most 3: the model's arguments do not fit, which
 * is the model's to fix, not a failure of the attempt. Its answer (after the
 * tool's error), and whether `transfer` ran.
 */
export async function invalidArguments(chat: (tools: Tool[]) => PromptHandler) {
  let ran = false;
  const small = tool({
    name: 'transfer',
    description: 'Move money: at most 3.',
    input: z.object({ from: z.number(), to: z.number(), amount: z.number().max(3) }),
    run: () => {
      ran = true;
      return 'moved';
    },
  });
  const map = new Map<string, Uint8Array>();
  const sql = sqlAttempt({ map, key: 'invalid', id: 'inv1' });
  const answer = await sql.end(() => handlerOf(chat([small]))(sql.ctx, 'Please move 5 from 1 to 2'));
  return { answer, ran };
}
