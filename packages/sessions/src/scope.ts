// An attempt's scope: what its code keeps for the attempt (an agent's turn,
// the calls of its tools...), which its context holds and which ends with it.
// A retry gets a context, and so a scope, of its own. A module holds only the
// key of what it keeps (`ScopeKey`), never the state.

/** The attempt's scope, on its context: not enumerable, so the context reads as its fields alone. */
const SCOPE = Symbol('scope');

/** What an attempt's code keeps for it, by key; and the attempt's own, as @restatedev/sessions made it. */
export class Scope {
  /** The SDK's context of the attempt. */
  readonly sdk: object;
  /** Whether its handler has `explicitCancellation: true`. */
  readonly explicitCancellation: boolean;
  /** The definition of the session object whose handler or view it runs, if any. */
  readonly definition: object | undefined;
  private readonly values = new Map<ScopeKey<unknown>, unknown>();

  constructor(sdk: object, { explicitCancellation = false, definition = undefined as object | undefined } = {}) {
    this.sdk = sdk;
    this.explicitCancellation = explicitCancellation;
    this.definition = definition;
  }

  /** Give `context`, before it is frozen, this scope. */
  hold<C extends object>(context: C): C {
    return Object.defineProperty(context, SCOPE, { value: this });
  }

  get<T>(key: ScopeKey<T>): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T>(key: ScopeKey<T>, value: T): void {
    this.values.set(key, value);
  }

  delete(key: ScopeKey<unknown>): void {
    this.values.delete(key);
  }
}

/** The scope of the attempt whose context `ctx` is, if it is one of @restatedev/sessions. */
export const scopeOf = (ctx: object): Scope | undefined => (ctx as { [SCOPE]?: Scope })[SCOPE];

/** A kind of state an attempt's code keeps, by its context: its key in the attempt's scope. */
export class ScopeKey<T> {
  /** What it is, for an error. */
  private readonly what: string;

  constructor(what: string) {
    this.what = what;
  }

  get(ctx: object): T | undefined {
    return this.scope(ctx).get(this);
  }

  set(ctx: object, value: T): void {
    this.scope(ctx).set(this, value);
  }

  delete(ctx: object): void {
    this.scope(ctx).delete(this);
  }

  /** The attempt's, made by `make` the first time. */
  of(ctx: object, make: () => T): T {
    const scope = this.scope(ctx);
    const held = scope.get(this);
    if (held !== undefined) return held;
    const made = make();
    scope.set(this, made);
    return made;
  }

  private scope(ctx: object): Scope {
    const scope = scopeOf(ctx);
    if (scope === undefined)
      throw new TypeError(`${this.what} takes the context of a session object's handler or view`);
    return scope;
  }
}
