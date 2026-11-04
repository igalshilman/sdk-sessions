// An attempt's database: the session's database, kept in the object's state
// (database.ts), opened as an exclusive attempt starts (a view's on its first
// read) and saved when the handler ends; and its transactions, with the sends
// each commits with (`tx.send`).
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type * as restate from '@restatedev/restate-sdk';
import { serde, TerminalError } from '@restatedev/restate-sdk';
import { millisOrDurationToMillis, type Serde } from '@restatedev/restate-sdk-core';
import {
  open,
  type Row,
  sqlOver,
  SqlError,
  type Connection,
  type DatabaseWriter,
  type SqlParam,
  type DatabaseReader,
  type SqlValue,
  type Store,
  type ConnectionTransaction,
} from './database.ts';
import { apply, dropAll, ensureOf, ensuring, type Schema } from './schema.ts';
import { type Send, sendOf } from './calls.ts';

export type { DatabaseReader, DatabaseWriter, Row, SqlParam, SqlValue };

/**
 * The session's database, `ctx.db`, for the whole handler: each statement
 * outside {@link transaction} is its own transaction. Calls run one at a
 * time, in call order.
 */
export interface Database extends DatabaseWriter {
  /**
   * Run `body` as one transaction: it commits when `body` resolves, and rolls
   * back when it rejects. It holds the database: other calls wait until it
   * ends, and a call to the database from inside `body` is refused, as it
   * would wait for `body`. So `body` uses the `tx` it gets, which is invalid
   * once `body` settles.
   */
  transaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** One transaction of a {@link Database}: its SQL, and the sends it commits with. */
export interface Transaction extends DatabaseWriter {
  /**
   * Sends made right after the transaction commits, and never if it rolls
   * back. Each has the idempotency key it is given, or else one of the
   * transaction (`transaction/<id>/<index>`), so a send an attempt makes
   * again is dropped.
   */
  readonly send: Send;
}

/** What the session needs of the handler's context. */
export interface SqlHost {
  /** A shared handler's: it reads beside the exclusive one, and stores nothing. */
  readonly shared: boolean;
  readonly key: string;
  /** Rejects when the attempt ends (suspended, or aborted). */
  readonly invocationEndPromise: { readonly promise: Promise<unknown> };
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly defaultSerde: Serde<any>;
  request(): { readonly id: string; readonly target: { readonly service: string } };
  get(name: string, serde: Serde<Uint8Array>, options: restate.EntryOptions): PromiseLike<Uint8Array | null>;
  set(name: string, value: Uint8Array, serde: Serde<Uint8Array>, options: restate.EntryOptions): void;
  clear(name: string, options: restate.EntryOptions): void;
  /** The object's state keys. */
  stateKeys(): PromiseLike<string[]>;
  run(name: string, action: () => void): PromiseLike<void>;
  genericSend(send: restate.GenericSend<Uint8Array>): unknown;
}

/** What a session object gives its attempts: its schema, and a wrapper of its store (fault injection, in tests). */
export interface ObjectConfig {
  /** The object's own schema, which each of its databases is made by. */
  readonly schema?: Schema;
  wrapStore?: (store: Store) => Store;
}

/** The end of an attempt, as `invocationEndPromise` rejects with it, for the requests that would otherwise wait for it. */
class AttemptEnd {
  private ended: Error | undefined;
  /** The rejections of the requests waiting. */
  private readonly waiting = new Set<(error: Error) => void>();
  private readonly listeners = new Set<() => void>();

  constructor(end: Promise<unknown>) {
    end.catch((error: unknown) => {
      const ended = error instanceof Error ? error : new Error(String(error));
      this.ended = ended;
      for (const reject of this.waiting) reject(ended);
      this.waiting.clear();
      for (const listener of this.listeners) listener();
      this.listeners.clear();
    });
  }

  /**
   * `promise`, or a rejection once the attempt ends: an attempt that is
   * suspended or aborted never settles what it was waiting for.
   */
  race<T>(promise: PromiseLike<T>): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    return new Promise<T>((resolve, reject) => {
      this.waiting.add(reject);
      void Promise.resolve(promise)
        .finally(() => this.waiting.delete(reject))
        .then(resolve, reject);
    });
  }

  /** Call `listener` when the attempt ends; the returned function cancels it. */
  onEnd(listener: () => void): () => void {
    if (this.ended) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// A state command is named after its key, so that tooling can hide the
// database's head, tail and packs by name (`dev.restate.tooling.journal.hidden.name.prefix`).
const named = (key: string): restate.EntryOptions => ({ name: key });

// A shared handler's reader writes nothing.
const refusedWrite = () => {
  throw new Error('a shared handler writes no state');
};

/**
 * The keys of the database `name`, apart from the object's own: each of the
 * format's keys (`v22/head`, `v22/tail/...`, `v22/manifest/...`,
 * `v22/pack/...`) as `v22/db/<name>/head`, under the format's prefix still,
 * which tooling hides, and under none of the object's database's.
 */
const beside = (name: string) => (key: string) => {
  const at = key.indexOf('/') + 1;
  return `${key.slice(0, at)}db/${name}/${key.slice(at)}`;
};

/**
 * The format's key of a key of the database `name` (undoes {@link beside});
 * `undefined` for any other key of the object.
 */
const unbeside = (name: string) => (key: string) => {
  const at = key.indexOf('/') + 1;
  const prefix = `db/${name}/`;
  return at > 0 && key.startsWith(prefix, at) ? key.slice(0, at) + key.slice(at + prefix.length) : undefined;
};

/**
 * The object's state as an ordered store: `get` is a state get, `set` and
 * `clear` are state writes, which return at once and which the runtime
 * stores in order; `sync` is an empty `ctx.run`, acknowledged after the
 * commands before it. A `get` or `sync` the attempt's end leaves waiting
 * rejects, so the session that made it ends instead of holding its lock for
 * the life of the process. One the SDK cancels fails as any await does: the
 * session it ends fails its calls with the CancelledError (see `open`).
 */
function objectStore(ctx: SqlHost, end: AttemptEnd, dbName: string | undefined): Store {
  const keyOf = dbName === undefined ? (key: string) => key : beside(dbName);
  const request = <T>(promise: PromiseLike<T>) => end.race(promise);
  // TODO: read with protocol v8's ephemeral get, left out of the journal, once
  // a Restate release ships v8 and the SDK lets a library make one. Restate 1.8
  // negotiates v7 at most: a journaled get.
  const get = async (key: string) => (await request(ctx.get(keyOf(key), serde.binary, named(keyOf(key))))) ?? undefined;
  if (ctx.shared) return { get, set: refusedWrite, clear: refusedWrite, sync: async () => {} };
  return {
    get,
    set: (key, value) => ctx.set(keyOf(key), value, serde.binary, named(keyOf(key))),
    clear: (key) => ctx.clear(keyOf(key), named(keyOf(key))),
    // The database's keys, for a garbage collection.
    keys: async () => {
      const keys = await request(ctx.stateKeys());
      if (dbName === undefined) return keys;
      const own = unbeside(dbName);
      return keys.flatMap((key) => own(key) ?? []);
    },
    sync: async () => {
      await request(ctx.run('sync', () => {}));
    },
  };
}

/**
 * What a failed call to the session fails the handler with: an
 * {@link SqlError}, which a retry would repeat, becomes a
 * {@link TerminalError}, its `cause` the SQL error. Anything else is as for
 * any handler: a storage error, which ends the session, or the handler's own
 * (a failed request to another service, say) is retried, unless it is a
 * TerminalError itself.
 */
function handlerError(error: unknown): unknown {
  if (!(error instanceof SqlError)) return error;
  const terminal = new TerminalError(error.message);
  terminal.cause = error;
  return terminal;
}

/** `call`'s result, or the error the handler fails with (see {@link handlerError}). */
async function forHandler<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw handlerError(error);
  }
}

/** The SQL of a transaction's body: `tx`'s, failing as {@link forHandler} does. */
function forBody(tx: ConnectionTransaction): DatabaseWriter {
  return sqlOver((sql, params) => forHandler(tx.queryColumns(sql, params)), handlerError);
}

/**
 * `connection`, opened without the SDK (`open`), as a handler's `ctx.db`:
 * for a library's tests, and tools. Its transactions send nothing, and a
 * library's schema applies to it (`Schema.ensure`).
 */
export function asDatabase(connection: Connection): Database {
  const db: Database = {
    ...sqlOver((sql, params) => connection.queryColumns(sql, params)),
    transaction: (body) => connection.transaction((tx) => body({ ...forBody(tx), send: refusedSend })),
  };
  return ensuring(db, (schemas) => apply(connection, schemas));
}

/** How a transaction of `ctx.db` empties the database ({@link reset}), on it: not enumerable. */
const RESET = Symbol('reset');

/**
 * Empty the key's database in `tx`, a transaction of an exclusive handler's
 * `ctx.db`: every table, view, index and trigger is dropped, the schemas are
 * applied again (the object's, and the libraries' the attempt applied), and
 * the outbox stays. It commits with `tx`: what `tx` writes after it are the
 * new database's first rows, in the same commit.
 */
export function reset(tx: Transaction): Promise<void> {
  const of = (tx as { [RESET]?: () => Promise<void> })[RESET];
  if (of === undefined) throw new TerminalError("reset takes a transaction of an exclusive handler's ctx.db");
  return forHandler(of());
}

/**
 * A database that `opener` opens on its first call, as a handler's `ctx.db`
 * opens: for tests, which give each attempt one over the same state.
 */
export function lazyDatabase(opener: () => Promise<Database>): Database {
  let opened: Promise<Database> | undefined;
  const db = () => (opened ??= opener());
  const lazy: Database = {
    query: async (sql, params) => (await db()).query(sql, params),
    get: async (sql, params) => (await db()).get(sql, params),
    values: async (sql, params) => (await db()).values(sql, params),
    execute: async (sql, params) => (await db()).execute(sql, params),
    transaction: async (body) => (await db()).transaction(body),
  };
  return ensuring(lazy, async (schemas) => {
    const inner = await db();
    const ensure = ensureOf(inner);
    if (ensure === undefined)
      throw new TerminalError("lazyDatabase opens a handler's ctx.db, or a database of asDatabase");
    await ensure(schemas);
  });
}

/** The sends of a transaction that has no outbox: a shared handler's, or another database's. */
const refusedSend: Send = () => {
  throw new TerminalError("a send of a transaction is an exclusive handler's, in the object's own database");
};

// A transaction's sends commit with it, in the database's record `outbox`
// (beside its tables, in none of them), which holds each committed
// transaction's sends until they are stored. They are made with its commit
// (see `Attempt.transaction`); a later open makes again those still in the outbox,
// with the same idempotency keys (`transaction/<id>/<index>`, with a random
// id of the transaction), so making them again is dropped. Restate keeps an attempt's commands in the
// order they were made, so a send made before a commit is stored whenever the
// commit is: the next commit leaves the sends this attempt made out of the
// outbox, and so does the end of the attempt.

/** A send, but its parameter, as it is stored. */
type StoredSend = Omit<restate.GenericSend<unknown>, 'parameter' | 'inputSerde' | 'delay'> & {
  /** Its delay, in milliseconds. */
  delay?: number;
  /** When a delayed send is due (epoch ms): one made again waits only what remains. */
  due?: number;
};

/** The sends of a committed transaction, in the outbox. */
interface Outgoing {
  /** The transaction's random id. */
  id: string;
  /** Each send, its parameter in base64. */
  sends: (StoredSend & { parameter: string })[];
}

/** The database's record of the outbox. */
const OUTBOX = 'outbox';

/** The outbox as its record: none is empty, as a record never set reads. */
function encodeOutbox(outbox: Outgoing[]): Uint8Array {
  return outbox.length === 0 ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(outbox));
}

function decodeOutbox(record: Uint8Array): Outgoing[] {
  return record.length === 0 ? [] : (JSON.parse(new TextDecoder().decode(record)) as Outgoing[]);
}

function storedSend(send: restate.GenericSend<unknown>): Outgoing['sends'][number] {
  const { parameter, inputSerde, delay, ...rest } = send;
  return {
    ...rest,
    ...(delay !== undefined ? { delay: millisOrDurationToMillis(delay) } : {}),
    parameter: Buffer.from((inputSerde ?? serde.binary).serialize(parameter)).toString('base64'),
  };
}

/** How a handler ended. */
type Outcome<T> = { value: T } | { error: unknown };

/** The attempt of a `ctx.db`, on it (not enumerable): for {@link database}. */
const ATTEMPT = Symbol('database');

// A database's name (`database`).
const DATABASE_NAME = /^[\w.-]{1,64}$/;

/**
 * The database `name` of the key, apart from the object's own (`ctx.db`, of
 * the attempt whose session `db` is): for a library whose tables must be
 * alone in their database, such as OpenCode's. It opens on its first use,
 * and ends with the attempt, as `ctx.db` does. A name is 1 to 64 letters,
 * digits, `_`, `-` or `.`.
 */
export function database(db: Database, name: string): Database {
  if (!DATABASE_NAME.test(name)) throw new TerminalError(`database: ${JSON.stringify(name)} is not a database name`);
  const attempt = (db as { [ATTEMPT]?: Attempt })[ATTEMPT];
  if (attempt === undefined) throw new TerminalError("database takes a handler's ctx.db");
  return attempt.database(name);
}

/** The sends of one transaction, as its body makes them (`tx.send`), until it ends. */
class Sends {
  private readonly sends: Outgoing['sends'] = [];
  private open = true;
  readonly send: Send = sendOf((send) => {
    if (!this.open) throw new TerminalError('the transaction has ended: send from inside its body');
    this.sends.push(storedSend(send));
  });

  /** The body ended: the transaction's sends, if it made any, their delays counted from now. */
  close(): Outgoing | undefined {
    this.open = false;
    if (this.sends.length === 0) return undefined;
    const now = Date.now();
    for (const send of this.sends) if (send.delay !== undefined) send.due = now + send.delay;
    return { id: randomUUID(), sends: this.sends };
  }
}

/**
 * One session of an attempt's database, from its open on. A failure ends it:
 * its open's, or a request's since. It closes as the attempt ends, unless the
 * attempt ends it first ({@link end}).
 */
class Session {
  readonly ready: Promise<Connection>;
  /** A call failed on it once a failure ended it: the next call opens another. */
  retired = false;
  private connection: Connection | undefined;
  private failed = false;
  private release: () => void = () => {};

  constructor(ready: Promise<Connection>, end: AttemptEnd) {
    this.ready = ready;
    void this.track(end);
  }

  /** Whether a failure ended it. */
  get ended(): boolean {
    return this.failed || this.connection?.isUsable() === false;
  }

  /** Its connection, or none if the open failed; the attempt's end no longer closes it. */
  async end(): Promise<Connection | undefined> {
    const db = await this.ready.catch(() => undefined);
    this.release();
    return db;
  }

  /** Close it now. */
  close(): void {
    void this.end()
      .then((db) => db?.close())
      .catch(() => {});
  }

  private async track(end: AttemptEnd) {
    try {
      const db = await this.ready;
      this.connection = db;
      // A handler still waiting for something else when the attempt ends (a
      // model request, say) keeps the session no longer: it closes once no
      // statement runs, and the handler's later calls fail.
      this.release = end.onEnd(() => void db.close().catch(() => {}));
    } catch {
      this.failed = true;
    }
  }
}

/**
 * An attempt's SQL session: opened on its first use, or as an exclusive
 * attempt starts ({@link openNow}), shared by everything the handler does,
 * and saved when the handler ends ({@link end}). With `name`, of the key's
 * database `name` ({@link database}), which has neither the object's schema
 * nor an outbox.
 */
export class Attempt {
  /** `ctx.db`. */
  readonly db: Database;
  private readonly ctx: SqlHost;
  /** Its object's: the key's other databases share its store's wrapper, and have none of its schema. */
  private readonly config: ObjectConfig;
  private readonly name: string | undefined;
  /** Whether it is the object's own database of an exclusive handler: the one with an outbox. */
  private readonly hasOutbox: boolean;
  /** The key's other databases this attempt opened, by name. */
  private readonly databases = new Map<string, Attempt>();
  /** The session, from its first use on. */
  private session: Session | undefined;
  /** The ids of the outbox's transactions this attempt made the sends of. */
  private readonly made = new Set<string>();
  /** The schemas this attempt's database has all the steps of. */
  private readonly ensured = new Map<string, Schema>();
  private ended = false;

  constructor(ctx: SqlHost, config: ObjectConfig = {}, name?: string) {
    this.ctx = ctx;
    this.config = config;
    this.name = name;
    this.hasOutbox = !ctx.shared && name === undefined;
    this.db = {
      ...sqlOver((sql, params) => this.call((db) => db.queryColumns(sql, params)), handlerError),
      transaction: (body) => this.transaction(body),
    };
    ensuring(this.db, (schemas) => this.call((db) => this.ensureSchemas(db, schemas)));
    Object.defineProperty(this.db, ATTEMPT, { value: this });
  }

  /** The key's database `name`, in this attempt: see {@link database}. */
  database(name: string): Database {
    if (this.ended) throw new Error('the handler has ended: its SQL session is closed');
    let other = this.databases.get(name);
    if (other === undefined) this.databases.set(name, (other = new Attempt(this.ctx, this.config, name)));
    return other.db;
  }

  /**
   * Open the session now, as the attempt starts, rather than on its first
   * call: the open makes the sends a crashed attempt committed and left
   * unmade, which must not wait for a handler that uses the database.
   */
  openNow() {
    if (this.hasOutbox && this.session === undefined) this.current().ready.catch(() => {});
  }

  /**
   * The handler ended with `outcome`: the key's other databases end, then
   * this one ({@link endSession}).
   */
  async end<T>(outcome: Outcome<T>): Promise<T> {
    // The key's other databases end first, as the handler left them.
    const databases = await Promise.allSettled([...this.databases.values()].map((d) => d.end({ value: undefined })));
    const value = await this.endSession(outcome);
    const failed = databases.find((d) => d.status === 'rejected');
    if (failed) throw failed.reason;
    return value;
  }

  /**
   * `body` as one transaction. In the object's own database of an exclusive
   * handler, its sends commit with it, in the outbox, and are made with its
   * commit, right after its writes and before it waits for anything
   * (`withCommit`): Restate stores an attempt's commands in order, so they
   * are stored only if the commit is, and whatever fails the commit's wait (a
   * cancellation, say) comes after them. A second commit empties the outbox
   * before `transaction` resolves: left until the handler's end, they would
   * be made again by an attempt that resumes a long wait (an approval), past
   * the idempotency retention that drops a repeat.
   */
  private async transaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
    let outgoing: Outgoing | undefined;
    const value = await this.call((db) =>
      db.transaction(async (handle) => {
        const sends = this.hasOutbox ? new Sends() : undefined;
        const tx: Transaction = { ...forBody(handle), send: sends?.send ?? refusedSend };
        // A view's writes stay in its session: it has nothing to reset.
        if (!this.ctx.shared) Object.defineProperty(tx, RESET, { value: () => this.reset(handle) });
        let result: T;
        try {
          result = await body(tx);
        } finally {
          outgoing = sends?.close();
        }
        if (this.hasOutbox) await this.commitOutbox(handle, outgoing);
        return result;
      }),
    );
    if (outgoing !== undefined) await this.call((db) => this.flush(db));
    return value;
  }

  /**
   * Commit with `handle` the outbox as committed, but the sends stored since,
   * and with `outgoing`, which the commit makes. Unchanged, it is not
   * written again.
   */
  private async commitOutbox(handle: ConnectionTransaction, outgoing: Outgoing | undefined) {
    const outbox = await this.unstored(handle);
    if (outgoing !== undefined) {
      outbox.push(outgoing);
      handle.withCommit(() => this.make(outgoing));
    }
    handle.setRecord(OUTBOX, encodeOutbox(outbox));
  }

  /**
   * `call` on the session, opening it on the first; its failure as the
   * handler fails with it. The call that fails on a session that a failure
   * ended is its last: the next opens another, which reads what is stored.
   * So the failure of an open made as the attempt started goes to the first
   * call, as it would had that call opened it.
   */
  private async call<T>(call: (db: Connection) => Promise<T>): Promise<T> {
    const session = this.current();
    try {
      return await call(await session.ready);
    } catch (error) {
      if (session.ended) session.retired = true;
      throw handlerError(error);
    }
  }

  /** The session, opening one if there is none, or the one there is was retired. */
  private current(): Session {
    if (this.ended) throw new Error('the handler has ended: its SQL session is closed');
    if (this.session?.retired) this.session.close();
    if (this.session === undefined || this.session.retired) this.session = this.open();
    return this.session;
  }

  private open(): Session {
    const end = new AttemptEnd(this.ctx.invocationEndPromise.promise);
    return new Session(this.start(end), end);
  }

  private async start(end: AttemptEnd): Promise<Connection> {
    const ctx = this.ctx;
    // The page cache's: the key escaped, so that no key reads as another's
    // database (a name has no `/`).
    const key = `${ctx.request().target.service}/${encodeURIComponent(ctx.key)}`;
    const namespace = this.name === undefined ? key : `${key}/${this.name}`;
    const object = objectStore(ctx, end, this.name);
    const wrap = this.config.wrapStore;
    const db = await open(namespace, wrap ? wrap(object) : object, { reader: ctx.shared });
    try {
      // A view writes nothing: a write fails, rather than vanish with the attempt.
      if (ctx.shared) await db.execute('PRAGMA query_only = 1');
      if (this.hasOutbox) {
        // What a crash left unmade; an open again in this attempt finds what
        // this attempt made, stored before it, as made.
        const left = decodeOutbox(await db.record(OUTBOX));
        for (const outgoing of left) if (!this.made.has(outgoing.id)) this.make(outgoing, true);
        // Emptied at once, as a transaction's own sends are (see `transaction`).
        if (left.length > 0) await this.flush(db);
      }
      // A view's too, whose writes are never stored: a key never written reads as empty tables.
      const own = this.ownSchema();
      if (own) await this.ensureSchemas(db, [own]);
    } catch (error) {
      await db.close();
      throw error;
    }
    return db;
  }

  /**
   * End the session, then settle as the handler did: an SQL error that
   * escaped it becomes terminal. The handler's error stands: what it
   * committed is stored, and an outbox left full is made by the next open.
   * A failure to end the session fails a handler that succeeded, which a
   * retry then ends (a transaction it left open, say).
   */
  private async endSession<T>(outcome: Outcome<T>): Promise<T> {
    this.ended = true;
    const failed = await this.close().then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    if ('error' in outcome) throw handlerError(outcome.error);
    if (failed !== undefined) throw handlerError(failed.error);
    return outcome.value;
  }

  /**
   * Close the session as the attempt ends. A view's closes: it read the
   * snapshot it opened on, and one that outlived 16 commits failed its read
   * ("is gone"), which is retried. Another is saved, its outbox emptied. One
   * that a failure ended closes, and the object's own database is opened
   * again and saved: it may hold sends unmade (a crash left them, and this
   * attempt's open failed) or made and not emptied (the commit's wait
   * failed), and no attempt may follow this one (a cancelled invocation's),
   * nor the key's next invocation come within the idempotency retention.
   */
  private async close(): Promise<void> {
    if (this.session === undefined) return;
    const db = await this.session.end();
    if (this.ctx.shared) return db?.close();
    if (db?.isUsable()) return this.save(db);
    await db?.close().catch(() => {});
    if (!this.hasOutbox) return;
    const again = this.open();
    try {
      await this.save(await again.ready);
    } finally {
      void again.end();
    }
  }

  /** Empty the outbox and save the session, which closes if that fails. */
  private async save(db: Connection) {
    try {
      if (this.hasOutbox) await this.flush(db);
      await db.save();
    } catch (error) {
      await db.close().catch(() => {});
      throw error;
    }
  }

  /** The object's schema, which the key's other databases have none of. */
  private ownSchema(): Schema | undefined {
    return this.name === undefined ? this.config.schema : undefined;
  }

  /** Empty the database in the transaction `handle` ({@link reset}), and apply the schemas this attempt applied again. */
  private async reset(handle: ConnectionTransaction) {
    const own = this.ownSchema();
    const schemas = [...(own ? [own] : []), ...[...this.ensured.values()].filter((s) => s !== own)];
    await dropAll(handle, schemas);
  }

  /** Apply the steps of `schemas` that the database lacks, each schema once per attempt. */
  private async ensureSchemas(db: Connection, schemas: readonly Schema[]) {
    const lacking = schemas.filter((s) => !this.ensured.has(s.name));
    if (lacking.length === 0) return;
    await apply(db, lacking, { reader: this.ctx.shared });
    for (const s of lacking) this.ensured.set(s.name, s);
  }

  /** Make the sends of a committed transaction: each with an idempotency key of the transaction (or its own), so that making them again is dropped. */
  private make({ id, sends }: Outgoing, again = false) {
    sends.forEach(({ parameter, due, delay, ...send }, index) => {
      this.ctx.genericSend({
        ...send,
        // Made again, a delayed send waits only what remains of its delay.
        ...(delay !== undefined ? { delay: again && due !== undefined ? Math.max(0, due - Date.now()) : delay } : {}),
        parameter: new Uint8Array(Buffer.from(parameter, 'base64')),
        inputSerde: serde.binary,
        idempotencyKey: send.idempotencyKey ?? `transaction/${id}/${index}`,
      });
    });
    this.made.add(id);
  }

  /** The outbox as committed, but the transactions this attempt made the sends of: a commit made after them stores them first. */
  private async unstored(db: Connection | ConnectionTransaction): Promise<Outgoing[]> {
    return decodeOutbox(await db.record(OUTBOX)).filter(({ id }) => !this.made.has(id));
  }

  /**
   * Empty the outbox, so that a later open does not make its sends again: a
   * commit after them, which stores them first.
   */
  private async flush(db: Connection) {
    if ((await db.record(OUTBOX)).length === 0) return;
    // Read in the transaction that writes it: one that committed sends since
    // the read above keeps them.
    await db.transaction(async (tx) => tx.setRecord(OUTBOX, encodeOutbox(await this.unstored(tx))));
  }
}

/** Run `handler`, then end `attempt`'s SQL session, if it opened one (see {@link Attempt.end}). */
export async function withAttempt<T>(handler: () => Promise<T>, attempt: Attempt): Promise<T> {
  let outcome: Outcome<T>;
  try {
    outcome = { value: await handler() };
  } catch (error) {
    outcome = { error };
  }
  return attempt.end(outcome);
}
