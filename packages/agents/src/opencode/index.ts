// OpenCode 2.2 agents in Restate virtual objects: OpenCode for each
// invocation, with its database beside the object's.
//
//   const coder = opencode.agent({ name: 'coder', workspace: (ctx) => `/work/${ctx.key}` });
//
// or a handler of an object of your own: `handlers: { chat: opencode.chat() }`,
// with options for each invocation: `opencode.chat(async (ctx) => ({ workspace }))`
//
// or, for more than a prompt:
//
//   review: (ctx, task) => withOpenCode(ctx, { tools }, async ({ prompt }) => [await prompt(task), await prompt('Review it')]),
//
// The model is `model`, MODEL, or else openai/gpt-6-sol, which OpenCode's
// own providers serve, with the provider's API key (such as OPENAI_API_KEY).
//
// OpenCode keeps the model's history in a database of the key's own, beside
// `ctx.db` (db.ts): OpenCode boots only on a database that is empty or its
// own. Each prompt is a turn of the object's conversation (../conversation.ts):
// what clients read, and how turns end. What OpenCode stores of a turn (the
// model's replies, the tools' results) is copied into the turn after each of
// OpenCode's commits, in a `ctx.db` transaction of its own, idempotently (by
// OpenCode's message and part ids), and caught up before a tool call runs, the
// answer, and any close of the turn. A copy of steps (a reply with tool calls,
// tools' results) is published once it commits, and nothing else is: followers
// read the conversation then. OpenCode boots lazily, as a turn runs:
// an answered prompt's retry boots nothing.
//
// OpenCode records an execution claim as a turn starts, and every boot sweeps
// the claims left behind. Whose claim it is comes from `ctx.db`: the last
// prompt submitted to OpenCode is recorded there before its submit
// (`restate_agents_opencode`). A boot for that prompt (a retried attempt)
// resumes its turn, as OpenCode does; a boot for any other closes it without
// asking the model (OpenCode's resume budget, `maxAttempts: 0`), and the sweep
// is awaited before anything is submitted. A retried attempt whose turn holds
// its final reply (copied, or caught up from OpenCode before the boot that
// would resume) answers with it: OpenCode's turn is closed, not resumed, which
// would ask the model again. A turn another invocation left
// (killed) is closed in OpenCode first, then the copy catches up, then the
// conversation closes it (`settleOwn` of the items). The next prompt tells the
// model how the turn before it ended, and which of its calls did happen.
//
// A tool's error fails the attempt rather than hand the error to the model:
// from then on the attempt stores nothing (its fence closes), and the next
// attempt resumes the turn, in which OpenCode gives the cut-off call an
// "interrupted" result and the model makes it again under a new id.
//
// A provider's outage never ends the turn: OpenCode asks the model again,
// as its `session.retry` hook decides (`retryPlugin`: pi's backoff, not
// before the provider's `retry-after`), and an outage it would retry for the
// last time, or stops retrying (timeouts), fails the attempt instead, as a
// tool's error does: the next attempt resumes the turn. A refusal is never
// asked again, and ends the turn (424).
//
// A message steered to the turn (the agent's `steer` view, ../steering.ts)
// is submitted to OpenCode as a tool call of a round returns, before the
// round's next step: with `delivery: 'steer'`, which joins the turn at that
// step, after the round's results. Once, by its steer id (`msg_steer_<id>`,
// which OpenCode takes once, also from a retried attempt). In such a turn,
// the tool's `execute.after` hook, which OpenCode awaits before it stores the
// result, copies the result as the tool returned it and publishes the copy,
// whose answer lists the messages, then submits them: so OpenCode places
// them at the step that follows, never past the turn's end. The copy stores
// each as a steered message of the turn, in its place, and tells the
// companion it is taken.
//
// v1 leaves out OpenCode's background work: its subagent and question tools,
// and background shell jobs.
//
// With a workspace, an ask of OpenCode's permission rules (a read of `.env`,
// by default) is denied, as OpenCode denies one nobody is present for; with
// `approval`, its tool call waits for a person's approval, through Restate
// (`permissionPlugin`).
//
// The attempt is kept alive (`ctx.working`) while OpenCode's turn runs, its
// own tools (shell, read, edit...) included, but not while a tool of yours
// executes (it says so itself: `tool({ keepalive })`), nor while an approval
// is waited for (`gateOf`): OpenCode has no hook at the end of a model's request.
//
// TODO: a change of `model` on an existing session.
import * as restate from '@restatedev/sessions';
import { database, reset } from '@restatedev/sessions/internal';
import { mkdir } from 'node:fs/promises';
import type { Plugin } from '@opencode/plugin';
import { toSessionError } from '@opencode/core/session/to-session-error';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { z } from 'zod';
import {
  AttemptEnded,
  chatHandler,
  CHECK_MODEL,
  type Check,
  checkModelName,
  type Configure,
  configured,
  fromTool,
  inboxOf,
  keepAlive,
  modelOf,
  providerOf,
  refusal,
  REFUSED,
  RETURNED_UNRECORDED,
  stopSignalOf,
  toolCallStarted,
  approves,
} from '../common.ts';
import { flushCalls } from '../calls.ts';
import { answerOnce, invocationOf, type Call, type Items, type Parsed, STEPS, type Turn } from '../conversation.ts';
import { conversationView } from '../messages.ts';
import { tookSteers } from '../steering.ts';
import { type Definition, sessionObject } from '../object.ts';
import { type Answer, withChecked } from '../output.ts';
import { isTool, type Tool as AnyTool, waitFor } from '../tools.ts';
import { type Fence, type Host, openOpenCode, type Restart } from './db.ts';

/** An OpenCode model reference. */
export interface ModelRef {
  providerID: string;
  id: string;
}

/** `provider/model-id` as OpenCode names it. */
const modelRef = (name: string): ModelRef => {
  const [providerID, id] = providerOf(name);
  return { providerID, id };
};

/** An OpenCode tool of your own: `execute` gets the input and the tool call's id. */
export interface OpenCodeTool<Input = unknown> {
  name: string;
  description: string;
  input: StandardSchemaV1<unknown, Input>;
  execute(input: Input, callId: string): Promise<string>;
}

/**
 * `t` as an OpenCode tool. OpenCode checks the arguments against `t.input`,
 * and answers the model with what is wrong; those that fit reach `t.run` as
 * the model gave them, which parses them itself.
 */
const native = (t: AnyTool, ctx: restate.SessionContext): OpenCodeTool => {
  const standard = t.input['~standard'];
  const input: StandardSchemaV1 = {
    '~standard': {
      ...standard,
      validate: (args) => {
        const result = standard.validate(args) as StandardSchemaV1.Result<unknown>;
        return result.issues ? result : { value: args };
      },
    },
  };
  return {
    name: t.name,
    description: t.description,
    input,
    execute: async (args, callId) => {
      const result = await t.run(args, { ctx, callId });
      // OpenCode stores the result in its own database, which a commit of `ctx.db` does not reach: a call that
      // answered is recorded before the result is handed over, not with a commit that comes after.
      await flushCalls(ctx);
      return result;
    },
  };
};

/** The session every prompt goes to. */
const SESSION = 'ses_root' as never;

/** The key's database where OpenCode's tables are, apart from `ctx.db`. */
const DATABASE = 'restate-agents.opencode';

/** The table of `ctx.db` where the last prompt submitted to OpenCode is recorded: one row. */
const SUBMITTED = 'restate_agents_opencode';

/** OpenCode's message id of prompt `id`: letters, digits, `_` and `-`. */
export const messageIdOf = (id: string) => `msg_${id.replace(/[^\w-]/g, '_')}`;

/** OpenCode's message id of the message that asks again within the turn of prompt `id`. */
const againIdOf = (id: string) => `${messageIdOf(id)}_again`;

/** OpenCode's message id of the message `steerId` steered to a turn. */
const steerIdOf = (steerId: string) => messageIdOf(`steer_${steerId}`);

// The items: OpenCode's messages as the conversation keeps them.

/** A tool call's result, as an item holds it. */
interface ItemResult {
  id: string;
  name: string;
  output: string;
  error?: boolean;
}

/**
 * An item of the conversation: a user's message, an assistant's message (a
 * step of OpenCode's: its text and tool calls), or tool calls' results. One
 * copied from OpenCode (a message steered to the turn, say) has `from`: the
 * id of its OpenCode message, and for a result the id of its part too
 * (`<message>/<part>`), by which it is copied once.
 */
export type Item =
  | { type: 'user'; text: string; from?: string }
  | { type: 'assistant'; text: string; calls?: Call[]; from?: string }
  | { type: 'results'; results: ItemResult[]; from?: string };

const KINDS = new Set(['user', 'assistant', 'results']);

/** The current attempt's live work on a turn, by turn: what `settleOwn` does while the turn runs here. */
const live = new WeakMap<object, (status: string) => Promise<void>>();

/**
 * OpenCode's items. A user's message is said by the user; an assistant's
 * says its text, with its tool calls; results are results. OpenCode's
 * synthetic messages, idle markers and compactions are never copied.
 */
export const items: Items<Item> = {
  dump: (item) => JSON.stringify(item),
  load: (stored) => {
    const item = JSON.parse(stored) as Item;
    if (typeof item !== 'object' || item === null || !KINDS.has(item.type)) {
      throw new Error('not an OpenCode item (a user, assistant or results item)');
    }
    return item;
  },
  prompt: (text) => ({ type: 'user', text }),
  reply: (text) => ({ type: 'assistant', text }),
  results: (results) =>
    [
      {
        type: 'results',
        results: results.map(([call, output]) => ({
          id: call.id,
          name: call.name,
          output,
          ...(output === RETURNED_UNRECORDED ? {} : { error: true }),
        })),
      },
    ] satisfies Item[],
  read: (item): Parsed => {
    if (item.type === 'user') return { said: ['user', item.text] };
    if (item.type === 'assistant') return { said: ['assistant', item.text], calls: item.calls ?? [] };
    return { results: item.results.map(({ id, output, error }) => ({ id, output, error })) };
  },
  // A turn another invocation left: OpenCode closes it first (its resume
  // budget, no model), then what OpenCode has of it is copied.
  settleOwn: async (ctx, turn, status) => {
    const own = live.get(turn);
    if (own) return own(status);
    if (status !== 'ended') return;
    const fence: Fence = { closed: false };
    const host = await openOpenCode(database(ctx.db, DATABASE), fence, { restart: 'close' });
    try {
      await host.swept;
      await dropInbox(host);
      await copyInto(ctx, host, turn);
    } finally {
      await host.close();
    }
  },
  erase: (ctx) => database(ctx.db, DATABASE).transaction((tx) => reset(tx)),
};

// OpenCode's messages, as the client gives them.

/** A part of an assistant message: text, or a tool call (`id`, `name`, and its `state`). */
interface Content {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  state?: {
    status?: string;
    input?: unknown;
    content?: string | Content[];
    output?: unknown;
    error?: { message?: string };
  };
}

/** A message of OpenCode's session, as far as the copy and a prompt's outcome go. */
interface Message {
  id: string;
  type: string;
  outcome?: string;
  text?: string;
  content?: Content[];
  error?: { message?: string; type?: string; status?: number };
  time?: { completed?: unknown; streamed?: unknown };
  /** How the step ended (`stop`, `tool-calls`, `error`...), once OpenCode stored it. */
  finish?: string;
  metadata?: Record<string, unknown>;
}

/** The id of the message steered to a turn that `m` is, if it is one: the steer id it was submitted with. */
const steerOf = (m: Message): string | undefined => {
  const steer = m.metadata?.steer;
  return m.type === 'user' && typeof steer === 'string' && m.id === steerIdOf(steer) ? steer : undefined;
};

/** The text of `content`. */
const textOf = (content: string | Content[] = []) =>
  typeof content === 'string'
    ? content
    : content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');

/** The output of a tool part that ended: its content, or its error. */
const outputOf = (part: Content) => {
  const state = part.state ?? {};
  if (state.status === 'error') return state.error?.message ?? 'Error';
  if (state.content !== undefined) return textOf(state.content);
  return typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? '');
};

/** The prompts waiting in the session's inbox, until their turn starts, oldest first. */
const inbox = (host: Host): Promise<{ id: string; payload: { text: string } }[]> =>
  host.call(host.client.session.inbox.list({ sessionID: SESSION }));

/**
 * Cancel what waits in the session's inbox. A prompt killed after OpenCode
 * queued it and before its turn's claim leaves no claim for the sweep to
 * close, only its input: the next prompt's drain would run it, under the
 * next invocation.
 */
async function dropInbox(host: Host) {
  // No session yet (the key's first prompt): nothing waits.
  if (!(await sessionExists(host))) return;
  for (const item of await inbox(host)) {
    await host.call(host.client.session.inbox.cancel({ sessionID: SESSION, inboxID: item.id as never }));
  }
}

/** The session's messages, a page at a time, newest first. */
async function* newestFirst(host: Host): AsyncGenerator<Message[]> {
  for (let cursor: string | undefined; ;) {
    const page: { data: unknown[]; cursor: { next?: string } } = await host.call(
      host.client.message.list(
        cursor === undefined ? { sessionID: SESSION, order: 'desc', limit: 50 } : { sessionID: SESSION, cursor },
      ),
    );
    yield page.data as Message[];
    cursor = page.cursor.next;
    if (cursor === undefined) return;
  }
}

/** The messages after message `messageId`, oldest first; undefined if the session does not have it. */
async function messagesAfter(host: Host, messageId: string): Promise<Message[] | undefined> {
  // One lookup says a message is not there (every new prompt's): no paging through the session for it.
  const there = await host
    .call(host.client.session.message.get({ sessionID: SESSION, messageID: messageId as never }))
    .then(
      () => true,
      () => false,
    );
  if (!there) return undefined;
  const after: Message[] = [];
  for await (const page of newestFirst(host)) {
    const at = page.findIndex((m) => m.id === messageId);
    after.unshift(...(at < 0 ? page : page.slice(0, at)).toReversed());
    if (at >= 0) return after;
  }
  return undefined;
}

/** Whether OpenCode's session exists. */
const sessionExists = (host: Host) =>
  host.call(host.client.session.get({ sessionID: SESSION })).then(
    () => true,
    () => false,
  );

/** A tool call's result as its tool returned it, `from` its OpenCode message and part (`<message>/<part>`). */
interface Returned {
  result: ItemResult;
  from: string;
}

/**
 * Copy into `turn` what OpenCode has of it that the turn lacks: each step's
 * assistant message once its stream ended (its text, its tool calls, before
 * they run; one without calls once its step ended, and not if it failed
 * or the output limit cut it off),
 * each tool call's result once it ended, and each message
 * steered to the turn that OpenCode placed at a step (stored as steered, the
 * companion told it is taken in the transaction). Each once: by OpenCode's
 * ids, a steered message by its steer id too. Not the prompt, nor what asks
 * again (the turn has them), nor OpenCode's synthetic messages, idle markers
 * and compactions. In a `ctx.db` transaction of its own. Whether it copied a
 * step that a follower waits for: a reply with tool calls, or a tool's result.
 *
 * With `own`, a call's result as its tool returned it, before OpenCode
 * stores it: copied too (after its reply), under the id OpenCode's part has.
 */
async function copyInto(
  ctx: restate.SessionContext,
  host: Host,
  turn: Turn<Item>,
  own?: Returned,
  steersOnly = false,
): Promise<boolean> {
  if (!turn.writable) return false;
  const after = await messagesAfter(host, messageIdOf(turn.id));
  if (!after) return false;
  const have = new Set(turn.items.flatMap((e) => (e.item.from ? [e.item.from] : [])));
  const held = new Set(turn.steered().map((e) => e.steer));
  const copied: { item: Item; reply?: boolean; steer?: string }[] = [];
  for (const m of after) {
    const steer = steerOf(m);
    if (steer !== undefined) {
      if (!have.has(m.id) && !held.has(steer)) {
        copied.push({ item: { type: 'user', text: m.text ?? '', from: m.id }, steer });
        have.add(m.id);
        held.add(steer);
      }
      continue;
    }
    if (m.type !== 'assistant' || steersOnly) continue;
    const tools = (m.content ?? []).filter((c) => c.type === 'tool' && c.id !== undefined);
    // A step's message is updated in place as it streams. With tool calls, it is copied once its stream
    // ended, before they run, their input whole. Without, once OpenCode stored how the step ended (its
    // `finish`, after its stream's end): a step that failed (its provider refused, or failed mid-stream)
    // is no reply, as OpenCode asks again in a step of its own, or its error ends the turn. A step left
    // without its end (a crash between the two, then a resume) is never one either: OpenCode marks it
    // completed, without a `finish`, as the resumed turn's next step starts.
    if (tools.length === 0 && m.finish === undefined) {
      if (after.slice(after.indexOf(m) + 1).some((n) => n.type === 'assistant')) continue;
      break;
    }
    // A step with tool calls whose stream never ended (a crash once a call ran, as OpenCode runs a call as it
    // streams) is completed, without a `finish`, as the resumed turn's next step starts: copied, its calls kept.
    const ready =
      m.time?.completed !== undefined ||
      (m.time?.streamed !== undefined && tools.every((t) => t.state?.status !== 'streaming'));
    if (!ready) break;
    if (!have.has(m.id)) {
      const text = textOf(m.content);
      const calls = tools.map((t) => ({ id: t.id!, name: t.name ?? '', input: t.state?.input ?? {} }));
      // A failed step's tool calls are kept, for their results. Without calls, a step that failed (its
      // `error`), or that the model's output limit cut off (`length`: OpenCode asks the model to go on in a
      // step of its own), is no reply; one that ended otherwise (`stop`, or `error` as a provider names it)
      // ends OpenCode's turn with its text.
      if (calls.length === 0 && (m.error !== undefined || m.finish === 'length' || !text.trim())) continue;
      copied.push({ item: { type: 'assistant', text, calls, from: m.id }, reply: true });
      have.add(m.id);
    }
    for (const t of tools) {
      const status = t.state?.status;
      const from = `${m.id}/${t.id}`;
      if ((status !== 'completed' && status !== 'error') || have.has(from)) continue;
      const output = outputOf(t);
      const result: ItemResult = {
        id: t.id!,
        name: t.name ?? '',
        output,
        ...(status === 'error' ? { error: true } : {}),
      };
      copied.push({ item: { type: 'results', results: [result], from } });
      have.add(from);
    }
  }
  if (own && !have.has(own.from) && have.has(own.from.split('/')[0]!)) {
    copied.push({ item: { type: 'results', results: [own.result], from: own.from } });
  }
  if (copied.length === 0) return false;
  const done = await ctx.db.transaction(async (tx) => {
    if (!(await turn.copyIn(tx, copied))) return false;
    tookSteers(
      ctx,
      tx,
      copied.flatMap(({ steer }) => (steer === undefined ? [] : [steer])),
    );
    return true;
  });
  return (
    done &&
    copied.some(({ item }) => item.type === 'results' || (item.type === 'assistant' && (item.calls?.length ?? 0) > 0))
  );
}

/** Where a prompt is: not in the session, its turn running, or ended with an answer or a failure. */
type Outcome =
  | { state: 'absent' | 'running' }
  | { state: 'answered'; text: string }
  | { state: 'failed'; reason: string; type?: string; status?: number };

/** Where prompt `messageId` is (see {@link Outcome}). */
async function outcome(host: Host, messageId: string): Promise<Outcome> {
  if ((await inbox(host)).some((item) => item.id === messageId)) return { state: 'running' };
  const after = await messagesAfter(host, messageId);
  return after ? turnOutcome(after) : { state: 'absent' };
}

/**
 * How the turn of the messages `after` a prompt ended: at an idle marker, or
 * where a next prompt starts (a message steered to the turn is not one).
 */
function turnOutcome(after: Message[]): Outcome {
  let last: Message | undefined;
  for (const m of after) {
    if (m.type === 'idle') return ended(last, m);
    if (m.type === 'user' && last !== undefined && steerOf(m) === undefined)
      return ended(last, { id: '', type: 'idle', outcome: 'succeeded' });
    if (m.type === 'assistant') last = m;
  }
  return { state: 'running' };
}

/** The outcome of a turn that ended at `idle`, with `last`, its last assistant message: its text, or its error. */
function ended(last: Message | undefined, idle: Message): Outcome {
  const error = last?.error ?? idle.error;
  if (idle.outcome === 'succeeded' && last?.error === undefined)
    return { state: 'answered', text: textOf(last?.content) };
  return {
    state: 'failed',
    reason: error?.message ?? idle.outcome ?? 'failed',
    type: error?.type,
    status: error?.status,
  };
}

/** Whether a turn of the session runs in this process. */
const active = async (host: Host) => {
  const turns: Record<string, unknown> = await host.call(host.client.session.active());
  return turns[SESSION as string] !== undefined;
};

/**
 * Keeps the attempt alive (`ctx.working`) while OpenCode's turn runs, but
 * not while a tool that is not kept alive executes, nor while a wait on
 * Restate is made: OpenCode has no hook at the end of a model's request, so
 * the turn's scope minus those windows is the nearest. The scope is open
 * exactly while a turn is running (`turn`) and nothing is paused (`pause`:
 * a set of ids, since tools may overlap, and a pause is made once per id).
 * `end` closes it for good, whichever way the attempt ends.
 */
function gateOf(ctx: restate.SessionContext) {
  let turns = 0;
  let closed = false;
  const paused = new Set<string>();
  let release: (() => void) | undefined;
  const sync = () => {
    const open = !closed && turns > 0 && paused.size === 0;
    if (open && !release) release = keepAlive(ctx);
    else if (!open && release) {
      release();
      release = undefined;
    }
  };
  return {
    /** Run `fn` as a turn: the scope is open meanwhile, unless paused. Closed on every way out. */
    async turn<T>(fn: () => Promise<T>): Promise<T> {
      turns++;
      sync();
      try {
        return await fn();
      } finally {
        turns--;
        if (turns === 0) paused.clear();
        sync();
      }
    },
    pause(id: string) {
      paused.add(id);
      sync();
    },
    resume(id: string) {
      paused.delete(id);
      sync();
    },
    end() {
      closed = true;
      paused.clear();
      sync();
    },
  };
}
type Gate = ReturnType<typeof gateOf>;

/** How long a prompt's turn may be neither running nor ended: one resumed at boot starts well within it. */
const STALLED_MS = 5_000;

/**
 * The outcome of prompt `messageId`, once its turn has ended. A prompt left
 * in the inbox with nothing to run it (a crash between its queueing and its
 * turn's claim) is started again, by its id. A turn that neither runs nor
 * ends for {@link STALLED_MS} fails the attempt: the retry boots OpenCode
 * again, which resumes the turn of this prompt.
 */
async function settled(host: Host, messageId: string): Promise<Outcome> {
  for (let idleSince = Date.now(); ;) {
    const now = await outcome(host, messageId);
    if (now.state !== 'running') return now;
    if (!(await active(host))) {
      const [first] = await inbox(host);
      if (first !== undefined) {
        await host.call(
          host.client.session.prompt({
            sessionID: SESSION,
            id: first.id as never,
            text: first.payload.text,
            delivery: 'queue',
            resume: true,
          }),
        );
      }
    }
    await host.call(host.client.session.wait({ sessionID: SESSION }));
    if (await active(host)) {
      idleSince = Date.now();
      continue;
    }
    if (Date.now() - idleSince > STALLED_MS) {
      throw new Error(`prompt ${messageId}: its turn has neither run nor ended for ${STALLED_MS / 1000} s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The prompt last submitted to OpenCode, as recorded before its submit. */
async function submittedOf(ctx: restate.SessionContext): Promise<string | undefined> {
  await ctx.db.execute(
    `CREATE TABLE IF NOT EXISTS ${SUBMITTED} (row INTEGER PRIMARY KEY CHECK (row = 0), prompt TEXT NOT NULL)`,
  );
  const row = await ctx.db.get<{ prompt: string }>(`SELECT prompt FROM ${SUBMITTED} WHERE row = 0`);
  return row?.prompt;
}

/** Record prompt `promptId` as the last submitted to OpenCode: before it is. */
const record = (ctx: restate.SessionContext, promptId: string) =>
  ctx.db.execute(`INSERT OR REPLACE INTO ${SUBMITTED} (row, prompt) VALUES (0, ?)`, [promptId]);

/**
 * The note that tells the model how the turn before ended, if it was closed:
 * its answer, and for a turn another invocation left, the calls that did
 * happen (OpenCode's own history says only that they were interrupted).
 */
async function noteOf(ctx: restate.SessionContext, before: { n: number; answer?: string; status?: string }) {
  if (!before.answer || before.status === 'answered' || before.status === undefined) return '';
  if (before.status !== 'ended') return `(${before.answer})\n\n`;
  const rows = await ctx.db.values(`SELECT item FROM ${STEPS} WHERE turn = ? ORDER BY n`, [before.n]);
  const happened = rows.flatMap(([stored]) => {
    const item = items.load(String(stored));
    return item.type === 'results' ? item.results.filter((r) => r.output === RETURNED_UNRECORDED) : [];
  });
  const calls = happened.map((r) => `${r.name} (${r.id})`).join(', ');
  return `(${before.answer}${calls ? ` These calls did happen: ${calls}.` : ''})\n\n`;
}

/** OpenCode's error types of a request its provider refused for good. */
const REFUSALS = /^provider\.(no-route|auth|unauthorized|not-found)|auth/i;

/** Whether OpenCode's error (`reason`, its `type` and HTTP `status`) is its provider's refusal, for good. */
const refusedFor = (reason: string, type?: string, status?: number) =>
  refusal(new Error(reason)) !== undefined ||
  (type !== undefined && REFUSALS.test(type)) ||
  status === 401 ||
  status === 403;

/** The error of prompt `id`, which ended unanswered (`failed`): {@link REFUSED} if its provider refused it. */
function unanswered(id: string, failed: Extract<Outcome, { state: 'failed' }>, model: ModelRef) {
  const message = `prompt ${id} unanswered: ${failed.reason}`;
  if (!refusedFor(failed.reason, failed.type, failed.status)) return new restate.TerminalError(message);
  const of = `the model ${model.providerID}/${model.id}: ${CHECK_MODEL}`;
  return new restate.TerminalError(`${message} (${of})`, { errorCode: REFUSED });
}

/** What `work` gets: `prompt(text)`, and the OpenCode host for anything else. */
export interface OpenCodeSession {
  /** OpenCode, booted on its first use. */
  host: () => Promise<Host>;
  /**
   * Answer `text`, once, with the answer's text: a turn of the object's
   * conversation (each prompt of an invocation has an id of its own, the
   * same on every attempt). With `check`, a reply it returns a message for
   * is asked again within the turn, once. With `reminder`, the model is told
   * it after the prompt, which the conversation keeps as it was asked.
   */
  prompt: (text: string, check?: Check, reminder?: string) => Promise<string>;
}

/** An agent's options: `chat`, `prompt` and `withOpenCode` take them. */
export interface Options<O extends z.ZodObject | undefined = z.ZodObject | undefined> {
  /** The model of the session, as `provider/model-id`: MODEL, or else openai/gpt-6-sol. */
  model?: string | ModelRef;
  /** The system prompt: who the agent is, and how it answers. */
  system?: string;
  /** The agent's tools, which replace OpenCode's own: `tool()`s, Restate's (`call`, `signal`...), or OpenCode tools of your own. */
  tools?: (AnyTool | OpenCodeTool)[];
  /**
   * A directory of the local machine, made if missing: OpenCode keeps its own
   * tools (read, write, edit, shell, glob, grep...) there, besides `tools`,
   * and the session works in it. Or a function of the invocation's context
   * that gives one: `(ctx) => \`/work/${ctx.key}\``.
   */
  workspace?: string | ((ctx: restate.SessionContext) => string | Promise<string>);
  /** OpenCode plugins, such as the one of the model. */
  plugins?: Plugin.Plugin[];
  /**
   * How OpenCode asks the model again after a request failed for a reason
   * that passes (an overloaded or unreachable provider, a rate limit), as pi
   * does: by default without limit, 2 s after the first failure, then twice
   * as long each time, a minute apart at most (`baseDelayMs`,
   * `maxAgentDelayMs`), but never before the provider said to try again
   * (its `retry-after`, which the cap does not shorten: up to 15 minutes, as
   * OpenCode takes it). A request refused for good (a wrong API key, an
   * unknown model, a request a retry would make again) is never asked again,
   * and ends the turn (424). Unlike pi, OpenCode asks again 10 times at most
   * in a step of the turn, and after its 4th timeout in a step not at all:
   * without `maxRetries`, an outage OpenCode stops asking again about fails
   * the attempt instead, and Restate's retry of it resumes the turn, waits
   * from 2 s again. With `maxRetries`, a failure after that many retries of
   * a step ends the turn, as one OpenCode stops asking again about does.
   * `enabled: false` asks no request again.
   */
  retry?: Partial<RetryPolicy>;
  /**
   * With a workspace, OpenCode's own tools ask before what its permission
   * rules say to ask about (by default, a read of a `.env` file). Without
   * `approval`, nobody answers such an ask: it is denied, as OpenCode denies
   * one nobody is present for, and the model gets the denial as the tool's
   * error. With `approval`, the tool call waits for the signal
   * {@link APPROVAL} to the agent, which `pending` shows with the call's tool
   * and arguments and the permission asked (`action`, `resources`); `true`,
   * or a text such as "approved" or "yes", allows it, anything else denies
   * it (a text, or `{ reason }`, is the denial's reason, for the model).
   */
  approval?: boolean;
  /**
   * The answer as data: a zod object, whose JSON the agent replies with
   * (checked), and `chat` and `prompt` answer with (see output.ts).
   */
  output?: O;
}

/** An OpenCode plugin that adds `system` to the session's system prompt. */
const systemPlugin = (system: string): Plugin.Plugin => ({
  id: 'restate-agents.system',
  async setup(ctx) {
    const hook = await ctx.session.hook('context', (request) => {
      request.system.push({ type: 'text', text: system });
    });
    return () => hook.dispose();
  },
});

/** How a failed model request is asked again ({@link Options.retry}): pi's policy, as OpenCode can take it. */
export interface RetryPolicy {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs?: number;
}

/** The retries OpenCode makes of a step at most, in one attempt (its `ModelRetry` schedule's `recurs(10)`). */
const OPENCODE_RETRIES = 10;

/** The longest wait a provider's `retry-after` asks for that OpenCode takes (its `ModelRetry`'s `RETRY_AFTER_MAX`). */
const RETRY_AFTER_MAX_MS = 15 * 60_000;

/**
 * OpenCode's error types of an outage: the failures its `AIError.isRetryable`
 * retries (a rate limit, the provider's internal error, the transport's, one
 * it cannot classify), as `toSessionError` names them.
 */
const OUTAGES = new Set(['provider.rate-limit', 'provider.internal', 'provider.transport', 'provider.unknown']);

/**
 * An OpenCode plugin that decides, by its `session.retry` hook, how a failed
 * model request is asked again: OpenCode calls it for each failure while its
 * schedule lasts (`attempt` is 2 at the first), its decision proposed. A
 * refusal is never retried, nor a failure OpenCode would not retry that is
 * no outage; an outage after `baseDelayMs` doubled each time, at most
 * `maxAgentDelayMs`, and not before the provider's `retry-after`. An outage
 * OpenCode would retry for the last time, or stopped retrying (after its 4th
 * timeout in a step), is `outage` instead (with no `maxRetries`), which
 * fails the attempt: the next resumes the turn, which OpenCode retries
 * afresh.
 */
function retryPlugin(
  { enabled = true, maxRetries = Infinity, baseDelayMs = 2_000, maxAgentDelayMs = 60_000 }: Partial<RetryPolicy>,
  outage: (error: Error) => void,
): Plugin.Plugin {
  return {
    id: 'restate-agents.retry',
    async setup(ctx) {
      const hook = await ctx.session.hook('retry', (event) => {
        const { message, type, status, retryAfterMs = 0 } = event.error;
        const retries = event.attempt - 1;
        const stopped = !event.decision.retry;
        if (
          !enabled ||
          refusedFor(message, type, status) ||
          retries > maxRetries ||
          (stopped && (maxRetries !== Infinity || !OUTAGES.has(type)))
        ) {
          event.decision = { retry: false };
        } else if (stopped || (maxRetries === Infinity && retries >= OPENCODE_RETRIES)) {
          outage(
            new Error(
              `the model's provider failed ${retries} times in a row (${message}): the next attempt resumes the turn`,
            ),
          );
          // The attempt is over: OpenCode waits until it is closed.
          event.decision = { retry: true, delay: 2 ** 31 - 1 };
        } else {
          const backoff = Math.min(baseDelayMs * 2 ** (retries - 1), maxAgentDelayMs);
          event.decision = { retry: true, delay: Math.max(backoff, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS)) };
        }
      });
      return () => hook.dispose();
    },
  };
}

/** OpenCode's tools of background work, which v1 leaves out: their recovery is not mapped onto turns. */
const BACKGROUND = new Set(['subagent', 'question']);

/**
 * An OpenCode plugin whose tools are `tools`, and, with `builtins` (a
 * workspace), OpenCode's own but those of background work.
 */
function toolsPlugin(
  tools: OpenCodeTool[],
  fail: (error: unknown) => Promise<never>,
  builtins: boolean,
): Plugin.Plugin {
  return {
    id: 'restate-agents.tools',
    async setup(ctx) {
      const transform = await ctx.tool.transform((editor) => {
        for (const t of editor.list()) {
          if (!builtins || BACKGROUND.has(t.name)) editor.remove(t.id);
          else if (t.name === 'shell') {
            // A shell command runs in the tool call, never as a background job.
            editor.update(t.id, (shell) => {
              const run = shell.execute;
              shell.execute = (input, context) =>
                (input as { background?: unknown } | undefined)?.background === true
                  ? Promise.resolve({
                      content: 'Error: background jobs are not available: run the command in the foreground.',
                    })
                  : run(input, context);
            });
          }
        }
        for (const t of tools) {
          editor.add({
            name: t.name,
            description: t.description,
            input: t.input,
            // Offered to the model as a tool, not in a code-mode script.
            options: { codemode: false },
            execute: async (input, context) => {
              try {
                return { content: await t.execute(input, context.id) };
              } catch (error) {
                return fail(error);
              }
            },
          });
        }
      });
      return () => transform.dispose();
    },
  };
}

/** The signal that an OpenCode tool call waits for, to the agent, when OpenCode asks for a permission (`approval`). */
export const APPROVAL = 'approval';

/**
 * What the value of an {@link APPROVAL} signal decides (see `approves`):
 * it allows, or denies with the reason it gives, if any (a text, or
 * `{ "reason": "..." }`).
 */
function decided(value: unknown): { allowed: true } | { allowed: false; reason?: string } {
  if (approves(value)) return { allowed: true };
  const given =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null
        ? (value as { reason?: unknown }).reason
        : undefined;
  const reason = typeof given === 'string' ? given.trim() : '';
  return { allowed: false, ...(reason ? { reason } : {}) };
}

/**
 * An OpenCode plugin that settles each permission OpenCode would ask for
 * (its `permission.evaluate` hook, which OpenCode awaits before it asks):
 * what OpenCode's rules allow or deny stays so. An ask would wait in
 * OpenCode's memory for a reply nothing gives, and its turn would never end.
 *
 * Without `approval`, it is denied, as OpenCode denies an ask nobody is
 * present for (its `Unattended` rules): the model gets the denial as the
 * tool's error. With `approval`, an ask of a tool call waits for the signal
 * {@link APPROVAL} (`waitFor`), which `pending` shows with the call's tool
 * and arguments, and the permission asked: its answer allows or denies.
 *
 * OpenCode stores the call (running) before it runs the tool, which asks;
 * but a crash, or a suspension, while it waits has the resumed turn give the
 * call OpenCode's "interrupted" result, and the model makes it again under a
 * new id: made with the same tool and arguments, it joins the wait
 * (`rejoin`), so the person is asked once. The wait is an approval
 * (`approval`): a stopped turn does not report its call as done because it
 * was approved. An error of the wait fails the attempt (`fail`), and the ask
 * never settles.
 *
 * The wait is the tool call's: a call that asks more than once (another
 * directory, then the file) has each ask answered by the first's answer.
 * OpenCode's hook does not tell an ask from a probe (`permission.allows`,
 * which an edit's miss hint makes), so a probe that would ask waits too.
 */
function permissionPlugin(
  ctx: restate.SessionContext,
  approval: boolean,
  fail: (error: unknown) => Promise<never>,
  gate: Gate,
): Plugin.Plugin {
  return {
    id: 'restate-agents.permission',
    async setup(plugin) {
      // Each tool call's tool and arguments, by call id: what `pending` shows of an ask.
      const calls = new Map<string, { tool: string; args: unknown }>();
      const before = await plugin.tool.hook('execute.before', (event) => {
        calls.set(event.id, { tool: event.tool, args: event.input });
      });
      const evaluate = await plugin.permission.hook('evaluate', async (event) => {
        if (event.effect !== 'ask') return;
        const callId = event.source?.type === 'tool' ? event.source.id : undefined;
        if (!approval || callId === undefined) {
          event.effect = 'deny';
          event.message = `Permission ${event.action} needs approval, and nobody is present to give it`;
          return;
        }
        const call = calls.get(callId);
        const asked = { ...call, action: event.action, resources: [...event.resources] };
        // An error of the wait fails the attempt: the ask never settles.
        // A wait on Restate is never inside a scope, whatever tool it is of (one kept alive, say).
        const waiting = `approval:${callId}`;
        gate.pause(waiting);
        const value = await waitFor(ctx, callId, APPROVAL, asked, { approval: true, rejoin: true })
          .catch(fail)
          .finally(() => gate.resume(waiting));
        const decision = decided(value);
        if (decision.allowed) {
          event.effect = 'allow';
          return;
        }
        event.effect = 'deny';
        const which = call ? `tool "${call.tool}"` : `permission ${event.action}`;
        event.message = `The user denied ${which}${decision.reason ? `: ${decision.reason}` : ''}`;
      });
      return async () => {
        await before.dispose();
        await evaluate.dispose();
      };
    },
  };
}

/**
 * Run `work(opencode)` with OpenCode over the object's database: `model` is
 * the session's model, `plugins` OpenCode plugins (such as the model's), and
 * `tools` the agent's tools. `opencode` has `prompt(text)`, and the
 * OpenCode host for anything else.
 */
export const withOpenCode = async <T>(
  ctx: restate.SessionContext,
  { plugins = [], model: named, system, tools = [], workspace: where, retry, approval = false }: Options,
  work: (opencode: OpenCodeSession) => Promise<T>,
): Promise<T> => {
  const model = typeof named === 'object' ? named : modelRef(modelOf(named));
  const workspace = typeof where === 'function' ? await where(ctx) : where;
  if (workspace) await mkdir(workspace, { recursive: true });
  const fence: Fence = { closed: false };
  const gate = gateOf(ctx);
  // OpenCode's own tools (shell, read, edit...) work on the machine and keep the turn alive; ours say so
  // themselves (their `run` opens a scope of its own).
  const ours = new Set(tools.map((t) => t.name));
  const { promise: failure, reject: failed } = Promise.withResolvers<never>();
  failure.catch(() => {});
  // A tool's error ends the attempt: nothing more is stored, and the tool
  // call never returns. A cancellation (a tool's, or the turn's stop)
  // interrupts OpenCode's turn instead, which then ends.
  let cancelled: restate.CancelledError | undefined;
  const fail = (error: unknown) => {
    if (error instanceof restate.CancelledError) cancelled = error;
    else {
      fromTool(ctx, error);
      fence.closed = true;
    }
    failed(error);
    return new Promise<never>(() => {});
  };
  const stop = stopSignalOf(ctx);
  const onStop = () => {
    const reason: unknown = stop!.reason;
    // An attempt that ends stores nothing more: the next goes on with the turn.
    if (reason instanceof AttemptEnded) fence.closed = true;
    else cancelled = reason as restate.CancelledError;
    failed(reason);
  };
  stop?.addEventListener('abort', onStop, { once: true });

  // The turn being answered, which the copy writes.
  let turn: Turn<Item> | undefined;
  // Once the turn is stopped, nothing more is copied: its close says how it ended.
  let stopping = false;
  // The copies, one after another.
  let copying: Promise<unknown> = Promise.resolve();
  /**
   * Copy what OpenCode has of the turn, and `own`, a call's result as its tool returned it (see {@link copyInto}):
   * once the turn is stopped, only with `steersOnly`, its messages steered to the turn. A copy of steps (a reply
   * with tool calls, tools' results) is published once it is committed, for followers to read them there.
   */
  const copy = (own?: Returned, steersOnly = false) => {
    const next = copying.then(async () => {
      if (!turn || (stopping && !steersOnly) || fence.closed) return undefined;
      if (await copyInto(ctx, await host(), turn, own, steersOnly)) await turn.stepsCommitted();
      return undefined;
    });
    copying = next.catch(() => {});
    return next;
  };
  const copied = () => {
    copy().catch((error: unknown) => void fail(error));
  };

  // The messages steered to the turn that this attempt submitted to OpenCode, by steer id.
  const given = new Set<string>();
  /**
   * Submit to OpenCode each message steered to the turn that the inbox lists
   * and the turn has not taken, once (keyed by its id: OpenCode takes an id
   * once, also from a retried attempt), with `delivery: 'steer'`: OpenCode
   * places it at the turn's next step, after the round's results. Only as a
   * tool call of a round returns, so a step follows; none once the turn is
   * stopped, or closed.
   */
  const steer = async () => {
    const waiting = inboxOf(ctx);
    if (!waiting || !turn) return;
    if (stopping || cancelled !== undefined || fence.closed || stopSignalOf(ctx)?.aborted || !turn.writable) return;
    const held = new Set(turn.steered().map((e) => e.steer));
    const fresh = waiting.messages.filter((m) => !given.has(m.id) && !held.has(m.id));
    if (fresh.length === 0) return;
    const opened = await host();
    for (const { id: steerId, text } of fresh) {
      given.add(steerId);
      await opened.call(
        opened.client.session.prompt({
          sessionID: SESSION,
          id: steerIdOf(steerId) as never,
          text,
          metadata: { steer: steerId },
          delivery: 'steer',
        }),
      );
    }
  };

  /**
   * Copy the reply that makes a tool call before the call runs (its copy is
   * published), then forget the calls whose results are stored. In a turn
   * that takes steered messages, the result is copied as the tool returns it
   * (OpenCode stores it after this hook, and goes on to the round's next step
   * without waiting for a copy): the copy's publish lists the messages
   * steered to the turn, which are submitted before OpenCode stores the
   * result ({@link steer}).
   */
  const followPlugin: Plugin.Plugin = {
    id: 'restate-agents.follow',
    async setup(plugin) {
      // A tool's window: the hooks run, and the tool executes, with the turn's scope paused (the hooks
      // copy and publish, which wait on Restate), unless the tool is kept alive: then only the hooks.
      const before = await plugin.tool.hook('execute.before', async (event) => {
        gate.pause(event.id);
        try {
          await copy()
            .then(() => toolCallStarted(ctx))
            .catch(fail);
        } finally {
          if (!ours.has(event.tool)) gate.resume(event.id);
        }
      });
      const after = await plugin.tool.hook('execute.after', async (event) => {
        gate.pause(event.id);
        try {
          if (!inboxOf(ctx)) return;
          const output =
            event.status === 'error'
              ? // As OpenCode stores it: a denied permission's reason, say, not the tool's "Unable to read".
                toSessionError(event.error).message
              : outputOf({ type: 'tool', state: { status: 'completed', ...event.result } as Content['state'] });
          const result: ItemResult = {
            id: event.id,
            name: event.tool,
            output,
            ...(event.status === 'error' ? { error: true } : {}),
          };
          await copy({ result, from: `${event.messageID}/${event.id}` })
            .then(steer)
            .catch(fail);
        } finally {
          gate.resume(event.id);
        }
      });
      return async () => {
        await before.dispose();
        await after.dispose();
      };
    },
  };

  // This attempt found a turn's final reply stored: a claim left is of a turn the model finished.
  let finished = false;
  let booted: Promise<Host> | undefined;
  /** Boot OpenCode, once: for the prompt `promptId` of turn `current` if a prompt boots it. */
  const boot = (promptId?: string, current?: Turn<Item>) =>
    (booted ??= (async () => {
      const submitted = await submittedOf(ctx);
      // A claim, if any, is the recorded prompt's: this one's goes on, another's is closed.
      const mine =
        submitted !== undefined &&
        (promptId === undefined ? invocationOf(submitted) === ctx.request.id : submitted === promptId);
      if (mine && !finished && current) {
        // What OpenCode stored of the turn is copied first: a final reply it stored (and the attempt died
        // before its copy, or before OpenCode's turn ended) is the answer, and its turn is not resumed,
        // which would ask the model again.
        const reader = await openOpenCode(database(ctx.db, DATABASE), fence, { restart: 'none' });
        try {
          await reader.swept;
          await copyInto(ctx, reader, current);
        } finally {
          await reader.close();
        }
        finished = current.finalReply() !== undefined;
      }
      const restart: Restart = mine && !finished ? 'resume' : 'close';
      const opened = await openOpenCode(database(ctx.db, DATABASE), fence, {
        plugins: [
          ...plugins,
          followPlugin,
          toolsPlugin(
            tools.map((t) => (isTool(t) ? native(t, ctx) : t)),
            fail,
            workspace !== undefined,
          ),
          permissionPlugin(ctx, approval, fail, gate),
          ...(system ? [systemPlugin(system)] : []),
          // An outage OpenCode would stop retrying fails the attempt, as a tool's error does (never a refusal).
          retryPlugin(retry ?? {}, (error) => void fail(error)),
        ],
        config: { default_agent: 'build' },
        local: workspace !== undefined,
        restart,
        committed: copied,
      });
      await opened.swept;
      // Another prompt's input still waiting is a dead invocation's too: it never runs.
      if (!mine) await dropInbox(opened);
      return opened;
    })());
  const host = () => boot();

  let interrupting: Promise<unknown> | undefined;
  /**
   * Stop OpenCode's turn, once: what it has of the turn is copied, then
   * nothing more is (the turn's close says how it ended), and its turn is
   * interrupted: it ends, and releases its claim. The copies' errors are
   * the turn's close's no more than its interrupt's in an attempt that is
   * over (its fence closed: OpenCode refuses it, and its close ends the turn):
   * the turn closes cancelled.
   */
  const stopTurn = () =>
    (interrupting ??= (async () => {
      if (!booted) return;
      await copy().catch(() => {});
      stopping = true;
      const opened = await booted;
      await opened.call(opened.client.session.interrupt({ sessionID: SESSION })).catch((error: unknown) => {
        if (!fence.closed) throw error;
      });
      // A message steered to the turn that OpenCode placed as it was stopped is the turn's: OpenCode's
      // history has it, so the turn takes it, and it is not answered again as a turn of its own (unless
      // the copy fails: then its own turn answers it).
      await copy(undefined, true).catch(() => {});
    })());

  const prompt = (text: string, check?: Check, reminder?: string) =>
    answerOnce(
      ctx,
      text,
      items,
      async (store) => {
        const current = store.turn;
        const id = current.id;
        const again = current.latestAsk() !== current.prompt;
        const messageId = again ? againIdOf(id) : messageIdOf(id);
        // A stored final reply is the answer: the model is not asked for it again (nor OpenCode's turn resumed).
        const stored = current.finalReply();
        if (stored !== undefined) {
          finished = true;
          return stored;
        }
        const opened = await boot(id, current);
        const caught = current.finalReply();
        if (caught !== undefined) return caught;
        // Before the turn closes here (stopped, refused, failed): OpenCode's turn first, then the copy.
        live.set(current, async (status) => {
          if (status === 'cancelled') await stopTurn();
          else await copy();
        });
        if (!(await sessionExists(opened))) {
          const location = workspace ? { location: { directory: workspace as never } } : {};
          await opened.call(
            opened.client.session.create({ id: SESSION, model: model as never, agent: 'build' as never, ...location }),
          );
        }
        // From now on, each of OpenCode's commits is copied into the turn.
        turn = current;
        if ((await outcome(opened, messageId)).state === 'absent') {
          // The model is told how the turn before this one ended, if its run did not answer it.
          const before = store.transcript.at(-2);
          const note = !again && before ? await noteOf(ctx, before) : '';
          const said = items.read(current.latestAsk().item).said?.[1] ?? '';
          const asked = said + (again ? '' : (current.reminder ?? ''));
          await record(ctx, id);
          await opened.call(
            opened.client.session.prompt({
              sessionID: SESSION,
              id: messageId as never,
              text: note + asked,
              delivery: 'queue',
              resume: true,
            }),
          );
        }
        // The turn runs from its submit: the scope is open while it does, minus the tools' windows.
        const now = await gate.turn(() => settled(opened, messageId));
        // A prompt the cancellation's interrupt ended fails with the cancellation.
        if (cancelled) throw cancelled;
        await copy();
        if (now.state === 'answered') return now.text;
        if (now.state !== 'failed') throw new Error(`prompt ${id} is not in the session`);
        throw unanswered(id, now, model);
      },
      // OpenCode keeps the model's history: the conversation reads only its latest turns.
      { check, reminder, ownHistory: true },
    );

  // `failure`, once it comes. A cancellation interrupts OpenCode's turn
  // instead: the work ends with it (a prompt closes its turn, cancelled).
  const interruptOn = async (): Promise<never> => {
    try {
      return await failure;
    } catch (error) {
      if (!(error instanceof restate.CancelledError)) throw error;
      await stopTurn();
      return new Promise<never>(() => {});
    }
  };

  try {
    const done = await Promise.race([interruptOn(), work({ host, prompt })]);
    if (cancelled) throw cancelled;
    return done;
  } finally {
    stop?.removeEventListener('abort', onStop);
    gate.end();
    if (turn) live.delete(turn);
    if (booted) {
      const opened = await booted.catch(() => undefined);
      await interrupting?.catch(() => {});
      await opened?.close();
    }
  }
};

/**
 * Answer `text`, once: a retried attempt resumes the same prompt. Each prompt
 * of an invocation is a prompt of its own. With `output`, it answers with the
 * value the agent replies with (see output.ts), not its text.
 */
export const prompt = <O extends z.ZodObject | undefined = undefined>(
  ctx: restate.SessionContext,
  text: string,
  options: Options<O> = {},
): Promise<Answer<O>> =>
  withChecked(text, options, (t, o, check, reminder) =>
    withOpenCode(ctx, o, (session) => session.prompt(t, check, reminder)),
  ) as Promise<Answer<O>>;

/**
 * A chat handler: each message an invocation, the session in the object's
 * database, with `options`, or the options a function of the invocation's
 * context gives (each user's workspace, say). It takes the message as plain
 * text (`curl -d 'Hi'`) or as a JSON string (`curl --json '"Hi"'`).
 */
export const chat = <O extends z.ZodObject | undefined = undefined>(options: Configure<Options<O>> = {}) => {
  if (typeof options === 'object' && typeof options.model !== 'object') checkModelName('opencode', options.model);
  return chatHandler(async (ctx, message) => prompt(ctx, message, await configured(options, ctx)), { steers: true });
};

/**
 * A view of the conversation as clients read it: a page at a time, or what
 * is new or changed since a cursor; `view: 'summary'` for each turn's
 * message and answer. It answers while a message is answered. `clear` also
 * empties OpenCode's database.
 */
export const messages = () => conversationView(items);

/** An agent: a virtual object `name`, one per key, whose `chat` handler is {@link chat}, and `messages` {@link messages}. */
export const agent = <P extends string, O extends z.ZodObject | undefined = undefined>({
  name,
  description,
  schema,
  background,
  window,
  budget,
  ...options
}: Options<O> & Definition<P>) =>
  sessionObject({
    name,
    description,
    schema,
    background,
    window,
    budget,
    handlers: { chat: chat(options) },
    views: { messages: messages() },
  });
