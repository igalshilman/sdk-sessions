// An attempt's scope: what its code keeps for the attempt (an agent's turn,
// the calls of its tools...), which its context holds and which ends with it.
// A retry gets a context, and so a scope, of its own. A module holds only the
// key of what it keeps (`ScopeKey`), never the state.
import type * as restate from '@restatedev/restate-sdk';
import { Link } from './link.ts';
import type { SessionContext, ViewContext } from './object.ts';

/** A context of an attempt: a handler's or a view's. */
type Context = SessionContext | ViewContext;

/** The scope's values, which only {@link ScopeKey} reaches. */
const VALUES = Symbol('values');

/** An attempt's own, as @restatedev/sessions made it, and what its code keeps for it ({@link ScopeKey}). */
export class Scope {
  /** The SDK's context of the attempt. */
  readonly sdk: restate.ObjectContext | restate.ObjectSharedContext;
  /** Whether its handler has `explicitCancellation: true`. */
  readonly explicitCancellation: boolean;
  /** The definition of the session object whose handler or view it runs, if any. */
  readonly definition: object | undefined;
  readonly [VALUES] = new Map<ScopeKey<unknown>, unknown>();

  constructor(
    sdk: restate.ObjectContext | restate.ObjectSharedContext,
    { explicitCancellation = false, definition = undefined as object | undefined } = {},
  ) {
    this.sdk = sdk;
    this.explicitCancellation = explicitCancellation;
    this.definition = definition;
  }
}

/** The attempt's scope, on its context. */
const SCOPE = new Link<Scope>('scope');

/** `context`, holding `scope`: as it is made, before it is frozen. */
export const holding = <C extends Context>(context: C, scope: Scope): C => SCOPE.on(context, scope);

/** The scope of the attempt whose context `ctx` is, if it is one of @restatedev/sessions. */
export const scopeOf = (ctx: Context): Scope | undefined => SCOPE.of(ctx);

/** A kind of state an attempt's code keeps, by its context: its key in the attempt's scope. */
export class ScopeKey<T> {
  /** What it is, for an error. */
  private readonly what: string;

  constructor(what: string) {
    this.what = what;
  }

  get(ctx: Context): T | undefined {
    return this.values(ctx).get(this) as T | undefined;
  }

  set(ctx: Context, value: T): void {
    this.values(ctx).set(this, value);
  }

  delete(ctx: Context): void {
    this.values(ctx).delete(this);
  }

  /** The attempt's, made by `make` the first time. */
  of(ctx: Context, make: () => T): T {
    const values = this.values(ctx);
    if (!values.has(this)) values.set(this, make());
    return values.get(this) as T;
  }

  private values(ctx: Context): Map<ScopeKey<unknown>, unknown> {
    const scope = scopeOf(ctx);
    if (scope === undefined)
      throw new TypeError(`${this.what} takes the context of a session object's handler or view`);
    return scope[VALUES];
  }
}
