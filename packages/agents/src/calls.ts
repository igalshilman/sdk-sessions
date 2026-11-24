// The Restate calls of an invocation's tools (`call`, `signal`, `subagent`...
// of tools.ts), kept in the object's database (`restate_agent_calls`) so that
// a call is made once, however often its tool call runs.
//
// A crash or a suspension restarts the handler. pi, Claude and LangGraph then
// run a tool call that was cut off again, with its id. The DeepSeek Harness
// tells the model it was interrupted instead, and the model
// makes it again with a new id: made with the same tool and input, it is the
// call an earlier attempt made, so it takes that call's id, and so the same
// idempotency key: the same Restate call (a wait for a signal, a sub-agent's
// task), which it waits for again, or whose answer it gets.
//
// A call is kept until the framework's transcript has its result under the
// last id it was made with ({@link settleCalls}, after each commit of steps, and before each
// tool call): one that answered just before a crash, whose result the
// framework had not stored, is made again as the same call. An error there
// is not its result (the DeepSeek Harness gives the call it interrupted
// one, and the model makes it again), unless the call answered with that error: a
// terminal error is its result too. Once stored, the model has its result,
// and an identical call it makes later is a call of its own.
//
// Only the record of a new call commits of its own, before the call is made,
// and that commit also carries what was pending: an answer is never behind it.
// That a call answered rides a commit that is under way or starts at once
// ({@link rideCommit}): the one that stores the call's result, so that the
// transcript never has a result of a call that is not recorded as answered;
// if none does (a slow tool of the round is still running, another call
// waits), it is written on its own at the end of that macrotask, so it is
// never left unrecorded for long. That its record is forgotten rides the next
// commit, whenever it comes. A crash in the few moments before an answer is
// written reads the call as one that did not answer, as a crash just before
// a commit of its own would have: made again, under the same key, and cut off
// for a stopped turn that another invocation closes.
//
// A framework's own wait ({@link waitFor} of tools.ts) is its tool call's
// alone: the framework stored its tool call before it waits, so a retried
// attempt waits again under the same id, and a new call with the same input
// (the model asking again, after the first's answer) waits anew. An approval
// a tool call waited for is not the call: a stopped turn does not report the
// call as done because its approval returned ({@link outcomes}).
import type * as restate from '@restatedev/sessions';
import type { Transaction } from '@restatedev/sessions';
import { flushRiders, rideCommit, Schema, ScopeKey } from '@restatedev/sessions/internal';
import { randomUUID } from 'node:crypto';

/** A tool's call: the tool, its input as JSON, the ids it was made with (the first is its own), and the attempt that last made it. */
interface Call {
  tool: string;
  input: string;
  ids: string[];
  attempt: string;
  /** Answered, until the transcript has its result. */
  done?: true;
  /** It answered with this error (`Error: <message>`), a terminal one: its result, as the transcript has it. */
  failed?: string;
  /** An approval its tool call waited for ({@link waitFor}): its answer is not the tool call's. */
  approval?: true;
  /**
   * The prompt whose turn made it (`answerOnce`'s), if any: an invocation
   * that prompts more than once keeps the calls of each apart.
   */
  prompt?: string;
}

/** The calls an invocation's tools made that the transcript has no result of yet. */
interface Calls {
  invocation: string;
  calls: Call[];
}

/**
 * The table of the {@link Calls}: one row, of the invocation whose calls they are. `answerOnce` applies it with
 * the conversation's, in one commit, as a key's first turn starts.
 */
export const SCHEMA = new Schema('restate-agents.calls', [
  `CREATE TABLE restate_agent_calls (
    row INTEGER PRIMARY KEY CHECK (row = 0),
    invocation TEXT NOT NULL,
    calls TEXT NOT NULL
  )`,
]);

/** What the calls need of a handler's context. */
type CallsContext = Pick<restate.SessionContext, 'db' | 'request'>;

/** What writes what is held back before anything visible, by holder: the conversation's rows, pi's batch of commits. */
const HELD = new ScopeKey<Map<string, () => Promise<void>>>('what the attempt holds back');

/**
 * Have {@link flushHeld} write, with `flush`, what a holder keeps back: by
 * default the rows that the conversation of the attempt's turn holds back
 * (`Conversation.hold`), which `answerOnce` sets. A holder of another `slot`
 * (pi's storage, which holds its commits until an effect starts) coexists
 * with it; one of the same slot replaces it, and without a `flush` the slot
 * is released.
 */
export const holding = (
  ctx: restate.SessionContext,
  flush: (() => Promise<void>) | undefined,
  slot = 'conversation',
) => {
  const held = HELD.of(ctx, () => new Map());
  if (flush) held.set(slot, flush);
  else held.delete(slot);
};

/**
 * Write what the holders keep back, in the order they were set, one after
 * the other: the rows that the conversation of the attempt's turn holds back,
 * if any (see `Conversation.hold`), and pi's batched commits. Call it before
 * what another party sees, or what outlives the attempt: a publish, a
 * Restate call, send or wait. What is held is lost in a crash, and the
 * retried attempt makes it again; what was seen or called must not depend
 * on it.
 */
export async function flushHeld(ctx: restate.SessionContext) {
  for (const flush of HELD.get(ctx)?.values() ?? []) await flush();
}

const UPSERT = 'INSERT OR REPLACE INTO restate_agent_calls (row, invocation, calls) VALUES (0, ?, ?)';

/** The slot of the calls' write that rides the next commit ({@link ride}). */
const RIDER = 'restate-agents.calls';

/** The write of `state`, as it is when it runs: the row, whole. */
const writing = (state: Calls) => (tx: Transaction) =>
  tx.execute(UPSERT, [state.invocation, JSON.stringify(state.calls)]);

/**
 * Store `calls`, committed before the call they record is made. The rows the
 * conversation holds back are written first: the call outlives the attempt,
 * and what led to it must too. It is the whole row, and it is written by a
 * commit that also carries what was pending (an answer): the state is
 * registered as the pending write, and flushed. A transaction under way (a
 * framework storing an earlier call's result) writes it as it commits, so that
 * the result is never committed beside an answer that is not recorded; with
 * none, it is a transaction of its own.
 */
async function store(ctx: restate.SessionContext, state: Calls) {
  await flushHeld(ctx);
  if (rideCommit(ctx.db, RIDER, writing(state))) await flushRiders(ctx.db);
  else await ctx.db.execute(UPSERT, [state.invocation, JSON.stringify(state.calls)]);
}

/**
 * Store `state` with the next commit of the database, rather than commit it
 * (see the top of this file), as it is then: a later change replaces it, and
 * the latest state is written. An `urgent` one (an answer) is written on its
 * own unless a commit is under way to write it; one pending that is urgent
 * stays so. A database that cannot ride (a view's) commits it at once.
 */
async function ride(ctx: restate.SessionContext, state: Calls, urgent = false) {
  const written = rideCommit(ctx.db, RIDER, writing(state), { urgent });
  if (!written) await store(ctx, state);
}

/** The calls of `invocation`, as stored: none if the row is another invocation's. */
async function load(ctx: CallsContext, invocation: string): Promise<Calls> {
  await SCHEMA.ensure(ctx.db);
  const row = await ctx.db.get<{ invocation: string; calls: string }>(
    'SELECT invocation, calls FROM restate_agent_calls',
  );
  return row?.invocation === invocation
    ? { invocation, calls: JSON.parse(row.calls) as Call[] }
    : { invocation, calls: [] };
}

/** Each attempt's id, and its calls, by its context, once they are being read. */
const ATTEMPT = new ScopeKey<{ id: string; calls?: Promise<Calls> }>('the calls of an attempt');

/**
 * The attempt of `ctx`: its id, and the calls of its invocation (loaded once,
 * shared by calls made at once). A load that fails (its schema's commit
 * cancelled, say) is not kept: the next asks again, so that a stopped turn's
 * close reads the calls as stored, rather than fail on the load it found.
 */
function attemptOf(ctx: restate.SessionContext) {
  const attempt = ATTEMPT.of(ctx, () => ({ id: randomUUID() }));
  if (attempt.calls === undefined) {
    const calls = load(ctx, ctx.request.id);
    attempt.calls = calls;
    calls.catch(() => {
      if (attempt.calls === calls) attempt.calls = undefined;
    });
  }
  return attempt as typeof attempt & { calls: Promise<Calls> };
}

/** `value` as JSON with its objects' keys sorted: the same input, however its keys came, is the same call. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/** The prompt whose turn the tools of `ctx` run for, while `answerOnce` answers it. */
const PROMPT = new ScopeKey<string>('the prompt of the calls');

/**
 * Run `work` (a turn's) with the calls its tools make kept as prompt
 * `prompt`'s: they are matched, and rejoined, within it only. An invocation
 * that prompts twice, its second prompt making the call its first made
 * (the same tool and input), would otherwise take the first's after a crash
 * (its record not yet forgotten), and never make its own.
 */
export async function forPrompt<T>(ctx: restate.SessionContext, prompt: string, work: () => Promise<T>): Promise<T> {
  const outer = PROMPT.get(ctx);
  PROMPT.set(ctx, prompt);
  try {
    return await work();
  } finally {
    if (outer === undefined) PROMPT.delete(ctx);
    else PROMPT.set(ctx, outer);
  }
}

/**
 * The call of tool `tool` with `input` that tool call `callId` makes: the
 * one it made to `tool` before (a run again), or else, if `rejoin`, the one
 * an earlier attempt made with the same tool and input (made again under a
 * new id), or else a new one, an `approval` its tool call waits for if so.
 * `answered()` stores that it answered.
 */
export async function callOf(
  ctx: restate.SessionContext,
  tool: string,
  input: unknown,
  callId: string,
  { rejoin = true, approval = false }: { rejoin?: boolean; approval?: boolean } = {},
) {
  const attempt = attemptOf(ctx);
  const state = await attempt.calls;
  const json = canonical(input);
  const prompt = PROMPT.get(ctx);
  const ours = state.calls.filter((c) => c.prompt === prompt);
  // A tool call may make more than one call (an approval, then the tool's
  // own), each to a tool of its own.
  let call =
    ours.find((c) => c.ids.includes(callId) && c.tool === tool) ??
    (rejoin ? ours.find((c) => c.attempt !== attempt.id && c.tool === tool && c.input === json) : undefined);
  if (call) {
    call.attempt = attempt.id;
    if (!call.ids.includes(callId)) call.ids.push(callId);
  } else {
    call = { tool, input: json, ids: [callId], attempt: attempt.id };
    if (approval) call.approval = true;
    if (prompt !== undefined) call.prompt = prompt;
    state.calls.push(call);
  }
  await store(ctx, state);
  const made = call;
  return {
    id: made.ids[0]!,
    /**
     * It answered, with `failed` if a terminal error answered it: kept until
     * the transcript has its result.
     *
     * It rides a commit that is under way (the one that stores the call's
     * result, when the framework's write has started), and is otherwise
     * written on its own at once ({@link ride}): a call that answered must
     * not stay unrecorded while something else runs (a slow tool of the same
     * round, a call that waits for a signal). A crash before it is written
     * reads the call as one that did not answer, as a crash just before a
     * commit of its own would have: made again under the same key, and cut off
     * for a stopped turn that another invocation closes ({@link outcomes} reads
     * the stored row; the attempt's own turn reads its state).
     */
    async answered(failed?: string) {
      made.done = true;
      if (failed !== undefined) made.failed = failed;
      await ride(ctx, state, true);
    },
  };
}

/**
 * Forget the calls that answered whose result the framework stored: those
 * of which `stored(id, failed)` is true for the last id they were made with,
 * `failed` the error that answered the call, if one did. Called
 * after each commit of steps, and before each tool call, with the transcript as the
 * framework stored it: also in an attempt that made no call yet, which would
 * otherwise take one an earlier attempt made, and the model has the result
 * of.
 */
export async function settleCalls(ctx: restate.SessionContext, stored: (id: string, failed?: string) => boolean) {
  const state = await attemptOf(ctx).calls;
  const kept = state.calls.filter((c) => !c.done || !stored(c.ids.at(-1)!, c.failed));
  if (kept.length === state.calls.length) return;
  state.calls = kept;
  await ride(ctx, state);
}

/**
 * Which of `callIds` made a Restate call that answered, in this invocation
 * or in `invocation`: each with the terminal error it answered with
 * (`Error: <message>`), or `undefined` if it succeeded. A tool call whose
 * call did not answer, or that made none, is left out; so is one whose only
 * answered call is its approval, which it ran (or was denied) after.
 *
 * An earlier `invocation`'s calls are read only while they are still
 * stored, until an invocation of the key makes calls of its own; read,
 * never changed. With `prompt`, the calls of its turn only.
 */
export async function outcomes(
  ctx: restate.SessionContext,
  callIds: Iterable<string>,
  invocation?: string,
  prompt?: string,
): Promise<Map<string, string | undefined>> {
  const state =
    invocation !== undefined && invocation !== ctx.request.id
      ? await load(ctx, invocation)
      : await attemptOf(ctx).calls;
  const wanted = new Set(callIds);
  const found = new Map<string, string | undefined>();
  for (const call of state.calls) {
    if (!call.done || call.approval) continue;
    // Another prompt's call, of the same invocation: not this turn's.
    if (prompt !== undefined && call.prompt !== undefined && call.prompt !== prompt) continue;
    for (const id of call.ids) if (wanted.has(id)) found.set(id, call.failed);
  }
  return found;
}

/**
 * Write what rides the next commit ({@link ride}) now, if it is pending: at
 * the end of a turn, when no commit follows that would.
 */
export const flushCalls = (ctx: restate.SessionContext) => flushRiders(ctx.db);
