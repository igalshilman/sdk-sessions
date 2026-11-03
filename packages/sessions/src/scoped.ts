// State that this package, or a library over it, keeps for an object it is
// given (a handler's context, its `ctx.db`, a transaction, a definition) is
// kept on that object, so that it lives exactly as long as the object does:
// a module holds the key (`Scoped`), never the state. A context is frozen, so
// it is made with a place for it (`holding`); any other object gets one on
// first use.

const HELD = Symbol('scoped state');

type Held = Map<Scoped<unknown>, unknown>;

/** Give `owner` its place for scoped state: before it is frozen. */
export function holding<T extends object>(owner: T): T {
  Object.defineProperty(owner, HELD, { value: new Map() });
  return owner;
}

/** One kind of state, kept on each object it is for. */
export class Scoped<T> {
  /** What it is, for an error. */
  private readonly what: string;

  constructor(what: string) {
    this.what = what;
  }

  get(owner: object): T | undefined {
    return heldBy(owner)?.get(this) as T | undefined;
  }

  set(owner: object, value: T): void {
    this.place(owner).set(this, value);
  }

  delete(owner: object): void {
    heldBy(owner)?.delete(this);
  }

  /** `owner`'s, made by `make` the first time. */
  of(owner: object, make: () => T): T {
    const held = this.place(owner);
    if (!held.has(this)) held.set(this, make());
    return held.get(this) as T;
  }

  /** `owner`'s place, given it on first use. */
  private place(owner: object): Held {
    const held = heldBy(owner);
    if (held !== undefined) return held;
    if (!Object.isExtensible(owner)) throw new TypeError(`${this.what}: not an object of @restatedev/sessions`);
    return heldBy(holding(owner))!;
  }
}

const heldBy = (owner: object): Held | undefined => (owner as { [HELD]?: Held })[HELD];
