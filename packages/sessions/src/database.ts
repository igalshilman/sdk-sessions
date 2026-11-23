// A session's database, through the addon (`native/`): SQLite-compatible
// SQL, kept in the object's state. The addon reads and writes the state through a
// store (`objectStore` in session.ts), in the order it makes its requests
// (`native/src/node.rs`); this module orders the calls and runs transactions.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { addon as loaded } from './addon.ts';
import { STATE_WAIT_OVER, type Vm } from './vm.ts';
import { AttemptShutDown } from './driver.ts';

/** An SQL value. Integers come back as numbers, or as bigints beyond 2^53. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** An SQL parameter: an `SqlValue`, or a boolean, stored as 0 or 1. */
export type SqlParam = SqlValue | boolean;

/** The rows of a statement, with its column names. */
export interface SqlQueryResult {
  columns: string[];
  rows: SqlValue[][];
}

/**
 * A failure a retry would repeat: SQL the engine rejected (a syntax error, a
 * constraint, a missing table), which undid just that statement and leaves
 * the session usable; a parameter it cannot bind; or a call the session
 * refused, which may have ended it (a `COMMIT` in a transaction's body, a
 * transaction left open). A storage error, which ends the session, rejects
 * as it is.
 */
export class SqlError extends Error {
  override name = 'SqlError';
}

/** A row as an object, by column name. */
export type Row = Record<string, SqlValue>;

/** Reads of a database, or of one transaction of it. */
export interface DatabaseReader {
  /**
   * The rows of one statement, each an object by column name; parameters
   * bind to a single statement. `T` declares the row's shape, unchecked:
   * integers past 2^53 come back as bigints, and booleans as 0 or 1. Columns
   * are named as SQL names them (an expression needs `AS`), and two of the
   * same name are an {@link SqlError}: alias them, or use {@link values}.
   */
  query<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** The first row of {@link query}, or `undefined` when there is none. */
  get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  /** The rows of one statement as arrays, in column order: for adapters, and for columns that share a name. */
  values(sql: string, params?: SqlParam[]): Promise<SqlValue[][]>;
}

/** SQL: a database, or one transaction of it. */
export interface DatabaseWriter extends DatabaseReader {
  /** Run SQL (one or more statements), discarding rows; parameters only with a single statement. */
  execute(sql: string, params?: SqlParam[]): Promise<void>;
}

/** Nothing: what settles a queue's last call, and what `execute` resolves with. */
const nothing = (): void => {};

/** The rows of `result` as objects by column name; a column name twice is an {@link SqlError}. */
function objects({ columns, rows }: SqlQueryResult): Row[] {
  const names = columns.length;
  let twice: string | undefined;
  for (let i = 1; i < names && twice === undefined; i++) {
    // A statement has a handful of columns: comparing them pairwise costs less than a Set.
    for (let j = 0; j < i; j++) {
      if (columns[j] === columns[i]) {
        twice = columns[i];
        break;
      }
    }
  }
  if (twice !== undefined) {
    throw new SqlError(`the column ${twice} is named twice: alias one (AS), or read the rows with values()`);
  }
  // A column named `__proto__` is an own property of the row, as `Object.fromEntries` makes it;
  // assignment would set the row's prototype instead.
  if (columns.includes('__proto__')) {
    return rows.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]!])));
  }
  const result: Row[] = [];
  for (const row of rows) {
    const object: Row = {};
    for (let i = 0; i < names; i++) object[columns[i]!] = row[i]!;
    result.push(object);
  }
  return result;
}

/**
 * {@link DatabaseWriter} over `run`, which runs one call's SQL and returns
 * its rows with their columns, failing as `failure` makes its errors (as
 * `run` makes the engine's).
 */
export function sqlOver(
  run: (sql: string, params?: SqlParam[]) => Promise<SqlQueryResult>,
  failure: (error: unknown) => unknown = (error) => error,
): DatabaseWriter {
  // A `run` that throws is a rejection, as it was when each of these was an async function.
  const start = (sql: string, params?: SqlParam[]): Promise<SqlQueryResult> => {
    try {
      return run(sql, params);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const rowsOf = (result: SqlQueryResult): Row[] => {
    try {
      return objects(result);
    } catch (error) {
      throw failure(error);
    }
  };
  return {
    query: <T>(sql: string, params?: SqlParam[]) => start(sql, params).then(rowsOf) as Promise<T[]>,
    get: <T>(sql: string, params?: SqlParam[]) =>
      start(sql, params).then((result) => rowsOf(result)[0] as T | undefined),
    values: (sql, params) => start(sql, params).then((result) => result.rows),
    execute: (sql, params) => start(sql, params).then(nothing),
  };
}

/**
 * A key/value store, the object's state: `set` and `clear` return at once,
 * and `sync` resolves once every write before it is stored. Writes are
 * stored in the order they were made: a crash keeps a prefix of the writes
 * since the last sync and loses the rest. `get` returns the stored value, or
 * this request's own latest write; `undefined` or `null` when absent.
 */
export interface Store {
  get(key: string): Promise<Uint8Array | null | undefined>;
  set(key: string, value: Uint8Array): void;
  clear(key: string): void;
  sync(): Promise<void>;
  /**
   * Every key, as `ctx.stateKeys()`: then a commit that checkpoints deletes
   * the packs no checkpoint needs any more. A store without it keeps them.
   */
  keys?(): Promise<string[]>;
}

/** The addon (`native/src/node.rs`). */
interface Addon {
  open(namespace: string, store: Store, reader: boolean): Promise<NativeSession>;
  openOnVm(namespace: string, store: Store, vm: Vm, name: string | undefined, reader: boolean): Promise<NativeSession>;
}

/**
 * A session of the addon: one call at a time holds it. A transaction's body
 * runs between `begin` and `commit` (or `rollback`). A call answers at once
 * with its value (or throws) when it needs nothing from the store, such as
 * SQL on cached pages, and with a promise when it waits for the store.
 */
interface NativeSession {
  queryColumns(sql: string, params?: SqlParam[]): Answer<SqlQueryResult>;
  begin(): Answer<void>;
  commit(records: Record<string, Buffer>): Answer<void>;
  rollback(): Answer<void>;
  record(name: string): Answer<Buffer>;
  isUsable(): boolean;
  save(): Answer<void>;
  close(): Promise<void>;
}

/** A value, or a promise of it: `await` takes either. */
type Answer<T> = T | Promise<T>;

/**
 * Run `fn`, keeping the attempt alive meanwhile: the attempt's `working`
 * (see `driver.ts`). The database's calls run in it, being local work that
 * never waits on Restate for long.
 */
export type Working = <T>(fn: () => T | Promise<T>) => Promise<T>;

const addon = loaded as unknown as Addon;

/**
 * Open the database of `namespace` over `store`. One process-wide page cache
 * serves every namespace. A `reader` reads beside the namespace's owner (a
 * shared handler), the state as of open, and writes nothing.
 */
export async function open(namespace: string, store: Store, { reader = false } = {}): Promise<Connection> {
  const boundary = new Boundary(store);
  try {
    return new Connection(await addon.open(namespace, boundary, reader), boundary);
  } catch (error) {
    throw boundary.failed?.error ?? error;
  }
}

/**
 * Open the database of `namespace` over the attempt's VM: the state is read
 * and written as the VM's own commands, in the addon, so none of it crosses
 * into JavaScript. `store` is called at one point only — its `sync`, which the
 * boundary uses to run what the committing transaction gave
 * {@link ConnectionTransaction.withCommit} — so its `get`, `set` and `clear`
 * are never reached. `name` names a database beside the object's own.
 */
export async function openOnVm(
  namespace: string,
  store: Store,
  vm: Vm,
  { name, reader = false, working }: { name?: string; reader?: boolean; working?: Working } = {},
): Promise<Connection> {
  const boundary = new Boundary(store, working);
  try {
    return new Connection(await boundary.alive(() => addon.openOnVm(namespace, boundary, vm, name, reader)), boundary);
  } catch (error) {
    // The open reads the database's head. On this path that read waits in the
    // addon, so its failure arrives as text and `boundary.failed` is never
    // set: a cancellation here must still reach the handler as one.
    throw stateWaitFailure(error) ?? boundary.failed?.error ?? error;
  }
}

/**
 * The store as the addon calls it. An error of the store's crosses the addon
 * as text, which ends the session: the first is kept here, and the calls that
 * fail on the session it ended fail with it as it was thrown (the SDK's
 * CancelledError, say). And a commit's sync first runs what its transaction
 * gave {@link ConnectionTransaction.withCommit}: after the commit's writes,
 * before anything is awaited.
 */
class Boundary implements Store {
  /** The first error of the store's. */
  failed: { error: unknown } | undefined;
  /** What the next sync runs first: the committing transaction's. */
  withSync: (() => void) | undefined;
  readonly keys?: () => Promise<string[]>;
  private readonly store: Store;
  private readonly working: Working | undefined;

  constructor(store: Store, working?: Working) {
    this.store = store;
    this.working = working;
    // A store without keys keeps its garbage (see `Store.keys`).
    const keys = store.keys?.bind(store);
    if (keys) this.keys = () => this.kept(keys);
  }

  get(key: string) {
    return this.kept(() => this.store.get(key));
  }

  set(key: string, value: Uint8Array) {
    this.kept(() => this.store.set(key, value));
  }

  clear(key: string) {
    this.kept(() => this.store.clear(key));
  }

  sync() {
    return this.kept(() => {
      const run = this.withSync;
      this.withSync = undefined;
      run?.();
      return this.store.sync();
    });
  }

  /** `call`, in the attempt's `working` scope if the database has one. */
  alive<T>(call: () => T | Promise<T>): Promise<T> {
    return this.working === undefined ? (async () => call())() : this.working(call);
  }

  /** `request`'s result, keeping its error, thrown at once or rejected. */
  private kept<T>(request: () => T): T {
    const keep = (error: unknown): never => {
      this.failed ??= { error };
      throw error;
    };
    try {
      const result = request();
      return (result instanceof Promise ? result.catch(keep) : result) as T;
    } catch (error) {
      return keep(error);
    }
  }
}

/**
 * SQL on a session of the addon: {@link DatabaseWriter}'s `query` and `execute`
 * by way of its `queryColumns`.
 */
abstract class Sql implements DatabaseWriter {
  protected readonly native: NativeSession;
  protected readonly boundary: Boundary;
  private readonly over: DatabaseWriter;

  constructor(native: NativeSession, boundary: Boundary) {
    this.native = native;
    this.boundary = boundary;
    this.over = sqlOver((s, p) => this.queryColumns(s, p));
  }

  abstract queryColumns(sql: string, params?: SqlParam[]): Promise<SqlQueryResult>;

  query<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
    return this.over.query<T>(sql, params);
  }

  get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    return this.over.get<T>(sql, params);
  }

  values(sql: string, params?: SqlParam[]): Promise<SqlValue[][]> {
    return this.over.values(sql, params);
  }

  async execute(sql: string, params?: SqlParam[]): Promise<void> {
    await this.queryColumns(sql, params);
  }

  /**
   * `call`'s result, or its {@link failure}: `call` makes the request, as the
   * addon throws as it is called (arguments it cannot convert, and the error
   * of a call that answers at once).
   */
  protected request<T>(call: () => Answer<T>): Promise<T> {
    let alive: Promise<T>;
    try {
      alive = this.boundary.alive(call);
    } catch (error) {
      return Promise.reject(this.failure(error));
    }
    return alive.catch((error: unknown) => {
      throw this.failure(error);
    });
  }

  /**
   * A request's `error`: an {@link SqlError} if a retry would repeat it; the
   * store's own error if that ended the session.
   */
  protected failure(error: unknown): unknown {
    if (error instanceof SqlError) return error;
    // The state is read and written in the addon on the VM's path, so the
    // end of the attempt fails those waits there and its text is all that
    // crosses back. Give the handler the class the driver's own awaits fail
    // with.
    const stateWait = stateWaitFailure(error);
    if (stateWait !== undefined) return stateWait;
    const failed = this.boundary.failed;
    if (failed !== undefined && !this.native.isUsable()) return failed.error;
    const repeats = (error as { code?: unknown }).code === REFUSED || this.native.isUsable();
    return repeats ? new SqlError((error as Error).message, { cause: error }) : error;
  }
}

// The code of the addon's errors that a retry would repeat even though they
// ended the session (its `Refused`), and of arguments it cannot convert.
const REFUSED = 'InvalidArg';

/**
 * The error of a call that failed because the attempt's state waits were
 * failed in the addon, at the end of the attempt. `undefined` for anything
 * else.
 */
function stateWaitFailure(error: unknown): unknown {
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;
  if (message.includes(STATE_WAIT_OVER)) return new AttemptShutDown();
  return undefined;
}

/**
 * A session of a database: calls run one at a time, in call order, and a
 * transaction holds the session until it commits or rolls back. Calls made
 * meanwhile wait, but a call from inside the transaction's body is refused,
 * as it would wait for that body: the body uses its `tx`.
 */
export class Connection extends Sql {
  /** This session's transaction whose body is running, in that body's asynchronous context. */
  private readonly running = new AsyncLocalStorage<OpenTransaction>();
  /** Settles once the last call queued so far has: the next call runs after it. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The last transaction queued, until it has committed or rolled back: a call queued behind it fires it. */
  private tail: Gate | undefined;

  queryColumns(sql: string, params?: SqlParam[]): Promise<SqlQueryResult> {
    return this.serial(() => this.request(() => this.native.queryColumns(sql, params)));
  }

  /**
   * Run `body` as one SQL transaction: it commits when `body` resolves, with
   * the records it set, and rolls back when it rejects, with the body's own
   * error, once the calls it made have settled. A statement in it that ends
   * the transaction (`COMMIT`, `ROLLBACK`) ends the session. A failing
   * COMMIT rolls back.
   */
  transaction<T>(body: (tx: ConnectionTransaction) => Promise<T>): Promise<T> {
    const gate = new Gate();
    return this.serial(async () => {
      try {
        return await this.run(gate, body);
      } finally {
        if (this.tail === gate) this.tail = undefined;
      }
    }, gate);
  }

  private async run<T>(gate: Gate, body: (tx: ConnectionTransaction) => Promise<T>): Promise<T> {
    await this.request(() => this.native.begin());
    const tx = new OpenTransaction(this.native, this.boundary, gate.promise);
    let result: T;
    try {
      result = await this.running.run(tx, () => body(tx));
    } catch (error) {
      await tx.end();
      await this.rollback();
      throw error;
    }
    const records = await tx.end();
    // Its commit's sync runs what the body gave `withCommit`; one that
    // wrote nothing synced nothing, and it runs after.
    this.boundary.withSync = tx.commitRuns();
    let unsynced: (() => void) | undefined;
    try {
      await this.boundary.alive(() => this.native.commit(records));
    } catch (error) {
      // A COMMIT that fails (a deferred constraint) leaves the transaction
      // open: without the rollback, the calls after it would run inside it.
      await this.rollback();
      throw this.failure(error);
    } finally {
      unsynced = this.boundary.withSync;
      this.boundary.withSync = undefined;
    }
    unsynced?.();
    return result;
  }

  /**
   * The record `name`, as the last commit that set it left it (see
   * {@link ConnectionTransaction.setRecord}); empty if none did.
   */
  record(name: string): Promise<Uint8Array> {
    return this.serial(async () => new Uint8Array(await this.request(() => this.native.record(name))));
  }

  /** Whether SQL can still run: an SQL error leaves the session usable, a storage error ends it. */
  isUsable(): boolean {
    return this.native.isUsable();
  }

  /**
   * End the session after the calls before it, leaving its engine to the
   * next one. It rejects if they left a transaction open, or a failure ended
   * the session.
   */
  save(): Promise<void> {
    return this.serial(() => this.request(() => this.native.save()));
  }

  /** End the session now, whatever its state: queued calls reject. */
  close(): Promise<void> {
    return this.native.close();
  }

  /** Run `call` once the calls before it have, unless it comes from the body of a transaction it would wait for. */
  private serial<T>(call: () => Promise<T>, transaction?: Gate): Promise<T> {
    if (this.running.getStore()?.open) {
      return Promise.reject(new SqlError('inside a transaction, use the transaction handle its body gets'));
    }
    // A call queued behind the last transaction tells it so; a transaction
    // that is itself the last one queued from now on is told by the next.
    this.tail?.fire();
    if (transaction !== undefined) this.tail = transaction;
    const result = this.queue.then(call);
    this.queue = result.then(undefined, nothing);
    return result;
  }

  /** Roll back, unless a storage error ended the session: the caller rethrows its own error, which says why. */
  private async rollback(): Promise<void> {
    try {
      await this.native.rollback();
    } catch {}
  }
}

/** SQL in one transaction, while its body runs, and the records it commits with. */
export interface ConnectionTransaction extends DatabaseWriter {
  /** The rows of one statement, with their column names. */
  queryColumns(sql: string, params?: SqlParam[]): Promise<SqlQueryResult>;
  /**
   * Set the record `name` to `value` with this transaction, in the same
   * write: a whole value kept beside the SQL, in no table, stored exactly
   * when the transaction is, even if it changes no row. It stays until a
   * later transaction sets it again; an empty value reads as never set. A
   * name is at most 255 bytes, and not `db`; a value at most 16 MiB.
   */
  setRecord(name: string, value: Uint8Array): void;
  /** The record `name` as this transaction would commit it: as it set it, or as committed. */
  record(name: string): Promise<Uint8Array>;
  /**
   * Run `run` with the commit, right after its writes and before it waits
   * for them to be stored: the store's host gets what `run` makes after the
   * writes, and before anything that fails the commit's wait (Restate's
   * sends, which it stores in order with the writes). Never if the
   * transaction rolls back.
   */
  withCommit(run: () => void): void;
  /**
   * Settles, and never rejects, once another call to the connection has
   * queued behind this transaction: it is waiting for the body to settle.
   * A body that holds the transaction open for more work can return on it,
   * so that the call costs one commit rather than a stall. A call made
   * before the transaction began does not settle it, and neither does one
   * made from the body, which is refused.
   */
  readonly queued: Promise<void>;
}

/** A promise that settles once {@link fire}d. */
class Gate {
  readonly promise: Promise<void>;
  private resolve!: () => void;
  constructor() {
    this.promise = new Promise<void>((resolve) => (this.resolve = resolve));
  }
  fire(): void {
    this.resolve();
  }
}

/**
 * A {@link ConnectionTransaction} of {@link Connection.transaction}, open until its body
 * settles. Its calls run one at a time, in call order, also when the body
 * awaits several together, or none: each call made while it is open runs
 * before its commit or rollback, so none outlives it.
 */
class OpenTransaction extends Sql implements ConnectionTransaction {
  /** The records it sets, by name. */
  private readonly records = new Map<string, Buffer>();
  /** What runs with its commit (`withCommit`). */
  private readonly withCommits: (() => void)[] = [];
  /** Settles once the last call queued so far has: the next call runs after it. */
  private queue: Promise<unknown> = Promise.resolve();
  private ended = false;
  readonly queued: Promise<void>;

  constructor(native: NativeSession, boundary: Boundary, queued: Promise<void>) {
    super(native, boundary);
    this.queued = queued;
  }

  /** Whether it is open: its body runs, and holds its session. */
  get open(): boolean {
    return !this.ended;
  }

  /**
   * End it, refusing calls from now on, once the calls made before have
   * settled; then the records it set, as the addon's commit takes them.
   */
  async end(): Promise<Record<string, Buffer>> {
    this.ended = true;
    await this.queue;
    return Object.fromEntries(this.records);
  }

  queryColumns(sql: string, params?: SqlParam[]): Promise<SqlQueryResult> {
    return this.serial(() => this.request(() => this.native.queryColumns(sql, params)));
  }

  setRecord(name: string, value: Uint8Array): void {
    this.refuseEnded();
    this.records.set(name, Buffer.from(value));
  }

  withCommit(run: () => void): void {
    this.refuseEnded();
    this.withCommits.push(run);
  }

  /** What runs with its commit, once it ended: see {@link withCommit}. */
  commitRuns(): (() => void) | undefined {
    const runs = this.withCommits;
    return runs.length === 0 ? undefined : () => runs.forEach((run) => run());
  }

  record(name: string): Promise<Uint8Array> {
    // As set when it is called, in call order with `setRecord`.
    const set = this.records.get(name);
    return this.serial(async () => new Uint8Array(set ?? (await this.request(() => this.native.record(name)))));
  }

  /** Run `call`, made while the transaction is open, once the calls before it have. */
  private serial<T>(call: () => Promise<T>): Promise<T> {
    if (this.ended) return Promise.reject(new SqlError('the transaction has ended'));
    const result = this.queue.then(call);
    this.queue = result.then(undefined, nothing);
    return result;
  }

  private refuseEnded(): void {
    if (this.ended) throw new SqlError('the transaction has ended');
  }
}
