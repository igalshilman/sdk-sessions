// Session objects: Restate virtual objects whose state is a SQL database per
// key. Its handlers run one at a time per key, its views beside them; each
// gets a context of its own, made of the key, the request, the database and
// calls, and nothing else of the SDK's context:
//
//   const notes = restate.sessionObject({
//     name: 'notes',
//     schema: ['CREATE TABLE notes (text TEXT NOT NULL)'],
//     handlers: {
//       add: async (ctx, text: string) => {
//         await ctx.db.execute('INSERT INTO notes (text) VALUES (?)', [text]);
//       },
//     },
//     views: {
//       list: async (ctx) => ctx.db.query<{ text: string }>('SELECT text FROM notes'),
//     },
//   });
import * as restate from '@restatedev/restate-sdk';
import type { VirtualObjectDefinition } from '@restatedev/restate-sdk-core';
import { type Rpc, rpcOf, type Send, sendOf } from './calls.ts';
import type { DatabaseReader, Store } from './database.ts';
import { ensureOf, ensuring, Schema, type Step } from './schema.ts';
import { Link } from './link.ts';
import { holding, Scope, scopeOf } from './scope.ts';
import { hookSelector } from './selector.ts';
import { type Database, Attempt, type ObjectConfig, type SqlHost, withAttempt } from './session.ts';

/**
 * The context of a session object's handler. A handler runs in attempts:
 * Restate starts a new one after a crash, a retryable error or a
 * suspension, and each runs the handler from its first line, finding what
 * the attempts before it committed. Its operations can be awaited together
 * (`Promise.all`, `Promise.race`).
 */
export interface SessionContext {
  /** The session's key. */
  readonly key: string;
  /** The request: its id (the same on every attempt), headers, target, and the attempt's signal. */
  readonly request: restate.Request;
  /**
   * The key's database. Each statement outside a transaction is its own
   * commit, and `db.transaction` groups several; a commit is durable when
   * its promise resolves. Calls run one at a time, in call order.
   */
  readonly db: Database;
  /** Calls, typed (`ctx.rpc(object, key).handler(input)`) or literal. */
  readonly rpc: Rpc;
  /** Sends, made at once; a transaction's (`tx.send`) are made once it commits. */
  readonly send: Send;
  /** Cancel an invocation, by its id: see {@link Cancel}. */
  readonly cancel: Cancel;
}

/**
 * The context of a session object's view: it runs beside the handlers, and
 * reads the database as committed when its invocation started, whatever they
 * commit meanwhile. It writes nothing, and sends nothing, but it can cancel an
 * invocation: a handler of its own object's, say, as a Stop button does.
 */
export interface ViewContext {
  readonly key: string;
  readonly request: restate.Request;
  readonly db: DatabaseReader;
  readonly rpc: Rpc;
  readonly cancel: Cancel;
}

/**
 * Cancel invocation `invocationId` (such as `inv_1f…`), as Restate's admin
 * API does: made at once, and not awaited. Cancelling an invocation that
 * already ended does nothing, so a new attempt that cancels it again is
 * harmless.
 *
 *   ctx.cancel(turn.invocationId);
 */
export type Cancel = (invocationId: string) => void;

/** A handler of `C`: its input, if any, annotated. */
// oxlint-disable-next-line typescript/no-explicit-any
type Fn<C> = (ctx: C, input: any) => Promise<unknown>;

/** The SDK's options of a handler (`input`, `output`, `description`, `ingressPrivate`, ...). */
// oxlint-disable-next-line typescript/no-explicit-any
export type HandlerOptions = restate.ObjectHandlerOpts<any, any>;

/** A handler or a view: a function, or one with options. */
export type Entry<C> = Fn<C> | ({ handler: Fn<C> } & HandlerOptions);

/** Each entry's function, as clients see it; none for entries left out (inferred as the constraint). */
type Functions<H> = string extends keyof H ? unknown : { [K in keyof H]: H[K] extends { handler: infer F } ? F : H[K] };

/**
 * The key of the object database's head, its first read as it opens:
 * `HEAD_KEY` in the addon's state format
 * (`packages/sessions/native/src/state/format.rs`).
 */
export const HEAD_KEY = 'v22/head';

/**
 * The options every session object has: an invocation starts with the
 * database's head only, not with every page. The rest of the database it
 * reads as it needs it: its tail entries and packs change keys with each
 * flush, so only the head can be named.
 */
export const sqlOptions = { state: { preload: [HEAD_KEY] } } satisfies restate.ObjectOptions;

/**
 * The metadata every session object has: Restate's UI hides the database
 * from the journal view (its head, tail, manifests and packs in the object's
 * state, `v22/...`; and the `sync` runs after its writes).
 */
export const sqlMetadata = {
  'dev.restate.tooling.journal.hidden.names': 'sync',
  'dev.restate.tooling.journal.hidden.name.prefix': 'v22/',
};

// The handler options of every handler: explicit recovery, which runs a
// retried attempt from the start, since a later attempt makes different
// reads than a replayed journal would have.
export const recovery = () => restate.internal.explicitRecovery();

/** The SDK's runtime context, as far as the session needs it beyond its public type. */
type Runtime = { invocationEndPromise: SqlHost['invocationEndPromise']; defaultSerde: SqlHost['defaultSerde'] };

/** What an attempt needs of the SDK's context: a test's fake has these. */
export type AttemptContext = Pick<
  restate.ObjectContext,
  'key' | 'request' | 'get' | 'set' | 'clear' | 'stateKeys' | 'run' | 'genericSend' | 'genericCall' | 'invocation'
> &
  Runtime;

/** What an attempt's session needs of the SDK's context `ctx`. */
export function host(
  ctx: restate.ObjectContext | restate.ObjectSharedContext | AttemptContext,
  shared: boolean,
): SqlHost {
  const runtime = ctx as unknown as Runtime;
  const exclusive = ctx as restate.ObjectContext;
  return {
    shared,
    key: ctx.key,
    invocationEndPromise: runtime.invocationEndPromise,
    defaultSerde: runtime.defaultSerde,
    request: () => ctx.request(),
    get: (name, serde, entry) => ctx.get(name, serde, entry),
    set: (name, value, serde, entry) => exclusive.set(name, value, serde, entry),
    clear: (name, entry) => exclusive.clear(name, entry),
    stateKeys: () => ctx.stateKeys(),
    run: (name, action) => exclusive.run(name, action),
    genericSend: (send) => ctx.genericSend(send),
  };
}

/** A session object's: its config, which its attempts get, and its definition, once made. */
interface ObjectState {
  readonly config: ObjectConfig;
  definition?: object;
}

/** A handler or view of a session object: its function, kind, and object. */
interface HandlerEntry {
  fn: Fn<never>;
  view: boolean;
  explicit: boolean;
  object: ObjectState;
}

/** A session object's own, on its definition: for {@link invoke} and {@link withStoreWrapper}. */
const OBJECT = new Link<{ object: ObjectState; entries: Map<string, HandlerEntry> }>('a session object');

/**
 * The definition (`sessionObject`'s) of the object whose handler or view
 * `ctx` is the context of: what a library keeps per object lives on it.
 */
export const definitionOf = (ctx: SessionContext | ViewContext): object | undefined => scopeOf(ctx)?.definition;

/** What `definition`'s attempts get, if it is a session object: for a test's attempts of its own. */
export const configOf = (definition: object): ObjectConfig | undefined => OBJECT.of(definition)?.object.config;

/**
 * Wrap the stores of `definition`'s attempts with `wrap`: fault injection, in
 * tests. A definition that is no session object has no store: it is left as
 * it is.
 */
export function withStoreWrapper<D extends object>(definition: D, wrapper: (store: Store) => Store): D {
  const object = OBJECT.of(definition);
  if (object !== undefined) object.object.config.wrapStore = wrapper;
  return definition;
}

/** The reads of `db`, which apply a library's schema as `db` does (`Schema.ensure`). */
function readerOf(db: Database): DatabaseReader {
  const reader: DatabaseReader = {
    query: (sql, params) => db.query(sql, params),
    get: (sql, params) => db.get(sql, params),
    values: (sql, params) => db.values(sql, params),
  };
  const ensure = ensureOf(db);
  return Object.freeze(ensure ? ensuring(reader, ensure) : reader);
}

/**
 * The context of a handler (or, with `view`, of a view) over the SDK's
 * context `ctx`, with the database `db`: what an attempt gets, and a test's
 * over a context of its own. With `explicitCancellation`, a handler's with
 * that option, which {@link cancelled} and {@link cancelCalls} take.
 */
export function contextOf(ctx: AttemptContext, db: Database, options: { view: true; definition?: object }): ViewContext;
export function contextOf(
  ctx: AttemptContext,
  db: Database,
  options?: { view?: false; explicitCancellation?: boolean; definition?: object },
): SessionContext;
export function contextOf(
  ctx: AttemptContext,
  db: Database,
  {
    view = false,
    explicitCancellation = false,
    definition,
  }: { view?: boolean; explicitCancellation?: boolean; definition?: object } = {},
): SessionContext | ViewContext {
  const rpc = rpcOf(ctx);
  const cancel = cancelOf(ctx);
  // It holds the attempt's scope (scope.ts), then is frozen.
  const scope = new Scope(ctx as unknown as restate.ObjectContext, { explicitCancellation, definition });
  const context: SessionContext | ViewContext = holding(
    view
      ? { key: ctx.key, request: ctx.request(), db: readerOf(db), rpc, cancel }
      : {
          key: ctx.key,
          request: ctx.request(),
          db,
          rpc,
          send: sendOf((send) => void ctx.genericSend(send)),
          cancel,
        },
    scope,
  );
  return Object.freeze(context);
}

/** {@link Cancel} over the SDK's context `ctx`. */
const cancelOf =
  (ctx: Pick<restate.ObjectContext, 'invocation'>): Cancel =>
  (invocationId) => {
    // Not an id (the SDK's parser checks no more): a retry would fail the same way.
    if (!invocationId.startsWith('inv')) throw new restate.TerminalError(`not an invocation id: ${invocationId}`);
    ctx.invocation(restate.InvocationIdParser.fromString(invocationId)).cancel();
  };

/** One attempt of `entry` over `ctx`: its own context and session, which ends with it. */
function attempt({ fn, view, explicit, object }: HandlerEntry, ctx: AttemptContext, input: unknown): Promise<unknown> {
  const session = new Attempt(host(ctx, view), object.config);
  session.openNow();
  const { definition } = object;
  const context = view
    ? contextOf(ctx, session.db, { view: true, definition })
    : contextOf(ctx, session.db, { explicitCancellation: explicit, definition });
  return withAttempt(() => fn(context as never, input as never), session);
}

/** `entry` as the SDK's handler: one loop drives each attempt's awaits (see selector.ts), until it ends. */
function wrap(entry: HandlerEntry) {
  return (ctx: restate.ObjectContext | restate.ObjectSharedContext, input: never) => {
    const unhook = hookSelector(ctx);
    const runtime = ctx as unknown as Runtime;
    runtime.invocationEndPromise.promise.catch(unhook);
    return attempt(entry, ctx as unknown as AttemptContext, input).finally(unhook);
  };
}

/**
 * Run handler or view `name` of `definition` for one attempt over `ctx`, a
 * context of a test's own, without Restate: for tests.
 */
export function invoke(definition: { name: string }, name: string, ctx: AttemptContext, input?: unknown) {
  const entry = OBJECT.of(definition)?.entries.get(name);
  if (entry === undefined) throw new Error(`${definition.name}.${name} is no handler or view of a session object`);
  return attempt(entry, ctx, input);
}

/** Whether `value` is a handler of the SDK's already. */
const isSdkHandler = (value: object) => Object.getOwnPropertySymbols(value).some((s) => s.description === 'Handler');

/** The SDK's handler of entry `name` of `object`. */
function handlerOf(objectName: string, name: string, entry: unknown, view: boolean, object: ObjectState) {
  const [fn, options] =
    typeof entry === 'function'
      ? [entry, {}]
      : typeof entry === 'object' && entry !== null && typeof (entry as { handler?: unknown }).handler === 'function'
        ? (() => {
            const { handler, ...rest } = entry as { handler: Fn<never> } & HandlerOptions;
            return [handler, rest] as const;
          })()
        : [undefined, undefined];
  if (fn === undefined)
    throw new TypeError(`${objectName}.${name} is not a handler: a function, or { handler, ...options }`);
  if (isSdkHandler(fn)) {
    throw new TypeError(
      `${objectName}.${name} is an SDK handler: a session object's handlers are functions of its context. ` +
        'Put journaled work in a restate.object, service or workflow, and call it with ctx.rpc',
    );
  }
  const opts = { ...options, ...recovery() } as HandlerOptions;
  const explicit = (options as HandlerOptions).explicitCancellation === true;
  const made: HandlerEntry = { fn: fn as Fn<never>, view, explicit, object };
  const sdk = wrap(made) as never;
  const handler = view ? restate.handlers.object.shared(opts, sdk) : restate.handlers.object.exclusive(opts, sdk);
  return { handler, entry: made };
}

/**
 * A virtual object whose state is a SQL database per key.
 *
 * - `schema`: the steps that make each key's database, in order, applied
 *   once per key by the first handler that uses it. A step that ran never
 *   changes: a change is a step of its own.
 * - `handlers`: they run one at a time per key, each with a
 *   {@link SessionContext}.
 * - `views`: they run beside the handlers, each with a {@link ViewContext}:
 *   they read, and write nothing.
 *
 * Each is a function, or `{ handler, ...options }` with the SDK's handler
 * options. A name is a handler or a view, not both. `description`,
 * `metadata` and `options` are the SDK's object fields.
 */
export function sessionObject<
  P extends string,
  // No defaults: a default stops each function's `ctx` from being inferred.
  H extends Record<string, Entry<SessionContext>>,
  V extends Record<string, Entry<ViewContext>>,
>(definition: {
  name: P;
  schema?: readonly Step[];
  handlers?: H;
  views?: V;
  description?: string;
  metadata?: Record<string, string>;
  options?: restate.ObjectOptions;
}): VirtualObjectDefinition<P, Functions<H> & Functions<V>> {
  const { name, schema, handlers = {}, views = {}, description, metadata, options } = definition;
  const both = Object.keys(handlers).filter((key) => key in views);
  if (both.length > 0) throw new Error(`${name}: ${both.join(', ')} is a handler and a view: name one otherwise`);
  // Its state is its database's: which keys an invocation starts with is the session object's own.
  if (options && ('state' in options || 'enableLazyState' in options)) {
    throw new Error(`${name}: a session object sets its state options itself: leave out state and enableLazyState`);
  }
  const object: ObjectState = { config: { schema: schema ? new Schema(name, schema) : undefined } };
  const sdkHandlers: Record<string, (ctx: restate.ObjectContext, input?: unknown) => Promise<unknown>> = {};
  const entries = new Map<string, HandlerEntry>();
  for (const [view, map] of [
    [false, handlers],
    [true, views],
  ] as const) {
    for (const [key, value] of Object.entries(map)) {
      const { handler, entry } = handlerOf(name, key, value, view, object);
      sdkHandlers[key] = handler;
      entries.set(key, entry);
    }
  }
  const made = restate.object({
    name,
    description,
    handlers: sdkHandlers,
    metadata: { ...sqlMetadata, ...metadata },
    options: { ...sqlOptions, ...options },
  });
  object.definition = made;
  OBJECT.on(made, { object, entries });
  return made;
}

/** The SDK's context behind `ctx`, a handler's with `explicitCancellation: true`. */
function explicitOf(ctx: SessionContext, of: string) {
  const scope = scopeOf(ctx);
  if (scope === undefined) throw new restate.TerminalError(`${of} takes a session object's ctx`);
  if (!scope.explicitCancellation) {
    throw new restate.TerminalError(`${of} takes the ctx of a handler with explicitCancellation: true`);
  }
  return restate.internal.asInternal(scope.sdk);
}

/**
 * Resolves when Restate cancels the invocation of `ctx`, a handler's with
 * `explicitCancellation: true`, whose awaits are left as they are: for a
 * library that stops its own work then (a model's request, say).
 */
export const cancelled = async (ctx: SessionContext): Promise<void> => {
  await explicitOf(ctx, 'cancelled').cancellation();
};

/**
 * Cancel the calls the attempt of `ctx` made, as a cancelled invocation's
 * would be: a handler's with `explicitCancellation: true`.
 */
export const cancelCalls = async (ctx: SessionContext): Promise<void> => {
  await explicitOf(ctx, 'cancelCalls').cancelPreviousCalls();
};
