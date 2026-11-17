// Restate's side of a session object's attempt, played with wire bytes: it
// holds the object's state, answers the attempt's reads, stores its writes,
// acks what asks to be acked, answers its calls, and can cancel the
// invocation or shut the attempt down at a moment a test chooses. Shared by
// the tests that serve a handler with `serveSession` (`handler.test.ts`,
// `saga.test.ts`, `transaction-cancel.test.ts`).
import { HEAD_KEY } from '@restatedev/sessions/internal';
import { CancelledError } from '@restatedev/restate-sdk';
import { serveSession, type Stream } from '../src/handler.ts';
import { bytes, decode, field, frame, uint } from './wire.ts';
import { messages, REQUESTED_ACK, TYPE as BASE, V8, value, type Message } from './vm-support.ts';

export const TYPE = {
  ...BASE,
  getStateKeys: 0x0406,
  getStateKeysCompletion: 0x8006,
  run: 0x0411,
  oneWayCall: 0x040e,
  sendSignal: 0x0410,
} as const;

export const text = (b: Uint8Array | undefined) => (b === undefined ? undefined : Buffer.from(b).toString());

/** A call or a send the attempt made, as it went on the wire. */
export interface Made {
  service: string;
  handler: string;
  key: string;
  idempotencyKey: string | undefined;
  /** The input, as the text of its bytes. */
  input: string;
  /** The invocation id Restate gave a call; a send's is never answered here. */
  id?: string;
}

/** What the attempt asked Restate for, which Restate answers: a state read (of its key), an ack, or a call's result. */
export type Ask = `read ${string}` | 'ack' | `call ${string}`;

export interface SideOptions {
  /**
   * Restate cancels the invocation once, instead of nothing, as it acks the
   * attempt's first commit (`true`) or its N-th (a number, from 1).
   */
  cancelOnCommit?: boolean | number;
  /** A retry of a cancelled invocation: the signal is among the earlier attempts' entries. */
  cancelAtStart?: boolean;
  /**
   * Restate cancels the invocation just before it answers the N-th thing the
   * attempt asks for (from 1; see {@link Ask}), and answers it only once the
   * attempt has taken the signal in.
   */
  cancelBeforeAnswer?: number;
  /** The N-th thing the attempt asks for (from 1) is never answered: a test shuts the attempt down meanwhile. */
  withholdAnswer?: number;
  /**
   * Start the invocation with only the database's head preloaded, as
   * production does, so that the attempt reads every other key from Restate.
   */
  lazy?: boolean;
  /** Calls to these targets (`Service/handler`) get their id, and their result only once {@link release}d. */
  hold?: string[];
  /** Calls to these targets (`Service/handler`) fail with this terminal failure. */
  fail?: Record<string, { code: number; message: string }>;
  /** Give each call an invocation id of its own (`inv_<n>`), rather than `inv_started` for all. */
  idPerCall?: boolean;
}

const signal = () => frame(TYPE.signal, [...uint(2, 1), ...bytes(4, [])]);

/** Let the event loop run for `ms`, so the attempt takes in what it was sent. */
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A call or a send of `message`, as {@link Made} has it. */
function made(message: Message, keyField: number, idempotencyField: number): Made {
  const string = (n: number) => text(message.fields.get(n)?.[0] as Uint8Array | undefined);
  return {
    service: string(1)!,
    handler: string(2)!,
    key: string(keyField) ?? '',
    idempotencyKey: string(idempotencyField),
    input: string(3) ?? '',
  };
}

/**
 * Restate's side: it holds the object's state, answers the reads, applies the
 * writes, and acks the commands that asked to be acked.
 */
export function restateSide(state = new Map<string, Uint8Array>(), options: SideOptions = {}) {
  const { cancelOnCommit = false, cancelAtStart = false, cancelBeforeAnswer, lazy = false } = options;
  const holding = new Set(options.hold ?? []);
  const chunks: Uint8Array[] = [];
  let resolveChunk: (() => void) | undefined;
  let closed = false;
  /**
   * The journal index of the last command seen. Restate numbers *every*
   * command, so an ack must count the calls too, not only the writes.
   */
  let index = 0; // the input is the journal's first command, at index 0

  const inbound: Uint8Array[] = [];
  const toSdk = {
    push(chunk: Uint8Array) {
      inbound.push(chunk);
      resolveChunk?.();
      resolveChunk = undefined;
    },
    close() {
      closed = true;
      resolveChunk?.();
      resolveChunk = undefined;
    },
  };

  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (inbound.length > 0) yield inbound.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => (resolveChunk = resolve));
      }
    },
  };

  let head: { status: number; headers: Record<string, string> } | undefined;
  let ended = false;
  /** How many of the attempt's messages have been answered. */
  let answered = 0;
  /** Whether the one cancel signal has been sent (`cancelOnCommit`, `cancelBeforeAnswer`, `cancel()`). */
  let signalled = false;
  /** How many commits have been acked, for `cancelOnCommit`. */
  let acked = 0;
  /** What the attempt asked for, in order. */
  const asks: Ask[] = [];
  /** The calls and sends the attempt made, and the invocations it cancelled. */
  const calls: Made[] = [];
  const sends: Made[] = [];
  const cancels: string[] = [];
  /** The answers withheld, by target, oldest first. */
  const held = new Map<string, { result: number; input: string }[]>();
  /** How many of the attempt's messages were out when the signal went in. */
  let signalledAt: number | undefined;

  const stream: Stream = {
    headers: { 'content-type': V8 },
    body,
    writeHead: (status, headers) => void (head = { status, headers }),
    write: (chunk) => void chunks.push(chunk),
    close: () => void (ended = true),
  };
  const sent = () => messages(Buffer.concat(chunks));
  const cancelNow = () => {
    signalled = true;
    signalledAt = sent().length;
    toSdk.push(signal());
  };
  const answer = (result: number, input: string) =>
    toSdk.push(frame(TYPE.callCompletion, [...uint(1, result), ...field(5, 2, value(input))]));

  /**
   * Before answering what the attempt asked for, the signal if this ask is
   * the one; whether to answer it.
   */
  const asked = async (ask: Ask) => {
    asks.push(ask);
    if (options.withholdAnswer === asks.length) return false;
    if (cancelBeforeAnswer === asks.length && !signalled) {
      cancelNow();
      // The one bounded wait: the signal and the answer would otherwise reach
      // the attempt in one turn, and it must take the signal in with the
      // answer still outstanding.
      await pause(20);
    }
    return true;
  };

  return {
    stream,
    get head() {
      return head;
    },
    get ended() {
      return ended;
    },
    /** Everything the attempt wrote, as messages. */
    sent,
    /** What the attempt asked Restate for, in order: see {@link Ask}. */
    asks,
    /** The calls the attempt made, in order. */
    calls,
    /** The sends the attempt made, in order. */
    sends,
    /** The invocation ids the attempt sent a cancellation to, in order. */
    cancels,
    /** How many of the attempt's messages were out when the signal went in. */
    get signalledAt() {
      return signalledAt;
    },
    /** Start the invocation for `key` with `input`. */
    start(key: string, input: unknown) {
      // Lazy, only the head is known: the attempt reads the rest from Restate.
      const known = lazy ? [...state].filter(([k]) => k === HEAD_KEY) : [...state];
      toSdk.push(
        frame(TYPE.start, [
          ...bytes(1, [1, 2, 3, 4]),
          ...bytes(2, 'inv_test'),
          // Known entries: the input, and for a retry of a cancelled
          // invocation the signal the earlier attempt got. Restate sends
          // every attempt the entries of the ones before it, and the VM is
          // not ready to execute until it has them.
          ...uint(3, cancelAtStart ? 2 : 1),
          ...known.flatMap(([k, v]) => field(4, 2, [...bytes(1, k), ...bytes(2, [...v])])),
          ...(lazy ? uint(5, 1) : []),
          ...bytes(6, key),
        ]),
      );
      toSdk.push(frame(TYPE.input, bytes(14, value(JSON.stringify(input)))));
      // A retry of a cancelled invocation: the signal is among the entries of
      // the earlier attempts, so the VM knows before the handler starts.
      if (cancelAtStart) toSdk.push(signal());
    },
    /**
     * Restate cancels the invocation now. Called while the handler works
     * outside Restate, nothing of the attempt is waiting and the
     * cancellation is carried to its next wait.
     */
    cancel() {
      cancelNow();
    },
    /**
     * Restate closes the request body while the handler runs, as its
     * inactivity timeout does: the attempt is shut down.
     */
    shutDown() {
      toSdk.close();
    },
    /** Answer the oldest withheld call to `target` (`Service/handler`), echoing its input. */
    release(target: string) {
      const next = held.get(target)?.shift();
      if (next === undefined) throw new Error(`no call to ${target} is withheld`);
      answer(next.result, next.input);
    },
    /** Wait until `condition` holds, polling, or fail after `ms`. */
    async until(condition: () => boolean, what: string, ms = 10_000) {
      const deadline = Date.now() + ms;
      while (!condition()) {
        if (Date.now() >= deadline) throw new Error(`waited ${ms}ms for ${what}`);
        await pause(1);
      }
    },
    /**
     * Answer what the attempt asks for until it ends, then close the request
     * body. Closing it earlier is what Restate's inactivity timeout does, and
     * would shut the attempt down.
     */
    async settle({ ms = 20_000 } = {}) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (ended || closed || Date.now() >= deadline) break;
        await pause(1);
        const out = sent();
        for (const message of out.slice(answered)) {
          answered++;
          // Commands are journaled and numbered; ephemeral commands (0x02xx)
          // and notifications (0x8xxx) are not.
          if (message.type >= 0x0400 && message.type < 0x8000) {
            index++;
            // Restate acks a command only if it asked to be acked, and the
            // ack of one covers every command before it. Acking the rest
            // would answer a commit that is still waiting.
            if ((message.flags & REQUESTED_ACK) !== 0) {
              acked++;
              // A withheld ack still stores the command, below.
              if (await asked('ack')) {
                // Cancelling instead of acking is a cancellation that lands
                // with the database waiting on Restate. Restate signals a
                // cancellation once, not on every commit: what follows it is
                // acked as usual.
                const on = cancelOnCommit === true ? 1 : cancelOnCommit === false ? 0 : cancelOnCommit;
                if (acked === on && !signalled) cancelNow();
                toSdk.push(frame(TYPE.commandAck, uint(1, index)));
              }
            }
          }
          if (message.type === TYPE.getStateEphemeral) {
            const key = text(message.fields.get(2)?.[0] as Uint8Array)!;
            const id = message.fields.get(1)![0] as number;
            if (!(await asked(`read ${key}`))) continue;
            const stored = state.get(key);
            toSdk.push(
              frame(TYPE.getStateEphemeralNotification, [
                ...uint(1, id),
                ...(stored === undefined ? field(4, 2, []) : field(5, 2, value(stored))),
              ]),
            );
          } else if (message.type === TYPE.setState) {
            const key = text(message.fields.get(1)?.[0] as Uint8Array)!;
            const wrapped = decode(message.fields.get(3)![0] as Uint8Array);
            state.set(key, wrapped.get(1)![0] as Uint8Array);
          } else if (message.type === TYPE.clearState) {
            state.delete(text(message.fields.get(1)?.[0] as Uint8Array)!);
          } else if (message.type === TYPE.oneWayCall) {
            sends.push(made(message, 6, 7));
          } else if (message.type === TYPE.sendSignal) {
            cancels.push(text(message.fields.get(1)![0] as Uint8Array)!);
          } else if (message.type === TYPE.call) {
            const call = made(message, 5, 6);
            const target = `${call.service}/${call.handler}`;
            const id = options.idPerCall ? `inv_${calls.length + 1}` : 'inv_started';
            calls.push({ ...call, id });
            toSdk.push(
              frame(TYPE.callInvocationIdCompletion, [
                ...uint(1, message.fields.get(10)![0] as number),
                ...bytes(16, id),
              ]),
            );
            const result = message.fields.get(11)![0] as number;
            const failure = options.fail?.[target];
            // A call to key `k` is never answered: that is what a `start()`ed
            // call, whose result nobody holds, looks like to the handler.
            if (call.key === 'k') continue;
            if (holding.has(target)) {
              held.set(target, [...(held.get(target) ?? []), { result, input: call.input }]);
              continue;
            }
            if (!(await asked(`call ${target}`))) continue;
            if (failure === undefined) answer(result, call.input);
            else
              toSdk.push(
                frame(TYPE.callCompletion, [
                  ...uint(1, result),
                  ...field(6, 2, [...uint(1, failure.code), ...bytes(2, failure.message)]),
                ]),
              );
          } else if (message.type === TYPE.getStateKeys) {
            const id = message.fields.get(11)![0] as number;
            toSdk.push(
              frame(TYPE.getStateKeysCompletion, [
                ...uint(1, id),
                ...field(
                  5,
                  2,
                  [...state.keys()].flatMap((k) => bytes(1, k)),
                ),
              ]),
            );
          }
        }
        // The attempt is over once it has said so; nothing more will come.
        if (out.some((m) => m.type === TYPE.end || m.type === TYPE.error)) break;
      }
      // Shut down by the test: the attempt ends without a word.
      if (closed) return;
      if (!ended && !sent().some((m) => m.type === TYPE.end || m.type === TYPE.error)) {
        // Closing the body here is what Restate's inactivity timeout does, and
        // the attempt would report a shutdown — which reads as a puzzling
        // assertion failure rather than as the hang it is.
        throw new Error(`the attempt did not end within ${ms}ms`);
      }
      toSdk.close();
    },
    state,
  };
}

export type Side = ReturnType<typeof restateSide>;

/** How `step` ended: `ok`, or the name of what it failed with. */
export async function said(step: () => Promise<unknown>): Promise<string> {
  try {
    await step();
    return 'ok';
  } catch (error) {
    return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
  }
}

/**
 * The state an earlier invocation of `key` left, which ran `handler` of
 * `definition` with `input`: its schema is applied. On a key never written,
 * an attempt's first commit is the schema's, made as the session opens. After
 * this, it is the handler's own.
 */
export async function seeded(
  definition: { name: string },
  handler: string,
  key: string,
  input: unknown = null,
): Promise<Map<string, Uint8Array>> {
  const state = new Map<string, Uint8Array>();
  const r = restateSide(state);
  const serving = serveSession(definition, handler, r.stream);
  r.start(key, input);
  await r.settle();
  await serving;
  return state;
}

/** How many of the attempt's commands asked for an ack: a commit each. */
export const commits = (sent: Message[]) =>
  sent.filter((m) => m.type >= 0x0400 && m.type < 0x8000 && (m.flags & REQUESTED_ACK) !== 0).length;

/** How the invocation ended: its output's value as text, or its failure. */
export function outcome(sent: Message[]): { value: string } | { code: number; message: string } | undefined {
  const output = sent.find((m) => m.type === TYPE.output);
  if (output === undefined) return undefined;
  const ok = output.fields.get(14)?.[0] as Uint8Array | undefined;
  if (ok !== undefined) return { value: text(decode(ok).get(1)![0] as Uint8Array)! };
  const failure = decode(output.fields.get(15)![0] as Uint8Array);
  return { code: failure.get(1)![0] as number, message: text(failure.get(2)?.[0] as Uint8Array) ?? '' };
}

/** Run `handler` of `definition` once on `state` for `key`, answering everything: its outcome. */
export async function run(
  definition: { name: string },
  handler: string,
  state: Map<string, Uint8Array>,
  key: string,
  input: unknown = null,
) {
  const r = restateSide(state);
  const serving = serveSession(definition, handler, r.stream);
  r.start(key, input);
  await r.settle();
  await serving;
  return outcome(r.sent());
}
