// The DeepSeek Harness's session persistence (`ctx.sessionPersistence`) over
// a Restate virtual object's SQL database: each session's header, and its
// event log, one row per event, in order.
//
// The harness writes a session through a handle: `append` accepts a batch,
// and `flush` is the durability barrier. Here an append is kept in memory and
// a write stores everything appended before it in one SQL transaction; a new
// session's header is stored with its first write, so a session that crashed
// before then never existed. The session checkpoint policy
// (dsh-session-checkpoint-policy) flushes before each model request, before
// each tool body, and before each step.
//
// A write is a commit to Restate, so the harness's flushes are soft once the
// adapter has put its own barriers in place (`barriered`, set by index.ts
// only when it has): a soft flush stores nothing and resolves, leaving the
// events queued. The adapter's barriers (`writeNow`) store everything queued
// right before each model request and each tool body, before each Restate
// effect and publish, and at the end of the run. So the events a tool's call
// follows from are stored before the tool runs, and a crash loses only
// events that nothing has acted on. Without the barriers every flush is a
// write.
import type { Context } from '@deepseek-ai/cordis';
import { SessionLogOffset, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session';
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleReadResult,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence';
import type { Database, Transaction } from '@restatedev/sessions';
import { Schema } from '@restatedev/sessions/internal';

const SCHEMA = new Schema('restate-agents.deepseek', [
  'CREATE TABLE restate_deepseek_sessions (id TEXT PRIMARY KEY, header TEXT NOT NULL, inherited INTEGER NOT NULL)',
  'CREATE TABLE restate_deepseek_events (session TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (session, seq))',
]);

/** A session as stored: its header, inherited prefix length and event count. */
interface Stored {
  header: SessionHeader;
  inherited: number;
  count: number;
}

/** The harness's session persistence (a cordis plugin, `{ db }`): see the top of this file. */
export class SqlSessionPersistence extends SessionPersistence {
  // Plain fields, not private ones: cordis hands out the service through a proxy.
  db: Database;
  schema: Promise<void> | undefined;
  queue: Promise<unknown> = Promise.resolve();
  /** The open write handle of each session, by id. */
  writers = new Map<SessionId, SqlSessionHandle>();
  /** Sessions created and not stored yet: their headers and inherited counts, by id. */
  created = new Map<SessionId, Omit<Stored, 'count'>>();
  handles = new Set<SqlSessionHandle>();
  abandoned = false;
  /**
   * Whether the harness's flushes are soft: set by the code that installs the
   * adapter's barriers (index.ts), once every one of them is in place. Unset,
   * each flush stores what is queued.
   */
  barriered = false;
  /**
   * What each flush's events are copied into beside the log, in the flush's
   * transaction: the conversation of turns (index.ts), so that the copy and
   * the log commit together.
   */
  copy: ((tx: Transaction, events: readonly SessionEvent[]) => Promise<void>) | undefined;
  /** What runs once each flush is stored, outside its transaction: to tell others what it stored, say. */
  flushed: (() => Promise<void>) | undefined;

  /** `config.db`: the object's database (`ctx.db`). */
  constructor(ctx: Context, config: { db: Database }) {
    super(ctx);
    this.db = config.db;
    // The live session's events go to its write handle; its flushes and its
    // disposal reach the handle too.
    ctx.on('session/event', (session, event) => this.writers.get(session.id)?.enqueue(event));
    ctx.on('session/flush', (session) => this.writers.get(session.id)?.harnessFlush());
    ctx.on('session/disposed', (session) => void this.writers.get(session.id)?.close());
    ctx.effect(
      () => async () => {
        await Promise.all([...this.handles].map((handle) => handle.close()));
      },
      'sql session handles',
    );
  }

  /**
   * Store nothing more: what is not stored yet is lost, as in a crash. For an
   * attempt that fails, so that its retry resumes from the last checkpoint.
   */
  abandon() {
    this.abandoned = true;
  }

  /** Run `operation` on the database after the ones before it: it serves one statement at a time. */
  serial<T>(operation: (db: Database) => Promise<T>): Promise<T> {
    if (this.abandoned) return Promise.reject(new Error('sql session persistence: abandoned'));
    this.schema ??= SCHEMA.ensure(this.db);
    const result = this.queue.then(() => this.schema).then(() => operation(this.db));
    this.queue = result.catch(() => {});
    return result;
  }

  async stored(id: SessionId): Promise<Stored | undefined> {
    const created = this.created.get(id);
    if (created) return { ...created, count: 0 };
    const [row] = await this.serial((db) =>
      db.values(
        'SELECT header, inherited, (SELECT count(*) FROM restate_deepseek_events WHERE session = id) FROM restate_deepseek_sessions WHERE id = ?',
        [id],
      ),
    );
    return row && { header: JSON.parse(String(row[0])), inherited: Number(row[1]), count: Number(row[2]) };
  }

  async create(header: SessionHeader, options: SessionPersistenceCreateOptions = {}): Promise<SessionHandle> {
    const meta = materializeCreateHeader(header);
    if (await this.stored(meta.id)) throw new SessionAlreadyExistsError(meta.id);
    const inherited = options.inheritedEventCount ?? 0;
    this.created.set(meta.id, { header: meta, inherited });
    return this.openHandle(meta, inherited, 0, 'write');
  }

  async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const stored = await this.stored(id);
    if (!stored) throw new SessionPersistenceNotFoundError(id);
    if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
    return this.openHandle(stored.header, stored.inherited, stored.count, access);
  }

  openHandle(header: SessionHeader, inherited: number, count: number, access: SessionAccess): SqlSessionHandle {
    const handle: SqlSessionHandle = new SqlSessionHandle(this, header, inherited, count, access, () => {
      this.handles.delete(handle);
      if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id);
    });
    this.handles.add(handle);
    if (access === 'write') this.writers.set(handle.id, handle);
    return handle;
  }

  /** Store everything queued for session `id` now, or throw: the adapter's barrier before an effect (see the top). */
  async writeNow(id: SessionId): Promise<void> {
    await this.writers.get(id)?.writeNow();
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writers.values()].map((writer) => writer.flush()));
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, 'sql session persistence: flush failed');
  }

  async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const stored = await this.stored(id);
    return stored && snapshot(stored);
  }

  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    const rows = await this.serial((db) =>
      db.values(
        'SELECT header, inherited, (SELECT count(*) FROM restate_deepseek_events WHERE session = id) FROM restate_deepseek_sessions',
      ),
    );
    return [
      ...[...this.created.values()].map((created) => snapshot({ ...created, count: 0 })),
      ...rows.map(([header, inherited, count]) =>
        snapshot({ header: JSON.parse(String(header)), inherited: Number(inherited), count: Number(count) }),
      ),
    ];
  }
}

// The log is append-only, so its length identifies its revision.
const snapshot = ({ header, count }: Stored): SessionPersistenceSnapshot => ({
  header,
  revision: SessionPersistenceRevision(`${header.id}:${count}`),
  eventCount: count,
});

/** One open session: its stored events, and for a write handle the ones appended and not yet stored. */
class SqlSessionHandle implements SessionHandle {
  readonly id: SessionId;
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;
  readonly access: SessionAccess;
  #store: SqlSessionPersistence;
  #release: () => void;
  #stored: number; // events stored
  #pending: SessionEvent[] = []; // appended, not stored yet
  #flushing: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    store: SqlSessionPersistence,
    header: SessionHeader,
    inherited: number,
    stored: number,
    access: SessionAccess,
    release: () => void,
  ) {
    this.#store = store;
    this.header = header;
    this.id = header.id;
    this.inheritedEventCount = SessionLogOffset(inherited);
    this.access = access;
    this.#stored = stored;
    this.#release = release;
  }

  #check(operation: string) {
    if (this.#closed) throw new SessionHandleClosedError(this.id, operation);
  }

  /** The next seq: after every stored and appended event. */
  get #end() {
    return this.#stored + this.#pending.length;
  }

  async read(offset = 0, length = Infinity): Promise<SessionHandleReadResult> {
    this.#check('read');
    const rows = await this.#store.serial((db) =>
      db.values('SELECT event FROM restate_deepseek_events WHERE session = ? AND seq >= ? ORDER BY seq', [
        this.id,
        offset,
      ]),
    );
    let events: SessionEvent[] = [
      ...rows.map(([event]) => JSON.parse(String(event)) as SessionEvent),
      ...this.#pending.filter((e) => e.seq >= offset),
    ];
    if (offset === 0) events = validateStoredEvents(this.header, events);
    return { eventState: 'detached', events: events.slice(0, length) };
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    this.#check('append');
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append');
    const batch = materializeAppendBatch(events);
    assertContiguous(this.id, batch, this.#end);
    this.#pending.push(...batch);
  }

  /** A live session's event, routed here by the persistence service. */
  enqueue(event: SessionEvent) {
    if (this.#closed || event.seq < this.#end) return;
    this.#pending.push(...materializeAppendBatch([event]));
  }

  /**
   * The harness's flush (`session/flush`): a write, unless the adapter's
   * barriers cover the effects (`barriered`), when the events stay queued for
   * the next barrier.
   */
  harnessFlush(): Promise<void> {
    if (!this.#store.barriered) return this.flush();
    this.#check('flush');
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush');
    return Promise.resolve();
  }

  /** Store every event appended before the call, or throw if one is not stored. */
  async writeNow(): Promise<void> {
    const end = this.#end;
    await this.flush();
    // Events appended while it stored are for the next write; none before may be left.
    if (this.#stored < end || this.#store.created.has(this.id)) {
      throw new Error(`sql session persistence: the events of session ${this.id} are not stored`);
    }
  }

  /** Store every event appended so far, in one transaction. */
  flush(): Promise<void> {
    this.#check('flush');
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush');
    this.#flushing = this.#flushing.then(() => this.#write());
    return this.#flushing;
  }

  /** Store the events appended so far, and the session's header the first time, in one transaction. */
  async #write(): Promise<void> {
    const batch = this.#pending.slice();
    const created = this.#store.created.get(this.id);
    if (batch.length === 0 && !created) return;
    await this.#store.serial((db) =>
      db.transaction(async (tx) => {
        if (created) {
          await tx.execute('INSERT INTO restate_deepseek_sessions (id, header, inherited) VALUES (?, ?, ?)', [
            this.id,
            JSON.stringify(created.header),
            created.inherited,
          ]);
        }
        for (const event of batch) {
          await tx.execute('INSERT INTO restate_deepseek_events (session, seq, event) VALUES (?, ?, ?)', [
            this.id,
            event.seq,
            JSON.stringify(event),
          ]);
        }
        if (this.#store.copy) await this.#store.copy(tx, batch);
      }),
    );
    if (created) this.#store.created.delete(this.id);
    this.#pending.splice(0, batch.length);
    this.#stored += batch.length;
    if (this.#store.flushed) await this.#store.flushed();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      if (this.access === 'write') await this.flush().catch(() => {});
    } finally {
      this.#closed = true;
      // A session never stored is gone with its writer.
      if (this.access === 'write') this.#store.created.delete(this.id);
      this.#release();
    }
  }

  [Symbol.asyncDispose]() {
    return this.close();
  }
}
