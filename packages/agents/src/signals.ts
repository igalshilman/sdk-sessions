// Signals to agents: a virtual object per agent, keyed `<agent>:<key>` (such
// as `assistant:alice`), whose `wait` returns once `resolve` gives the wait
// its value; the message the agent answers; the messages steered to it that
// it has not taken yet (`steer`); and the revision of the agent's
// conversation, which its `watch` waits on.
//
// An agent's own handler cannot wait on an awakeable (it has no journal to
// replay one from), so it calls `wait`, which can: a journaled handler of
// this object, which waits without holding a process.
import type { SessionContext } from '@restatedev/sessions';
import { Link, needing, sdk as restate } from '@restatedev/sessions/internal';
import type { Answering } from './common.ts';
import type { Status } from './object.ts';

/** An agent's context, as far as its signals need it: any handler's or view's of its object. */
type AgentContext = { readonly key: string; readonly request: { readonly target: { readonly service: string } } };

/** The key of the signals of agent `service`'s key `key`: `<agent>:<key>`. */
const keyOf = (service: string, key: string) => `${service}:${key}`;

/** The key of the signals of the agent of `ctx`. */
export const signalsOf = (ctx: AgentContext) => keyOf(ctx.request.target.service, ctx.key);

/** How an object of @restatedev/agents (`sessionObject()`, every `agent()`) reaches its companion, for one of its keys. */
const COMPANION = new Link<(key: string) => Companion>('restate-agents.companion');

/**
 * An agent's companion, for one of its keys: its `signals` object, which
 * knows what the agent is doing (the message it answers, what its tools wait
 * for), and how to reach it.
 */
export interface Companion {
  /** The `signals` object, as a client takes it. */
  object: typeof signals;
  /** The key of the agent's key there: `<agent>:<key>`. */
  key: string;
  /** The agent, and its key. */
  agent: Agent;
}

/**
 * `definition`, pointing to its companion: what `sessionObject()` returns.
 * `serve` serves its `signals` object beside it.
 */
export const withCompanion = <D extends { name: string }>(definition: D): D =>
  needing(
    COMPANION.on(definition, (key) => ({
      object: signals,
      key: keyOf(definition.name, key),
      agent: { service: definition.name, key },
    })),
    () => [signals],
  );

/**
 * The companion of `agent`'s key `key`: for anyone holding an agent (an
 * `sessionObject()` or `agent()` of @restatedev/agents) to reach what it is doing.
 */
export function companionOf(agent: { name: string }, key: string): Companion {
  const companion = COMPANION.of(agent);
  if (!companion)
    throw new Error(`${agent.name} is not an agent of @restatedev/agents (a sessionObject() or an agent())`);
  return companion(key);
}

/** Whether `agent` is an object of @restatedev/agents, with a companion. */
export const hasCompanion = (agent: object) => COMPANION.of(agent) !== undefined;

/**
 * Deliver `text` to `agent`'s key `key`, from any handler: a message of its
 * own (as `chat`), which it answers after the messages before it. It is
 * sent, not awaited: `opts` may give it an idempotency key, so that it is
 * delivered once.
 *
 *   deliver(ctx, triage, 'ENG-1', 'The issue was closed', { idempotencyKey: delivery });
 */
export function deliver(
  ctx: Pick<restate.Context, 'genericSend'> | Pick<SessionContext, 'send'>,
  agent: { name: string },
  key: string,
  text: string,
  { idempotencyKey }: { idempotencyKey?: string } = {},
) {
  companionOf(agent, key); // an agent of @restatedev/agents, with a `chat` handler
  const message = { service: agent.name, handler: 'chat', key, input: text, idempotencyKey };
  // A session object's handler, or one of the SDK's.
  if ('send' in ctx) ctx.send(message);
  else {
    ctx.genericSend({
      service: agent.name,
      method: 'chat',
      key,
      parameter: text,
      inputSerde: restate.serde.json,
      idempotencyKey,
    });
  }
}

/** A wait for a signal, as `pending` lists it. */
export interface Waiting {
  /** The wait's id, which `signal` takes to resolve this wait and no other. */
  id: string;
  /** The signal it waits for, such as `approval`. */
  name: string;
  /** What it waits for, as the model said it (such as the refund to approve), if the tool takes an input. */
  input?: unknown;
  /** When it started, as an ISO date. */
  since: string;
}

/** Which wait a signal resolves, and with what. */
export interface Signal {
  /** The wait of this id (from `pending`). */
  id?: string;
  /** Else the oldest wait for the signal of this name. */
  name?: string;
  /** Its value: what the wait answers the model with. */
  value?: unknown;
  /** With a `name` and no one waiting for it, keep the signal for the next wait for it (by default it is dropped). */
  keep?: boolean;
}

/** What `signal` did: the id of the wait it resolved, or null if none waited (and it was dropped, or kept). */
export interface Resolved {
  resolved: string | null;
}

/** The revision of an agent's conversation: each change of what a client reads increases it. */
export interface Notifications {
  revision: number;
}

/** A message steered to the turn being answered (`steer`): its id (the `steer` request's) and its text. */
export interface Steer {
  id: string;
  text: string;
}

/**
 * What `publish` answers the turn that published: the new revision, and the
 * messages steered to the turn being answered that it has not taken yet, if
 * any, oldest first.
 */
export interface Published extends Notifications {
  steering?: Steer[];
}

/** A message steered to the turn being answered that it has not taken yet, as `status` shows it. */
export interface Steering {
  id: string;
  /** When it was sent, as an ISO date. */
  since: string;
}

/**
 * What the `steer` view answers: the message's id (the request's), and the
 * invocation of the turn being answered, which takes the message at its next
 * step if it reaches one; null if no turn takes it. Either way the message is
 * answered once: in that turn, or else as a turn of its own, in the order it
 * was sent.
 */
export interface Steered {
  id: string;
  turn: string | null;
}

/**
 * How many messages a turn takes by `steer`, at most: past them, each is
 * answered as a turn of its own. The companion counts each message it holds
 * for the turn, taken or not, until the turn ends: so a turn that someone
 * steers on and on stays within bounds, and so does what the companion holds
 * for it.
 */
export const STEERS = 16;

/** What `watch` waits for: a revision newer than `revision`, for at most `timeoutSeconds` (default 50, at most 60). */
export interface Watch {
  revision: number;
  timeoutSeconds?: number;
}

/**
 * A turn as its agent starts it, and whether the agent closes it itself once
 * its invocation is gone: whether it has the private `settle` handler, which
 * the companion sends such a turn. An agent of another SDK (the companion's
 * handlers are shared) that does not say so is sent nothing: its next
 * message closes such a turn.
 */
export interface Started extends Answering {
  settles?: boolean;
  /**
   * Whether the turn takes steered messages at its steps (`steer`). A turn
   * that does not say so (of another SDK, or of an agent whose framework
   * cannot take them) gets none: each is answered as a turn of its own.
   */
  steers?: boolean;
}

/**
 * A message steered to the turn `turn` (an invocation id), as the companion
 * holds it until the turn ends: with its text until the turn takes it
 * (`taken`), and then only as one of the turn's {@link STEERS}.
 */
interface Inboxed {
  id: string;
  since: string;
  turn: string;
  text?: string;
}

/** The messages of `inbox` steered to the turn being answered (`answering`) that it has not taken yet, oldest first. */
const waitingIn = (inbox: readonly Inboxed[], answering: Started | null | undefined) =>
  answering ? inbox.filter((m) => m.turn === answering.invocationId && m.text !== undefined) : [];

/** `turn` as `status` shows it: without what only the companion reads. */
const shown = (turn: Started | null | undefined): Answering | null =>
  turn ? { invocationId: turn.invocationId, since: turn.since } : null;

/** An agent: its object's name, and key. */
interface Agent {
  service: string;
  key: string;
}

/**
 * The message the agent answers; the waits, in the order they started, each
 * with its awakeable; the signals kept for the next wait; and the
 * conversation's revision, with the `watch`es waiting for a newer one.
 */
interface State {
  /** The message the agent answers, from its turn's start to its close. */
  turn: Started;
  waiting: (Waiting & { awakeable: string })[];
  kept: Record<string, unknown[]>;
  /** The messages steered to the turns not closed yet (the one being answered), taken or not, oldest first. */
  inbox: Inboxed[];
  revision: number;
  watching: { revision: number; awakeable: string }[];
}

/** Increase the revision, and answer each `watch` waiting for it: the new revision. */
async function publish(ctx: restate.ObjectContext<State>): Promise<Notifications> {
  const revision = ((await ctx.get('revision')) ?? 0) + 1;
  ctx.set('revision', revision);
  for (const { awakeable } of (await ctx.get('watching')) ?? []) ctx.resolveAwakeable(awakeable, { revision });
  ctx.clear('watching');
  return { revision };
}

/** Keep `inbox`, or forget it once it is empty. */
const setInbox = (ctx: restate.ObjectContext<State>, inbox: Inboxed[]) =>
  inbox.length > 0 ? ctx.set('inbox', inbox) : ctx.clear('inbox');

/** How long one `awaitTurn` waits for its turn to end, before a new one takes over. */
const WATCH = { hours: 1 };

/**
 * `turn` (an invocation id) is over: forget it, if the agent answers it, and
 * its tools' waits, which no one waits for any more, ending their `wait`s (a
 * turn that ends as it should has none left, but a killed one leaves them).
 * It publishes the change, for the clients that follow the conversation: a
 * turn's own close (its last change), or the close of one that never closed
 * itself. A close again changes nothing, and publishes nothing.
 *
 * If the turn's invocation is `gone` and the turn did not close itself, its
 * agent is sent `settle`, which closes the turn in its conversation too, if
 * it said, as it started the turn, that it `settles`.
 *
 * The messages steered to the turn are forgotten here: each that it did not
 * take was queued as a turn of its own as it was sent (`steer`), and is
 * answered as one.
 */
async function closed(ctx: restate.ObjectContext<State>, turn: string, gone = false) {
  const started = await ctx.get('turn');
  const answering = started?.invocationId === turn;
  if (answering) {
    ctx.clear('turn');
    if (gone && started?.settles) {
      const at = ctx.key.indexOf(':');
      ctx.genericSend({
        service: ctx.key.slice(0, at),
        method: 'settle',
        key: ctx.key.slice(at + 1),
        parameter: turn,
        inputSerde: restate.serde.json,
      });
    }
  }
  const inbox = (await ctx.get('inbox')) ?? [];
  const dropped = inbox.some((m) => m.turn === turn);
  if (dropped)
    setInbox(
      ctx,
      inbox.filter((m) => m.turn !== turn),
    );
  const waiting = (await ctx.get('waiting')) ?? [];
  // A wait's id starts with the invocation id of the turn whose tool waits.
  const ofTurn = (id: string) => id.startsWith(`${turn}:`);
  const over = waiting.filter((w) => ofTurn(w.id));
  const left = waiting.filter((w) => !ofTurn(w.id));
  for (const w of over) ctx.rejectAwakeable(w.awakeable, 'its turn is over');
  if (over.length > 0) ctx.set('waiting', left);
  if (answering || over.length > 0 || dropped) await publish(ctx);
}

/** A handler that the agents' own handlers call, which clients cannot (through Restate's ingress). */
const internal = <I, O>(fn: (ctx: restate.ObjectContext<State>, input: I) => Promise<O>) =>
  restate.handlers.object.exclusive({ ingressPrivate: true }, fn);

/**
 * The signals of every agent, keyed `<agent>:<key>` ({@link signalsOf}).
 * `serve` serves it beside the agents; the handlers marked `@internal` are
 * called by the agents' own handlers, and Restate's ingress refuses them.
 */
export const signals = restate.object({
  name: 'signals',
  handlers: {
    /** Wait for the signal `name`, as wait `id` (for `input`), and return its value. */
    wait: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<State>, wait: { id: string; name: string; input?: unknown }) => {
        const { id, promise } = ctx.awakeable<unknown>();
        const since = new Date(await ctx.date.now()).toISOString();
        ctx.objectSendClient(signals, ctx.key).listen({ ...wait, since, awakeable: id });
        try {
          return await promise;
        } catch (error) {
          // The agent's invocation was cancelled: no one waits any more.
          if (error instanceof restate.CancelledError) ctx.objectSendClient(signals, ctx.key).forget(wait.id);
          throw error;
        }
      },
    ),

    /** Resolve the wait `id`, or else the oldest wait for `name`, with `value`. */
    resolve: async (ctx: restate.ObjectContext<State>, { id, name, value = null, keep = false }: Signal) => {
      if (id === undefined && name === undefined) throw new restate.TerminalError('a signal needs an id or a name');
      const waiting = (await ctx.get('waiting')) ?? [];
      const at = waiting.findIndex((w) => (id === undefined ? w.name === name : w.id === id));
      if (at < 0) {
        if (keep && name !== undefined && id === undefined) {
          const kept = (await ctx.get('kept')) ?? {};
          ctx.set('kept', { ...kept, [name]: [...(kept[name] ?? []), value] });
        }
        return { resolved: null } satisfies Resolved;
      }
      const [wait] = waiting.splice(at, 1);
      ctx.resolveAwakeable(wait!.awakeable, value);
      ctx.set('waiting', waiting);
      await publish(ctx);
      return { resolved: wait!.id } satisfies Resolved;
    },

    /** The waits, oldest first. */
    pending: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext<State>): Promise<Waiting[]> =>
      ((await ctx.get('waiting')) ?? []).map(({ id, name, input, since }) => ({ id, name, input, since })),
    ),

    /** @internal A wait: resolved now with a signal kept for it, or else when one comes. */
    listen: internal(async (ctx: restate.ObjectContext<State>, wait: Waiting & { awakeable: string }) => {
      const kept = (await ctx.get('kept')) ?? {};
      const [value, ...rest] = kept[wait.name] ?? [];
      if (kept[wait.name]?.length) {
        ctx.resolveAwakeable(wait.awakeable, value);
        ctx.set('kept', { ...kept, [wait.name]: rest });
        return;
      }
      ctx.set('waiting', [...((await ctx.get('waiting')) ?? []), wait]);
      await publish(ctx);
    }),

    /**
     * @internal The agent's `chat` started answering `turn`: the same
     * invocation again (a retry) keeps when it started. A turn before it that
     * never closed itself (its invocation was killed) closes now, if its
     * `awaitTurn` did not close it yet. `awaitTurn` watches the new turn, so
     * that it closes even if no turn comes after it.
     */
    start: internal(async (ctx: restate.ObjectContext<State>, turn: Started) => {
      const before = (await ctx.get('turn'))?.invocationId;
      if (before === turn.invocationId) return;
      if (before !== undefined) await closed(ctx, before, true);
      ctx.set('turn', turn);
      ctx.objectSendClient(signals, ctx.key).awaitTurn(turn.invocationId);
    }),

    /**
     * @internal Wait for `turn` to end, without holding a process, and close
     * it if it failed: its waits end, and `status` no longer says the agent
     * answers it. A turn that never closed itself failed: it was killed, ran
     * out of retries, or was lost. A turn that ends as it should, or is
     * cancelled, closed itself already: its `close` is a call it waits for
     * before it ends, so this `close` comes second, and changes nothing.
     *
     * It waits {@link WATCH} at most: a turn still answered then gets a new
     * watch, which runs on the deployment of the day, rather than this one
     * waiting for weeks on the one it started on (a turn that waits for an
     * approval, say). A cancelled watch (an operator's) rejects the race
     * itself, before either side's `map`: it closes nothing.
     */
    awaitTurn: restate.handlers.object.shared(
      // It leaves nothing behind once done: a turn has one at a time.
      { ingressPrivate: true, journalRetention: 0, idempotencyRetention: 0 },
      async (ctx: restate.ObjectSharedContext<State>, turn: string) => {
        const ended = await restate.RestatePromise.race([
          // `map` gets the turn's failure too: a killed turn's (a TerminalError).
          ctx
            .invocation(restate.InvocationIdParser.fromString(turn))
            .attach()
            .map((_answer, failure) => ({ failed: failure !== undefined })),
          ctx.sleep(WATCH).map(() => null),
        ]);
        if (ended?.failed) ctx.objectSendClient(signals, ctx.key).ended(turn);
        else if (ended === null && (await ctx.get('turn'))?.invocationId === turn) {
          ctx.objectSendClient(signals, ctx.key).awaitTurn(turn);
        }
      },
    ),

    /**
     * What the agent does: the message it answers, if any, the waits of its
     * tools, and the messages steered to it that it has not taken yet.
     */
    status: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext<State>): Promise<Status> => {
      const answering = await ctx.get('turn');
      const status: Status = {
        answering: shown(answering),
        waiting: ((await ctx.get('waiting')) ?? []).map(({ id, name, input, since }) => ({ id, name, input, since })),
      };
      const steering = waitingIn((await ctx.get('inbox')) ?? [], answering).map(({ id, since }) => ({ id, since }));
      return steering.length > 0 ? { ...status, steering } : status;
    }),

    /**
     * The revision, once there is one newer than `revision`, or at the
     * timeout (50 s by default, at most 60 s), whichever comes first. It
     * waits in Restate, holding no process; a caller that retries it with the
     * same idempotency key joins the same wait.
     */
    watch: restate.handlers.object.shared(
      async (
        ctx: restate.ObjectSharedContext<State>,
        { revision, timeoutSeconds = 50 }: Watch,
      ): Promise<Notifications> => {
        const { id, promise } = ctx.awakeable<Notifications>();
        ctx.objectSendClient(signals, ctx.key).subscribe({ revision, awakeable: id });
        const timeout = ctx.sleep({ seconds: Math.min(Math.max(timeoutSeconds, 0), 60) }).map(() => null);
        const changed = await restate.RestatePromise.race([promise, timeout]);
        if (changed) return changed;
        ctx.objectSendClient(signals, ctx.key).unsubscribe(id);
        return { revision: (await ctx.get('revision')) ?? 0 };
      },
    ),

    /** @internal The message `turn` (an invocation id) is answered, or its turn ended otherwise: see {@link closed}. */
    close: internal(async (ctx: restate.ObjectContext<State>, turn: string) => closed(ctx, turn)),

    /**
     * @internal The invocation of `turn` failed (killed, out of retries): if
     * the turn did not close itself, its agent closes it too (see {@link closed}).
     */
    ended: internal(async (ctx: restate.ObjectContext<State>, turn: string) => closed(ctx, turn, true)),

    /**
     * @internal The agent forgot its conversation (`clear`): forget its
     * waits, kept signals and steered messages, and publish the change. Each
     * steered message was queued as a turn of its own as it was sent, before
     * the `clear`.
     */
    reset: restate.handlers.object.exclusive({ ingressPrivate: true }, async (ctx: restate.ObjectContext<State>) => {
      ctx.clear('waiting');
      ctx.clear('kept');
      ctx.clear('inbox');
      await publish(ctx);
    }),

    /** @internal Forget wait `id`, whose agent no longer waits. */
    forget: internal(async (ctx: restate.ObjectContext<State>, id: string) => {
      const waiting = (await ctx.get('waiting')) ?? [];
      ctx.set(
        'waiting',
        waiting.filter((w) => w.id !== id),
      );
      await publish(ctx);
    }),

    /**
     * @internal The conversation changed: increase its revision, and answer
     * the `watch`es. It answers the new revision, and the messages steered
     * to the turn being answered that it has not taken yet, if any: a turn
     * publishes at each tool call's start and end, so it learns of them at
     * no cost of its own.
     */
    publish: restate.handlers.object.exclusive(
      { ingressPrivate: true },
      async (ctx: restate.ObjectContext<State>): Promise<Published> => {
        const published: Published = await publish(ctx);
        const inbox = (await ctx.get('inbox')) ?? [];
        // Only then is the turn read: a turn that nobody steers costs one read more, of the empty inbox.
        if (inbox.some((m) => m.text !== undefined)) {
          const steering = waitingIn(inbox, await ctx.get('turn')).map(({ id, text }) => ({ id, text: text! }));
          if (steering.length > 0) published.steering = steering;
        }
        return published;
      },
    ),

    /**
     * @internal Take a message steered to the agent (its `steer` view): for
     * the turn being answered, or as a turn of its own.
     *
     * The message is always sent to the agent's private `steered` handler at
     * once, which keeps its place in the key's queue, in order with the
     * messages sent after it: once the turn being answered ends, `steered`
     * answers the message as a turn of its own, unless that turn took it. A
     * turn that takes steered messages (`Started.steers`) also finds it
     * here, at its next step, through `publish`, until it takes it (`taken`)
     * or ends.
     */
    steer: internal(async (ctx: restate.ObjectContext<State>, { id, text }: Steer): Promise<Steered> => {
      const at = ctx.key.indexOf(':');
      ctx.genericSend({
        service: ctx.key.slice(0, at),
        method: 'steered',
        key: ctx.key.slice(at + 1),
        parameter: { id, text },
        inputSerde: restate.serde.json,
        idempotencyKey: `steer:${id}`,
      });
      const answering = await ctx.get('turn');
      if (!answering?.steers) return { id, turn: null };
      const turn = answering.invocationId;
      const inbox = (await ctx.get('inbox')) ?? [];
      if (inbox.some((m) => m.id === id)) return { id, turn };
      // Taken or not: the turn has room for so many in all.
      if (inbox.filter((m) => m.turn === turn).length >= STEERS) return { id, turn: null };
      const since = new Date(await ctx.date.now()).toISOString();
      ctx.set('inbox', [...inbox, { id, since, turn, text }]);
      await publish(ctx);
      return { id, turn };
    }),

    /**
     * @internal Mark the steered messages `ids` taken, which their turn has
     * stored, and publish the change, if any. The turn sends it with the
     * transaction that stores them, so it comes once they are stored, and
     * once only. Each is kept without its text until the turn ends, as one
     * of its {@link STEERS}; one already forgotten (its turn closed first)
     * is left so.
     */
    taken: internal(async (ctx: restate.ObjectContext<State>, ids: string[]) => {
      const inbox = (await ctx.get('inbox')) ?? [];
      let changed = false;
      const marked = inbox.map((m) => {
        if (m.text === undefined || !ids.includes(m.id)) return m;
        changed = true;
        return { id: m.id, since: m.since, turn: m.turn };
      });
      if (!changed) return;
      setInbox(ctx, marked);
      await publish(ctx);
    }),

    /** The conversation's revision. */
    notifications: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<State>): Promise<Notifications> => ({
        revision: (await ctx.get('revision')) ?? 0,
      }),
    ),

    /** @internal Answer `awakeable` once there is a revision newer than `revision`: at once, if there is. */
    subscribe: internal(async (ctx: restate.ObjectContext<State>, watch: { revision: number; awakeable: string }) => {
      const revision = (await ctx.get('revision')) ?? 0;
      if (revision > watch.revision) {
        ctx.resolveAwakeable(watch.awakeable, { revision });
        return;
      }
      ctx.set('watching', [...((await ctx.get('watching')) ?? []), watch]);
    }),

    /** @internal Forget the `watch` of `awakeable`, which no longer waits. */
    unsubscribe: internal(async (ctx: restate.ObjectContext<State>, awakeable: string) => {
      const watching = (await ctx.get('watching')) ?? [];
      ctx.set(
        'watching',
        watching.filter((w) => w.awakeable !== awakeable),
      );
    }),
  },
});
