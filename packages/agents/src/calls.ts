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
// last id it was made with ({@link settleCalls}, at each publish, and before each
// tool call): one that answered just before a crash, whose result the
// framework had not stored, is made again as the same call. An error there
// is not its result (the DeepSeek Harness gives the call it interrupted
// one, and the model makes it again), unless the call answered with that error: a
// terminal error is its result too. Once stored, the model has its result,
// and an identical call it makes later is a call of its own.
//
// A framework's own wait ({@link waitFor} of tools.ts) is its tool call's
// alone: the framework stored its tool call before it waits, so a retried
// attempt waits again under the same id, and a new call with the same input
// (the model asking again, after the first's answer) waits anew. An approval
// a tool call waited for is not the call: a stopped turn does not report the
// call as done because its approval returned ({@link outcomes}).
import type * as restate from '@restatedev/sessions';
import { Schema, ScopeKey } from '@restatedev/sessions/internal';
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

/** The table of the {@link Calls}: one row, of the invocation whose calls they are. */
const SCHEMA = new Schema('restate-agents.calls', [
  `CREATE TABLE restate_agent_calls (
    row INTEGER PRIMARY KEY CHECK (row = 0),
    invocation TEXT NOT NULL,
    calls TEXT NOT NULL
  )`,
]);

/** What the calls need of a handler's context. */
type CallsContext = Pick<restate.SessionContext, 'db' | 'request'>;

/** Store `calls`, committed before the call they record is made. */
async function store(ctx: CallsContext, { invocation, calls }: Calls) {
  await ctx.db.execute('INSERT OR REPLACE INTO restate_agent_calls (row, invocation, calls) VALUES (0, ?, ?)', [
    invocation,
    JSON.stringify(calls),
  ]);
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

/** Each attempt's id, and its calls, by its context. */
const ATTEMPT = new ScopeKey<{ id: string; calls: Promise<Calls> }>('the calls of an attempt');

/** The attempt of `ctx`: its id, and the calls of its invocation (loaded once, shared by calls made at once). */
function attemptOf(ctx: restate.SessionContext) {
  return ATTEMPT.of(ctx, () => ({ id: randomUUID(), calls: load(ctx, ctx.request.id) }));
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
     */
    async answered(failed?: string) {
      made.done = true;
      if (failed !== undefined) made.failed = failed;
      await store(ctx, state);
    },
  };
}

/**
 * Forget the calls that answered whose result the framework stored: those
 * of which `stored(id, failed)` is true for the last id they were made with,
 * `failed` the error that answered the call, if one did. Called
 * at each publish, and before each tool call, with the transcript as the
 * framework stored it: also in an attempt that made no call yet, which would
 * otherwise take one an earlier attempt made, and the model has the result
 * of.
 */
export async function settleCalls(ctx: restate.SessionContext, stored: (id: string, failed?: string) => boolean) {
  const state = await attemptOf(ctx).calls;
  const kept = state.calls.filter((c) => !c.done || !stored(c.ids.at(-1)!, c.failed));
  if (kept.length === state.calls.length) return;
  state.calls = kept;
  await store(ctx, state);
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
