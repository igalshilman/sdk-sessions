// The agentlib agent's virtual object: `chat`, which answers with agentlib's
// run, and the handlers and views that every agent here has.
import { GuardrailError } from '@restatedev/agentlib';
import { sdk as restate } from '@restatedev/sessions/internal';
import { type Messages, type MessagesRequest, messageSerde } from '../common.ts';
import {
  type Notifications,
  type Resolved,
  type Signal,
  type Steer,
  type Steered,
  type Waiting,
  type Watch,
  withCompanion,
} from '../companion.ts';
import type { Status, Stopped, Synced, SyncRequest } from '../object.ts';
import { readMessages } from './messages.ts';
import type { Definition, Options } from './options.ts';
import { Runtime } from './runtime.ts';
import {
  callOwn,
  companionAt,
  CONVERSATION_META,
  emptyMeta,
  META,
  type Meta,
  TAKEN,
} from './state.ts';

type Exclusive = restate.ObjectContext;
type Shared = restate.ObjectSharedContext;

/**
 * The options of every agentlib agent's object. An invocation starts with
 * the small keys only, not the whole conversation (each message is a key of
 * its own). It retries as every agent does: soon after a failure, then twice
 * as long each time, up to 10 seconds apart, for weeks.
 */
const OPTIONS = {
  state: { preload: [META, TAKEN, CONVERSATION_META] },
  retryPolicy: {
    initialInterval: 50,
    exponentiationFactor: 2,
    maxInterval: 10_000,
    maxAttempts: 100_000,
  },
} satisfies restate.ObjectOptions;

/** A handler that takes a message as plain text or as a JSON string. */
const TEXT_INPUT = { input: messageSerde, accept: '*/*' };

/**
 * An agent of agentlib: a virtual object `name` of the classic Restate SDK,
 * with one conversation per key, in its state. `chat` answers a message with
 * agentlib's run of the agent, journaled: after a crash, Restate replays it,
 * so a model call or a tool call that finished is not made again. It has the
 * views of every agent, and its companion, which `serve` serves beside it.
 *
 * A tool call that needs approval waits for the signal `approval`: `pending`
 * lists it, and `signal` approves it (`true`, `"approved"`, `{ "approved":
 * true }`) or denies it (anything else).
 */
export function agent<P extends string, O = string>(definition: Options<O> & Definition<P>) {
  const { name, description, background = false, options, metadata, ...agentOptions } = definition;
  checkOneSdk(name);
  const runtime = new Runtime<O>(name, background, agentOptions);

  const object = restate.object({
    name,
    description,
    metadata,
    handlers: {
      chat: restate.handlers.object.exclusive(TEXT_INPUT, (ctx: Exclusive, text: string) =>
        runtime.answer(ctx, text),
      ),
      steered: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        (ctx: Exclusive, message: Steer) => answerSteered(runtime, ctx, message),
      ),
      erase: restate.handlers.object.exclusive({ ingressPrivate: true }, erase),
      messages: restate.handlers.object.shared(messages),
      status: restate.handlers.object.shared(status),
      pending: restate.handlers.object.shared(pending),
      signal: restate.handlers.object.shared(signal),
      stop: restate.handlers.object.shared(stop),
      clear: restate.handlers.object.shared(clear),
      steer: restate.handlers.object.shared(TEXT_INPUT, steer),
      notifications: restate.handlers.object.shared(notifications),
      watch: restate.handlers.object.shared(watch),
      sync: restate.handlers.object.shared(sync),
    },
    options: { ...OPTIONS, ...options },
  });
  return withCompanion(object);
}

/**
 * Checks that agentlib runs on the same copy of the Restate SDK as
 * @restatedev/sessions. With two copies, agentlib's terminal errors are not
 * the SDK's `TerminalError`, so a failed turn would look retryable.
 */
function checkOneSdk(name: string) {
  // Anywhere up the chain: agentlib's errors may have their own base (0.2.0's
  // `GuardrailError` extends `ToolError`).
  if (GuardrailError.prototype instanceof restate.TerminalError) return;
  throw new Error(
    `${name}: @restatedev/agentlib runs on another copy of @restatedev/restate-sdk ` +
      'than @restatedev/sessions. Install @restatedev/restate-sdk@1.18.2 ' +
      '(the version @restatedev/sessions pins) beside them.',
  );
}

// The private handlers.

/**
 * A message steered to a turn (`steer`), which the companion sent here as it
 * came, so that it keeps its place in the key's queue: answered as a turn of
 * its own, unless the turn it was steered to took it.
 */
async function answerSteered<O>(runtime: Runtime<O>, ctx: Exclusive, { id, text }: Steer) {
  const taken = (await ctx.get<string[]>(TAKEN)) ?? [];
  if (!taken.includes(id)) {
    await runtime.answer(ctx, text);
    return;
  }
  const left = taken.filter((other) => other !== id);
  if (left.length > 0) ctx.set(TAKEN, left);
  else ctx.clear(TAKEN);
}

/**
 * `clear`'s work, once the messages before it are answered: forgets the
 * conversation. Its ids go on from where they got to.
 */
async function erase(ctx: Exclusive) {
  const meta = (await ctx.get<Meta>(META)) ?? emptyMeta();
  const next = meta.chats + (meta.live?.n ?? 0);
  ctx.clearAll();
  const cleared: Meta = { chats: next, cursor: meta.cursor + 1, first: next };
  ctx.set(META, cleared);
  await companionAt(ctx).reset();
}

// The views: they run beside the turn being answered.

/** The conversation, a page at a time, or what is new or changed since a cursor. */
async function messages(ctx: Shared, request?: MessagesRequest | null): Promise<Messages> {
  return readMessages(ctx, request ?? {});
}

/** What the agent is doing: the message it answers, its waits, and the messages steered to it. */
async function status(ctx: Shared): Promise<Status> {
  return companionAt(ctx).status();
}

/** The waits of the agent's tools. */
async function pending(ctx: Shared): Promise<Waiting[]> {
  return companionAt(ctx).pending();
}

/** Resolves the wait of an id, or else the oldest wait for a name. */
async function signal(ctx: Shared, wanted: Signal): Promise<Resolved> {
  return companionAt(ctx).resolve(wanted);
}

/** Cancels the invocation of the message being answered, and says which one, if any. */
async function stop(ctx: Shared): Promise<Stopped> {
  const turn = (await companionAt(ctx).status()).answering;
  if (!turn) return { stopped: null };
  ctx.cancel(restate.InvocationIdParser.fromString(turn.invocationId));
  return { stopped: turn.invocationId };
}

/** Stops the message being answered, then forgets the conversation. */
async function clear(ctx: Shared): Promise<Stopped> {
  const stopped = await stop(ctx);
  await callOwn(ctx, 'erase');
  return stopped;
}

/**
 * Sends a message to the turn being answered, which takes it at its next
 * step. Otherwise it is answered as a turn of its own.
 */
async function steer(ctx: Shared, text: string): Promise<Steered> {
  return companionAt(ctx).steer({ id: ctx.request().id, text });
}

/** The conversation's revision. */
async function notifications(ctx: Shared): Promise<Notifications> {
  return companionAt(ctx).notifications();
}

/** The revision, once there is one newer than `revision`, or at the timeout. */
async function watch(ctx: Shared, request: Watch): Promise<Notifications> {
  return companionAt(ctx).watch(request);
}

/**
 * The conversation since a cursor, the status and the revision. With
 * `revision`, it waits until there is a newer one.
 */
async function sync(ctx: Shared, request?: SyncRequest | null): Promise<Synced> {
  const { cursor = 0, revision, timeoutSeconds = 50, limit = 100, view } = request ?? {};
  if (revision !== undefined) await companionAt(ctx).watch({ revision, timeoutSeconds });

  // The revision first: a change after it shows in the next sync.
  const now = await companionAt(ctx).notifications();
  const current = await companionAt(ctx).status();
  // A call of its own: it reads the state as it is now, while this view
  // read its state as it started.
  const page: MessagesRequest = { cursor, limit };
  if (view) page.view = view;
  const changed = await callOwn<Messages>(ctx, 'messages', page);
  return { revision: now.revision, status: current, ...changed };
}
