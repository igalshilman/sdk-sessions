// pi-durable storage on an SQL database: the `SqliteDatabase` facade of
// @earendil-works/chord/sqlite, over a database session `db` (in Restate,
// `ctx.db`), which has `query`, `get`, `execute` and
// `transaction(body)`.
//
// The facade's operations must run one at a time, a transaction excluding
// every other: the session does that, and a transaction's handle is invalid
// once its body settles. A statement outside a transaction is its own
// transaction.
//
// With `commits: 'effects'` the adapter batches: between two effects (a model
// call, a tool) the commits of pi share one transaction of the session, held
// open and written once, when an effect starts, something else is about to
// see what was stored, or another call to the session waits for it. See
// {@link SqlKvDatabase}.
//
// pi-durable's tables and indexes are named `restate_pi_<name>` (its
// storage's `prefix`), apart from the tables of yours in the same database.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseWriter, Database, Transaction } from '@restatedev/sessions';
import {
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from '@earendil-works/pi-durable/storage/sqlite';

/** The prefix of pi-durable's tables and indexes. */
const PREFIX = 'restate_pi_';

/** SQL through `db`: the session, or one transaction's. */
class Executor implements SqliteExecutor {
  readonly db: DatabaseWriter;
  constructor(db: DatabaseWriter) {
    this.db = db;
  }
  async exec(sql: string) {
    await this.db.execute(sql);
  }
  async run(sql: string, ...params: SqliteValue[]) {
    await this.db.execute(sql, params);
  }
  /** `run`, resolving with the rows it changed: SQLite's `changes()`, read next on the same connection. */
  async runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    await this.db.execute(sql, params);
    return (await this.db.get<{ n: number }>('SELECT changes() AS n'))!.n;
  }
  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.db.get<T>(sql, params);
  }
  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.db.query<T>(sql, params);
  }
}

/** What runs at the end of each pi commit, in its transaction: the copy of its entries (index.ts). */
export type OnCommit = (tx: Transaction) => Promise<void>;

/** How pi's commits are written: one each, or one for all those between two effects. */
export type Commits = 'effects' | 'each';

/** What the adapter reports and takes. */
export interface SqlKvOptions {
  /** Default `'each'`: every pi commit is a transaction of the session, as ever. */
  commits?: Commits;
  /**
   * Told once, with the error, when a batch fails to commit: the pi commits
   * in it were reported to pi as done and are lost, so the attempt must
   * fail (the adapter's later calls all reject with that error, too).
   */
  failed?: (error: unknown) => void;
}

/** The transaction that holds a batch of pi's commits open: its handle, and how to end it. */
interface Batch {
  readonly tx: Transaction;
  /** Run a function in the async context of the transaction's body, where the session refuses `ctx.db` calls. */
  readonly run: <R>(fn: () => R) => R;
  /** Let the body return, so that the transaction commits. */
  readonly release: () => void;
  /** Make the body throw `error`, so that the session rolls the whole transaction back, its sends with it. */
  readonly abort: (error: unknown) => void;
}

/** An open batch, and the promise that settles when its transaction has committed or failed. */
interface Held {
  readonly batch: Batch;
  readonly done: Promise<void>;
  /** Whether a write of it was told to its caller as done: only then is a failure to commit it a loss. */
  acknowledged: boolean;
}

/** `tx`, whose `send` is the real one, and tells `sent` when it is called. */
function noting(tx: Transaction, sent: () => void): Transaction {
  const send = new Proxy(tx.send, {
    apply(target, thisArg, args: Parameters<Transaction['send']>) {
      sent();
      return Reflect.apply(target, thisArg, args) as unknown;
    },
  });
  return { ...tx, send };
}

/** The refusal of a call to the adapter from the callback of one of its transactions, which would wait for itself. */
const REFUSED = 'inside a transaction, use the transaction handle its callback gets';

/**
 * The `SqliteDatabase` facade over the session `db`.
 *
 * With the default `commits: 'each'`, each `transaction(callback)` of pi is
 * one transaction of the session: one write, one round trip to Restate.
 *
 * With `'effects'`, while it is {@link armed} and no effect is in flight
 * ({@link effectStarted}), the first write opens one transaction of the
 * session that stays open, and each pi transaction is a savepoint in it
 * (a failed one undoes only itself). {@link flush} ends it: the real commit,
 * and then the `afterCommit` of every pi commit in it. It ends also when
 * another call to the session queues behind it (a `ctx.db` call of the
 * handler): that call then waits for one commit and no more. While an
 * effect is in flight, every pi commit is a transaction of its own, as with
 * `'each'`. Reads see the open batch. All calls run one at a time on a chain
 * of their own.
 */
export class SqlKvDatabase extends Executor implements SqliteDatabase {
  readonly #session: Database;
  readonly #batching: boolean;
  readonly #failed: ((error: unknown) => void) | undefined;
  /** Runs at the end of each commit, in its transaction, so that what it writes commits with it. */
  onCommit: OnCommit | undefined;
  /** Runs once each commit is done, outside its transaction: to tell others what it stored, say. */
  afterCommit: (() => Promise<void>) | undefined;
  /** Settles when the last call made so far has: the next runs after it. */
  #chain: Promise<unknown> = Promise.resolve();
  #batch: Held | undefined;
  #armed = false;
  #effects = 0;
  /** The `afterCommit` of each commit in the batch, run after its real commit. */
  #after: (() => Promise<void>)[] = [];
  /** The error of the first batch that failed, which every later call fails with. */
  #failure: { error: unknown } | undefined;
  /** Whether the attempt has been told of it. */
  #told = false;
  /** Settles when the `afterCommit` callbacks started so far have run. */
  #afterRun: Promise<unknown> = Promise.resolve();
  /** Set while `afterCommit` callbacks run: a flush from one of them has them to wait for. */
  readonly #inAfter = new AsyncLocalStorage<true>();
  /** Set inside the callback of a transaction: a call to the adapter from there would wait for itself. */
  readonly #inside = new AsyncLocalStorage<true>();

  constructor(db: Database, { commits = 'each', failed }: SqlKvOptions = {}) {
    super(db);
    this.#session = db;
    this.#batching = commits === 'effects';
    this.#failed = failed;
  }

  /**
   * Whether commits are batched while no effect is in flight: set while pi
   * runs a prompt, and off otherwise. Ending the batch is the caller's
   * ({@link flush}). Without `'effects'` it does nothing.
   */
  set armed(armed: boolean) {
    this.#armed = armed && this.#batching;
  }

  /**
   * An effect starts: a model call or a tool, which must see what pi stored
   * before, and which may store commits of its own. Until the returned
   * function is called (once at most; later calls do nothing) every commit
   * is written at once. It starts no flush: {@link flush} does. An effect
   * whose end is never called leaves the batching off, which is how it was.
   */
  effectStarted(): () => void {
    if (!this.#batching) return () => {};
    this.#effects++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#effects--;
    };
  }

  /**
   * Write what the batch holds: its real commit, then what `afterCommit`
   * of each of its commits does, in order. Nothing if none is open.
   * Rejects if the commit failed (see {@link SqlKvOptions.failed}), and from
   * the callback of a transaction, which would wait for itself.
   */
  async flush(): Promise<void> {
    if (!this.#batching) return;
    if (this.#inside.getStore()) throw new Error(REFUSED);
    await this.#run(() => this.#closeBatch());
    await this.#runAfter();
  }

  /** Commits when the callback resolves; rolls back, and rejects with its error, when it rejects. */
  async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    if (!this.#batching) {
      const result = await this.#session.transaction(async (tx) => {
        const done = await callback(new Executor(tx));
        if (this.onCommit) await this.onCommit(tx);
        return done;
      });
      if (this.afterCommit) await this.afterCommit();
      return result;
    }
    this.#refuseInside();
    const after = this.afterCommit;
    const { result, batched } = await this.#run(async () => {
      if (!this.#writesBatched()) return { result: await this.#commitAlone(callback), batched: false };
      return { result: await this.#savepoint(callback, after), batched: true };
    });
    // Outside the chain: it may publish, which flushes.
    if (!batched && after) await after();
    return result;
  }

  override exec(sql: string) {
    return this.#batching ? this.#write((e) => e.exec(sql)) : super.exec(sql);
  }

  override run(sql: string, ...params: SqliteValue[]) {
    return this.#batching ? this.#write((e) => e.run(sql, ...params)) : super.run(sql, ...params);
  }

  /**
   * Outside a transaction, the statement and its count are one: another
   * statement between them would be what `changes()` counted.
   */
  override runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    if (!this.#batching) return this.#session.transaction((tx) => new Executor(tx).runCounted(sql, ...params));
    return this.#write((e) => e.runCounted(sql, ...params), true);
  }

  override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#batching ? this.#read((e) => e.get<T>(sql, ...params)) : super.get<T>(sql, ...params);
  }

  override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#batching ? this.#read((e) => e.all<T>(sql, ...params)) : super.all<T>(sql, ...params);
  }

  /**
   * Writes what the batch holds (a prompt's end has written it already: a batch left now is one of a run that
   * was abandoned as the attempt ended or failed), without failing: the error the attempt ends with is the
   * attempt's, not this write's, which is told to the attempt and refused to every later call. The session is
   * the caller's to end, after the calls made before.
   */
  async close() {
    await this.flush().catch(() => {});
  }

  /** Whether the next write joins the batch: armed, and no effect in flight. */
  #writesBatched(): boolean {
    return this.#armed && this.#effects === 0;
  }

  #refuseInside() {
    if (this.#inside.getStore()) throw new Error(REFUSED);
  }

  /** `call`, once the calls before it have ended, unless a batch failed. */
  #run<T>(call: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(() => {
      if (this.#failure) {
        this.#tell();
        throw this.#failure.error;
      }
      return call();
    });
    this.#chain = result.catch(() => {});
    return result;
  }

  /** A read: in the batch if one is open (it sees its writes), else on the session, which opens nothing. */
  #read<T>(read: (executor: Executor) => Promise<T>): Promise<T> {
    this.#refuseInside();
    return this.#run(() => read(new Executor(this.#batch ? this.#batch.batch.tx : this.#session)));
  }

  /** A write outside a transaction: in the batch if batched, else a transaction of its own. */
  #write<T>(write: (executor: Executor) => Promise<T>, counted = false): Promise<T> {
    this.#refuseInside();
    return this.#run(async () => {
      if (this.#writesBatched()) {
        const batch = await this.#opened();
        const result = await write(new Executor(batch.tx));
        this.#batch!.acknowledged = true;
        return result;
      }
      await this.#closeBatch();
      // `runCounted` is a transaction of its own, as ever; the others are one statement.
      return counted ? this.#session.transaction((tx) => write(new Executor(tx))) : write(new Executor(this.#session));
    });
  }

  /** One pi transaction that is a transaction of the session: not batched, with its `onCommit` in it. */
  async #commitAlone<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    await this.#closeBatch();
    return this.#session.transaction((tx) =>
      this.#inside.run(true, async () => {
        const done = await callback(new Executor(tx));
        if (this.onCommit) await this.onCommit(tx);
        return done;
      }),
    );
  }

  /**
   * One pi transaction in the batch, as a savepoint: released when it
   * succeeds, rolled back (and released) when it fails, so that a failed
   * one undoes only itself. Its `afterCommit` waits for the batch's commit.
   */
  async #savepoint<T>(
    callback: (transaction: SqliteExecutor) => Promise<T>,
    after: (() => Promise<void>) | undefined,
  ): Promise<T> {
    const { tx, run } = await this.#opened();
    const held = this.#batch!;
    await tx.execute('SAVEPOINT restate_pi');
    // Whether this commit sent something. A send is recorded on the held transaction, and its real commit
    // makes it whatever a savepoint did: rolling the savepoint back does not take it back. So a commit that
    // sent and then failed cannot be undone alone; the whole batch is (below).
    let sent = false;
    let result: T;
    try {
      // In the async context of the batch's body, so that a call to `ctx.db` from the callback is refused
      // at once, as it is in a transaction of the session, and not left to wait for the batch.
      result = await run(() =>
        this.#inside.run(true, async () => {
          const done = await callback(new Executor(tx));
          if (this.onCommit) await this.onCommit(noting(tx, () => (sent = true)));
          return done;
        }),
      );
      await tx.execute('RELEASE restate_pi');
    } catch (error) {
      if (sent) {
        await this.#abandon(held, error);
        throw error;
      }
      try {
        await tx.execute('ROLLBACK TO restate_pi');
        await tx.execute('RELEASE restate_pi');
      } catch {
        // The session failed too: the error of the commit is what the caller gets, and the next call fails.
      }
      throw error;
    }
    held.acknowledged = true;
    if (after) this.#after.push(after);
    return result;
  }

  /**
   * Drop the batch with `error`: its body throws, the session rolls the whole transaction back, and its sends
   * are never made. If the commits in it were told to pi as done, they are lost, as with a failed write.
   */
  async #abandon(held: Held, error: unknown): Promise<void> {
    this.#batch = undefined;
    held.batch.abort(error);
    await held.done.catch(() => {});
    if (held.acknowledged) this.#fail(error);
  }

  /** The open batch, opened if there is none. */
  async #opened(): Promise<Batch> {
    if (this.#batch) return this.#batch.batch;
    const opened = Promise.withResolvers<Batch>();
    const released = Promise.withResolvers<void>();
    const done = this.#session.transaction(async (tx) => {
      opened.resolve({ tx, run: AsyncLocalStorage.snapshot(), release: released.resolve, abort: released.reject });
      await released.promise;
    });
    // A failure before the body ran: the open itself.
    done.catch((error: unknown) => opened.reject(error));
    // A batch that could not be opened lost nothing: the call that asked for it fails, as one does without
    // batching (a cancellation owed to the handler is delivered once, say), and the next one tries again.
    const batch = await opened.promise;
    const held: Held = { batch, done, acknowledged: false };
    // Failing while it waits to be ended, with something told as done, is every later call's error.
    done.catch((error: unknown) => (held.acknowledged ? this.#fail(error, false) : undefined));
    this.#batch = held;
    // Another call to the session queued behind it: end it, after the call of pi under way.
    // A failure is the attempt's already (`#fail`): nobody waits for this flush.
    void batch.tx.queued.then(() => (this.#batch === held ? this.flush().catch(() => {}) : undefined));
    return batch;
  }

  /** End the batch, if one is open: its commit, which the calls after it wait for. */
  async #closeBatch(): Promise<void> {
    const held = this.#batch;
    if (!held) return;
    this.#batch = undefined;
    held.batch.release();
    try {
      await held.done;
    } catch (error) {
      // What was told to pi as done is lost; if nothing was, this fails as the commit it was would have.
      if (!held.acknowledged) throw error;
      this.#after = [];
      throw this.#fail(error);
    }
  }

  /**
   * Run what the commits of the last batch asked to run after it, in order,
   * after what an earlier flush is running: a flush that returns has had
   * all of those done, so that effects that start together start after the
   * publish that they all wait for, in the order they asked. A callback that
   * flushes (a publish does) does not wait for itself.
   */
  #runAfter(): Promise<void> {
    if (this.#inAfter.getStore()) return Promise.resolve();
    const callbacks = this.#after.splice(0);
    const run = this.#afterRun.then(() =>
      this.#inAfter.run(true, async () => {
        for (const after of callbacks) await after();
      }),
    );
    this.#afterRun = run.catch(() => {});
    return run;
  }

  /**
   * A batch failed: the first error is every later call's, and the attempt is told once, unless `tell` is
   * false: a failure that nobody has run into yet (the session closing as the attempt ends is one) is told
   * when the next call meets it, not before, so that the error the attempt ends with is its own.
   */
  #fail(error: unknown, tell = true): unknown {
    this.#failure ??= { error };
    this.#after = [];
    if (tell) this.#tell();
    return this.#failure.error;
  }

  #tell() {
    if (this.#told || !this.#failure) return;
    this.#told = true;
    this.#failed?.(this.#failure.error);
  }
}

/** Open pi-durable storage on the session `db`, through `database`, its facade, if given (to set its `onCommit`). */
export function openSqlKvStorage(db: Database, database = new SqlKvDatabase(db)): Promise<SqliteStorage> {
  return SqliteStorage.open(database, { prefix: PREFIX });
}
