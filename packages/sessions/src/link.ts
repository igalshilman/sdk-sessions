// A private link on the objects this code makes: set once, as it makes one,
// and read by its code alone (a database's session, a transaction's reset, a
// definition's own). Not enumerable, so the object reads as its fields alone.

/** A link of one kind, on the objects that have one. */
export class Link<T> {
  private readonly key: symbol;

  constructor(what: string) {
    this.key = Symbol(what);
  }

  /** `owner`, linked to `value`: once, as it is made (before it is frozen). */
  on<O extends object>(owner: O, value: T): O {
    return Object.defineProperty(owner, this.key, { value });
  }

  /** What `owner` is linked to, if it has this link. */
  of(owner: object): T | undefined {
    return (owner as Record<symbol, T | undefined>)[this.key];
  }
}
