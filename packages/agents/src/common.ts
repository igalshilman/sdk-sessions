// What the frameworks share: their options (`Configure`, the model), the
// ids of an invocation's prompts, the `chat` handler with its turn (status,
// cancellation, publishing for the clients that follow it), and what the
// conversation of turns (conversation.ts) takes: its notes, window and
// budget.
import * as restate from '@restatedev/sessions';
import { cancelCalls, cancelled, definitionOf, Link, ScopeKey } from '@restatedev/sessions/internal';
import { settleCalls } from './calls.ts';
import { signals, signalsOf } from './signals.ts';

/**
 * A value, or a function of the invocation's context that gives it: the
 * same for every message, or each user's (from the object's database, say).
 *
 *   pi.chat({ model: 'openai/gpt-6-sol' })
 *   pi.chat(async (ctx) => ({ model: await userModel(ctx) }))
 */
export type Configure<T> = T | ((ctx: restate.SessionContext) => T | Promise<T>);

/** `value` for the invocation of `ctx`. */
export const configured = async <T>(value: Configure<T>, ctx: restate.SessionContext): Promise<T> =>
  typeof value === 'function' ? (value as (ctx: restate.SessionContext) => T | Promise<T>)(ctx) : value;

/** The prompts each invocation made so far, by its context. */
const PROMPTS = new ScopeKey<number>('nextPromptId');

/**
 * The id of the next prompt of the invocation of `ctx`: the invocation's id,
 * then `<id>:2`, `<id>:3`... A retried attempt makes its prompts in the same
 * order, so each gets the same id again, and its answer.
 */
export const nextPromptId = (ctx: restate.SessionContext) => {
  const n = (PROMPTS.get(ctx) ?? 0) + 1;
  PROMPTS.set(ctx, n);
  return n === 1 ? ctx.request.id : `${ctx.request.id}:${n}`;
};

/** The default model of pi and LangGraph, with OPENAI_API_KEY. */
export const DEFAULT_MODEL = 'openai/gpt-6-sol';

/** The default model of Claude agents, with ANTHROPIC_API_KEY. */
export const CLAUDE_MODEL = 'anthropic/claude-sonnet-5-5';

/**
 * The model, as `provider/model-id` (such as `openai/gpt-6-sol`):
 * `model`, or else MODEL, or else the framework's default.
 */
export const modelOf = (model: string | undefined, fallback = DEFAULT_MODEL) => model || process.env.MODEL || fallback;

/** `provider/model-id` as its provider and model id, split at the first `/` (`openrouter/meta-llama/llama-4`). */
export const providerOf = (model: string): [provider: string, id: string] => {
  const slash = model.indexOf('/');
  return slash < 0 ? ['', model] : [model.slice(0, slash), model.slice(slash + 1)];
};

/**
 * The error code of a message the model's provider refused (a missing or
 * wrong API key, an unknown model): 424, Failed Dependency, as its HTTP
 * status.
 */
export const REFUSED = 424;

/** What to check when a model's provider refuses a request. */
export const CHECK_MODEL = "check the agent's model (its `model` option, or MODEL) and its provider's API key";

/**
 * An agent's model that it cannot take: not `provider/model-id`, another
 * provider's, or one its framework does not know. Terminal ({@link REFUSED}),
 * wherever it is thrown: a retry takes the same model.
 */
export class ModelError extends restate.TerminalError {
  constructor(message: string) {
    super(message, { errorCode: REFUSED });
    this.name = 'ModelError';
  }
}

/** `model`, the explicit `model` option of `framework`'s agent, if it is not `provider/model-id`. */
export const checkModelName = (framework: string, model: string | undefined) => {
  if (model !== undefined && !/^[^/\s]+\/\S+$/.test(model)) {
    throw new ModelError(`${framework}: the model "${model}" is not provider/model-id, such as openai/gpt-6-sol`);
  }
};

/**
 * The model id of `model`, for a framework with only `provider`'s models:
 * `provider/model-id`, or the id alone.
 */
export const modelIdOf = (model: string, provider: string) => {
  const [named, id] = model.includes('/') ? providerOf(model) : [provider, model];
  if (named !== provider || !id) {
    const from = process.env.MODEL === model ? ' (from MODEL)' : '';
    throw new ModelError(`the model "${model}"${from} is not ${provider}'s: this agent takes ${provider}/<model-id>`);
  }
  return id;
};

/** A chat message: the request's body as text, or the string it is as JSON (`"Hi"`). */
export const messageSerde: restate.Serde<string> = {
  contentType: 'text/plain',
  serialize: (text) => new TextEncoder().encode(text),
  deserialize: (bytes) => {
    const text = new TextDecoder().decode(bytes);
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? value : text;
    } catch {
      return text;
    }
  },
};

/**
 * What an empty answer says, as the model sees it later in the conversation:
 * a provider's API may refuse an empty text (Anthropic's does).
 */
export const NO_ANSWER = '(no answer)';

/**
 * What a cancelled turn answers, and each tool call it cut off: the model
 * sees it in the conversation that goes on.
 */
export const CANCELLED = 'Cancelled: the turn was stopped before it finished.';

/**
 * What a prompt answers that the model's provider refused for good (see
 * {@link refusal}): the prompt is over, and the model sees it in the
 * conversation that goes on, rather than answer it with the next message.
 */
export const UNANSWERED = "Unanswered: the model's provider refused the request.";

/**
 * What a turn whose invocation ended without answering it (killed, say)
 * answers, and each tool call it cut off: the next message, or the companion
 * once it finds the invocation gone (`settle`), closes it with this.
 */
export const ENDED = 'Ended: the turn ended before it finished, and was not answered.';

/** The result of a tool call a stopped turn cut off once its Restate call had answered: it happened. */
export const RETURNED_UNRECORDED =
  "Done, but the turn was stopped before this call's result was recorded: it did happen, so check its effect before doing it again.";

/**
 * What a stopped turn records as the result of its tool call `callId`, which
 * has none: `text` (cancelled, say), unless the call's Restate call answered
 * (`outcomes` of calls.ts), which the model would take for undone, and do
 * again: then the error it answered with, or {@link RETURNED_UNRECORDED}.
 */
export function cutOffResult(outcomes: ReadonlyMap<string, string | undefined>, callId: string, text: string) {
  if (!outcomes.has(callId)) return text;
  return outcomes.get(callId) ?? RETURNED_UNRECORDED;
}

/** How many of the latest answered turns the model sees whole (with their tool calls and results), or `'all'`. */
export type Window = number | 'all';

/** The window by default: the previous turn's tool calls and results stay in view, for a follow-up. */
export const WINDOW: Window = 1;

/** How many tokens of the turns before the window the model sees, by default, counted as 4 characters each. */
export const BUDGET = 32_000;

/** How an agent summarizes earlier turns: from the request ({@link SUMMARIZE} and the turns, as text) to the summary. */
export type Summarize = (ctx: restate.SessionContext, request: string) => Promise<string>;

/** What a request to summarize earlier turns starts with, before the turns themselves. */
export const SUMMARIZE =
  "Summarize the conversation below, for the assistant who carries it on: keep the facts, names, numbers, decisions, the user's preferences, and what is still open. Answer with the summary only.\n\n";

/**
 * What a turn checks its answer with: nothing if the answer is what was
 * asked for, else the message that asks the model again, once, within the
 * turn (`answerOnce`'s `check`). With `last`, the model was asked again
 * already: a check that throws a terminal error then fails the turn, which
 * is closed with it.
 */
export type Check = (answer: string, last?: boolean) => string | undefined;

/** `window`, if it is one: a whole number of turns (0 or more), or `'all'`. */
export function checkWindow(window: Window): Window {
  if (window !== 'all' && !(Number.isInteger(window) && window >= 0)) {
    throw new Error(`window must be a number of turns (0 or more) or 'all', not ${JSON.stringify(window)}`);
  }
  return window;
}

/** The message a `chat` handler is answering: its invocation, and when it started. */
export interface Answering {
  /** The invocation's id: `/restate/invocation/<id>/attach` waits for its answer. */
  invocationId: string;
  /** When it started, as an ISO date. */
  since: string;
}

/** What stops each turn, by its context: see {@link stopSignalOf}. */
const TURN = new ScopeKey<AbortSignal>('stopSignalOf');

/**
 * Why a turn stopped when its attempt ended before it did: Restate suspended
 * the attempt, gave up on it, or lost its connection. Nothing the attempt
 * does after is stored, and the next attempt goes on with the turn, so it
 * stops without answering: unlike a cancellation, nothing is cancelled.
 */
export class AttemptEnded extends Error {
  constructor() {
    super('the attempt ended before its turn did');
    this.name = 'AttemptEnded';
  }
}

/**
 * The signal that stops the turn of `ctx` (of a `chat` handler,
 * `chatHandler`), and an agent's `prompt` stops its framework's work with it.
 * It aborts with a `restate.CancelledError` once Restate cancels the
 * invocation (the turn ends, answered as cancelled), or with an
 * {@link AttemptEnded} once the attempt ends first (the work stops, and
 * answers nothing).
 */
export const stopSignalOf = (ctx: restate.SessionContext): AbortSignal | undefined => TURN.get(ctx);

/**
 * An agent's settings: whether it runs in the background (`background:
 * true`: no one follows it as it works), and, for an agent on the
 * conversation of turns (conversation.ts), its framework's items, how much
 * of the conversation its model sees (`window` and `budget`), and how it
 * summarizes the earliest turns (`summarize`).
 */
export interface Settings {
  background: boolean;
  /** The items of its framework, if it keeps the conversation of turns (its `messages` view is `conversationView`'s). */
  items?: object;
  window: Window;
  budget: number;
  summarize?: Summarize;
}

/** An agent's settings, on its definition. */
const AGENT = new Link<Settings>('an agent');

/** The items of a framework's `messages` view on the conversation of turns. */
export const ITEMS = new Link<object>('restate-agents.items');

/** `definition` is an agent's, with these settings: its framework's items, if it is on the conversation of turns. */
export const isAgent = <D extends object>(
  definition: D,
  {
    background = false,
    items = undefined as object | undefined,
    window = WINDOW as Window,
    budget = BUDGET,
    summarize = undefined as Summarize | undefined,
  },
) => {
  return AGENT.on(definition, {
    background,
    items,
    window,
    budget,
    summarize,
  });
};

/** The settings of the agent of `ctx`, if it is one. */
const agentOf = (ctx: restate.SessionContext) => {
  const definition = definitionOf(ctx);
  return definition && AGENT.of(definition);
};

/** The settings of the agent of `ctx`: the defaults, for an object that is no agent. */
export const settingsOf = (ctx: restate.SessionContext): Settings =>
  agentOf(ctx) ?? { background: false, window: WINDOW, budget: BUDGET };

/** Whether the agent of `ctx` runs in the background. */
const unfollowed = (ctx: restate.SessionContext) => agentOf(ctx)?.background === true;

/** The `signals` object of the agent of `ctx`. */
const signalsOfAgent = (ctx: restate.SessionContext) => ctx.rpc(signals, signalsOf(ctx));

/**
 * The conversation of `ctx` changed (see `watch` in object.ts): its revision
 * increases, and the clients that follow it read it again; while a framework
 * answers ({@link answering}), the calls whose results it stored are
 * forgotten first. It is a call to Restate, so it also sends what the
 * handler wrote before, for them to read.
 */
export const publish = async (ctx: restate.SessionContext) => {
  const stored = ANSWERING.get(ctx);
  if (stored) await settled(ctx, stored);
  await signalsOfAgent(ctx).publish();
};

/** A step of a turn of `ctx`: {@link publish} it, unless the agent runs in the background, which publishes the turn's end only. */
export const stepped = async (ctx: restate.SessionContext) => {
  if (!unfollowed(ctx)) await publish(ctx);
};

/**
 * A tool call of the turn of `ctx` starts: {@link publish} it, which forgets
 * the calls whose results are stored (calls.ts) before the tool makes its
 * own. In the background, which publishes the turn's end only, it forgets
 * them alone.
 */
export async function toolCallStarted(ctx: restate.SessionContext) {
  if (!unfollowed(ctx)) return publish(ctx);
  const stored = ANSWERING.get(ctx);
  if (stored) await settled(ctx, stored);
}

/** A tool call of the turn of `ctx` (a `chat` handler's) ended: {@link publish} it, unless the agent runs in the background. */
export async function toolCallEnded(ctx: restate.SessionContext) {
  await stepped(ctx);
}

/** Whether a tool call's result is stored: `stored(callId, failed)`, `failed` the error the call answered with. */
export type Stored = (callId: string, failed?: string) => boolean;

/** What the attempt's turn has stored, while it answers (see {@link answering}). */
const ANSWERING = new ScopeKey<Stored>('answering');

/** The attempt's latest settling of calls: one after another, as parallel tool calls publish at once. */
const SETTLING = new ScopeKey<Promise<void>>('settling');

/** Forget the calls whose results the conversation stored (calls.ts), after any settling before. */
function settled(ctx: restate.SessionContext, stored: Stored): Promise<void> {
  const settle = () => settleCalls(ctx, stored);
  const done = (SETTLING.get(ctx) ?? Promise.resolve()).then(settle, settle);
  SETTLING.set(ctx, done);
  return done;
}

/**
 * Run `work`, a framework's turn on the conversation of turns, forgetting
 * the calls whose results it stores as it goes: each publish while it runs
 * (a tool call's start and end), and its end, forget the Restate calls of
 * the tool calls whose results `stored` says are stored (calls.ts).
 */
export async function answering<T>(ctx: restate.SessionContext, stored: Stored, work: () => Promise<T>): Promise<T> {
  const outer = ANSWERING.get(ctx);
  ANSWERING.set(ctx, stored);
  let failed = false;
  try {
    return await work();
  } catch (error) {
    failed = !(error instanceof restate.TerminalError);
    throw error;
  } finally {
    try {
      // A failed attempt stores nothing more: its retry runs again.
      if (!failed) await settled(ctx, stored);
    } finally {
      if (outer) ANSWERING.set(ctx, outer);
      else ANSWERING.delete(ctx);
    }
  }
}

/** A promise that rejects with `signal`'s reason once it aborts. */
export const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/**
 * `answer` as a chat handler, which takes its message as plain text or as a
 * JSON string, so that both of these work:
 *
 *   curl localhost:8080/assistant/alice/chat -d 'Hi'
 *   curl localhost:8080/assistant/alice/chat --json '"Hi"'
 *
 * While it answers, the object's `status` says so (its {@link Answering}). Its
 * invocation's cancellation (Restate's, explicit: `cancelled(ctx)` of
 * @restatedev/sessions/internal) aborts {@link stopSignalOf} its
 * context, whenever it comes, and cancels the calls its tools made
 * (`cancelCalls(ctx)`): the agent's `prompt`
 * ends the turn, and the handler fails with a `restate.CancelledError`. An
 * attempt that ends first (`attemptCompletedSignal`) aborts it too, with an
 * {@link AttemptEnded}: the work stops, and the next attempt goes on with it.
 *
 * It publishes when it starts and ends ({@link publish}), for the clients
 * that follow the conversation.
 */
export const chatHandler = <A = string>(answer: (ctx: restate.SessionContext, message: string) => Promise<A>) => ({
  input: messageSerde,
  accept: '*/*',
  explicitCancellation: true,
  handler: async (ctx: restate.SessionContext, text: string): Promise<A> => {
    const invocationId = ctx.request.id;
    // The companion knows the turn from here to its close: `status` and `stop` ask it.
    // An agent on the conversation of turns has `settle`: the companion sends it
    // this turn, should its invocation be gone without closing it.
    const settles = agentOf(ctx)?.items !== undefined;
    await ctx
      .rpc(signals, signalsOf(ctx))
      .start({ invocationId, since: new Date().toISOString(), ...(settles ? { settles } : {}) });
    await stepped(ctx);
    // The log takes the turn's last change, then the companion closes the
    // turn, which publishes it: one revision. The close is a call the turn
    // waits for, so that it is done before the turn ends (see `awaitTurn`).
    const end = async () => {
      const stored = ANSWERING.get(ctx);
      if (stored) await settled(ctx, stored);
      await signalsOfAgent(ctx).close(invocationId);
    };
    const turn = new AbortController();
    TURN.set(ctx, turn.signal);
    void (async () => {
      await cancelled(ctx);
      turn.abort(new restate.CancelledError());
      await cancelCalls(ctx);
    })().catch(() => {});
    // The attempt ends before the turn does: its work stops (a model's
    // request, say), rather than run on for an attempt that can store nothing.
    const attempt = ctx.request.attemptCompletedSignal;
    const attemptEnded = () => turn.abort(new AttemptEnded());
    attempt.addEventListener('abort', attemptEnded, { once: true });
    let answered: A;
    try {
      answered = await answer(ctx, text);
      // Cancelled once answered: the answer stands.
    } catch (error) {
      if (error instanceof restate.TerminalError) {
        await end();
        throw error;
      }
      // Any other error fails the attempt, and Restate retries the turn.
      const terminal = refusalOf(ctx, error);
      if (!terminal) throw error;
      await end();
      throw terminal;
    } finally {
      // An attempt's signal aborts at every attempt's end, the turn's too.
      attempt.removeEventListener('abort', attemptEnded);
    }
    await end();
    return answered;
  },
});

/** A tool's error, which fails the attempt (Restate retries it): the error `cause` of tool `tool`. */
export class ToolError extends Error {
  readonly tool: string;
  constructor(tool: string, cause: unknown) {
    super(`the tool ${tool} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ToolError';
    this.tool = tool;
  }
}

/** The errors the attempt's framework tools (not `tool()`'s) failed with: see {@link fromTool}. */
const TOOL_ERRORS = new ScopeKey<WeakSet<object>>('fromTool');

/**
 * `error` is a tool's, in the attempt of `ctx`: a framework's own tool
 * (Claude's, LangChain's...) that failed, whose error is never taken for
 * the model's provider refusing (a tool that calls a model API may fail as
 * one does). `tool()`'s are {@link ToolError}s.
 */
export function fromTool(ctx: restate.SessionContext, error: unknown) {
  if (typeof error === 'object' && error !== null) TOOL_ERRORS.of(ctx, () => new WeakSet()).add(error);
}

/** The Anthropic SDK's errors of a request that fails again however often it is made. */
const FOR_GOOD: ReadonlySet<string> = new Set([
  'AuthenticationError',
  'PermissionDeniedError',
  'NotFoundError',
  'BadRequestError',
]);

/**
 * Whether `error` is a model provider's refusal that a retry does not change:
 * a missing or wrong API key, an unknown model, a bad request. Other errors
 * (a tool's, an overloaded provider's) fail the attempt, and Restate retries.
 */
function refused(error: unknown) {
  if (error instanceof ToolError) return false;
  if (error instanceof Error && FOR_GOOD.has(error.constructor.name)) return true;
  return /API key not found|no API key|Could not resolve authentication method|Provider is not configured|"code":"(AUTH|MISSING_CREDENTIAL)"/i.test(
    String(error),
  );
}

/** {@link refusal}, but not of an error a framework's tool failed with in the attempt of `ctx` ({@link fromTool}). */
export function refusalOf(ctx: restate.SessionContext, error: unknown): restate.TerminalError | undefined {
  const failedTool = typeof error === 'object' && error !== null && TOOL_ERRORS.get(ctx)?.has(error);
  return failedTool ? undefined : refusal(error);
}

/**
 * `error` as a terminal error ({@link REFUSED}), if a retry does not change
 * it: a model the agent cannot take, or its provider's refusal.
 */
export function refusal(error: unknown): restate.TerminalError | undefined {
  if (error instanceof ModelError) return error;
  if (error instanceof restate.TerminalError || !refused(error)) return undefined;
  return new restate.TerminalError(`the model's provider refused the request: ${CHECK_MODEL}. ${String(error)}`, {
    errorCode: REFUSED,
  });
}

/**
 * A prompt's stored answer, as the prompt returns it, by how its turn ended
 * (`status`): a turn refused ({@link UNANSWERED}) fails with
 * {@link REFUSED}, one failed for good with its error, one cancelled with
 * the cancellation, one another invocation ended with its note; so that a
 * retry after a crash right after the close fails as the prompt did.
 */
export function storedAnswer(answer: string, status = 'answered'): string {
  if (status === 'refused') {
    throw new restate.TerminalError(`the model's provider refused the request: ${CHECK_MODEL}`, { errorCode: REFUSED });
  }
  if (status === 'cancelled') throw new restate.CancelledError();
  if (status === 'failed') throw new restate.TerminalError(answer.replace(/^Error: /, ''));
  if (status === 'ended') throw new restate.TerminalError(answer);
  return answer;
}

/** A message of a conversation, as an agent's `messages` handler returns it. */
export interface ChatMessage {
  /** Its id, from 0, in the order of the conversation; the same however it changes. `before` takes it. */
  id: number;
  role: 'user' | 'assistant';
  parts: Part[];
}

/**
 * What a message says: text, or a tool call with its output once it ran,
 * and `error: true` if the output is the tool's error (`Error: <message>` of
 * a `restate.TerminalError`, say).
 */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; output?: string; error?: true };

/**
 * Which messages to read: the latest `limit`, or those before a message, for
 * a page of the conversation; or those new or changed since a `cursor`, to
 * follow it.
 */
export interface MessagesRequest {
  /**
   * `full` (the default): every message, with its tool calls; `summary`:
   * each turn's message of the user and its answer, under the ids they have
   * in the full view.
   */
  view?: 'full' | 'summary';
  /** At most this many messages (default 50). */
  limit?: number;
  /** The messages before this one (its `id`): older ones, such as for scrolling back. */
  before?: number;
  /** The messages new or changed since this cursor (a page's `cursor`), by when they changed. */
  cursor?: number;
}

/**
 * A page of messages: oldest first; or, with a `cursor`, those new or
 * changed since it, by when they changed. Keep them by `id`: a message comes
 * again once it changed (its tool call's output came, say).
 */
export interface Messages {
  messages: ChatMessage[];
  /** Whether there are more: older ones, or with a `cursor`, newer ones. */
  more: boolean;
  /** The cursor to read on from: what changes after this page. */
  cursor: number;
  /**
   * The id of the conversation's first message, once it was cleared
   * (`clear`): a client drops the messages it kept from before.
   */
  first?: number;
}
