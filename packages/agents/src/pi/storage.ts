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
// pi-durable's tables and indexes are named `restate_pi_<name>` (its
// storage's `prefix`), apart from the tables of yours in the same database.
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
  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.db.get<T>(sql, params);
  }
  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.db.query<T>(sql, params);
  }
}

/** What runs at the end of each pi commit, in its transaction: the copy of its entries (index.ts). */
export type OnCommit = (tx: Transaction) => Promise<void>;

/** The `SqliteDatabase` facade over the session `db`. */
export class SqlKvDatabase extends Executor implements SqliteDatabase {
  readonly #session: Database;
  /** Runs at the end of each commit, in its transaction, so that what it writes commits with it. */
  onCommit: OnCommit | undefined;
  /** Runs once each commit is done, outside its transaction: to tell others what it stored, say. */
  afterCommit: (() => Promise<void>) | undefined;

  constructor(db: Database) {
    super(db);
    this.#session = db;
  }

  /** Commits when the callback resolves; rolls back, and rejects with its error, when it rejects. */
  async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    const result = await this.#session.transaction(async (tx) => {
      const done = await callback(new Executor(tx));
      if (this.onCommit) await this.onCommit(tx);
      return done;
    });
    if (this.afterCommit) await this.afterCommit();
    return result;
  }

  /** The session is the caller's to end, after the calls made before. */
  async close() {}
}

/** Open pi-durable storage on the session `db`, through `database`, its facade, if given (to set its `onCommit`). */
export function openSqlKvStorage(db: Database, database = new SqlKvDatabase(db)): Promise<SqliteStorage> {
  return SqliteStorage.open(database, { prefix: PREFIX });
}
