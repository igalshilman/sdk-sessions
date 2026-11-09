// A LangGraph checkpointer on an SQL database: `SqlCheckpointSaver`, over a
// database session `db` (in Restate, `ctx.db`), which has `query`, `execute`
// and `transaction(body)`.
//
// Three tables, with values as LangGraph's serializer writes them:
// - `restate_langgraph_checkpoints`: each checkpoint, without its channel values.
// - `restate_langgraph_channel_values`: each channel's value at each version, stored when a
//   step changes it. A checkpoint's values are those at its channel versions,
//   so a step stores only what it changed, not the whole state again (an
//   agent's message list, say). Versions are unique, as in LangGraph's own
//   savers (a count and a random part): a thread forked from an earlier
//   checkpoint takes the same counts again, and its values must not replace
//   those of the branch it forked from.
// - `restate_langgraph_writes`: the pending writes of each checkpoint's tasks.
//
// Each `put` and `putWrites` is one SQL transaction, so a step is stored whole,
// in order with everything else the handler does. Operations run one at a
// time, in call order: LangGraph writes the results of parallel tasks at once.
//
// By default a thread keeps every checkpoint (LangGraph's history: `list`,
// time travel, forks). With `history: 'latest'`, each `put` drops the
// thread's earlier checkpoints, their writes and the values only they had:
// a thread then takes the space of its state once, not once per step (a
// message list stored again at each step grows with the square of its
// length). A graph with a `DeltaChannel` keeps the checkpoints LangGraph
// rebuilds that channel from too (`#kept`), which a `put` finds from those
// the one before kept, without reading them again.
//
// A checkpoint's channel versions are matched as rows, `(channel, version)
// IN (VALUES (?, ?), …)`, never as an `OR` of each pair: the database refuses
// an expression more than 100 deep, and a graph may have more channels.
import { randomUUID } from 'node:crypto';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  maxChannelVersion,
  TASKS,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import type { DatabaseWriter, Database, SqlValue } from '@restatedev/sessions';
import { Schema } from '@restatedev/sessions/internal';

const SCHEMA = new Schema('restate-agents.langgraph', [
  `CREATE TABLE restate_langgraph_checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT NOT NULL,
    checkpoint BLOB NOT NULL,
    metadata BLOB NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  )`,
  `CREATE TABLE restate_langgraph_channel_values (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    value BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
  )`,
  `CREATE TABLE restate_langgraph_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  )`,
]);

const COLUMNS = 'thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata';

/** A row of `checkpoints`, in the order of COLUMNS. */
type CheckpointRow = [
  threadId: string,
  ns: string,
  checkpointId: string,
  parentId: string | null,
  type: string,
  checkpoint: Uint8Array,
  metadata: Uint8Array,
];

// The type of a channel a step emptied.
const EMPTY = 'empty';

/** Whether `actual` has every field of `expected`, recursively (a metadata filter). */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected) !== Array.isArray(actual)) return false;
  if (Array.isArray(expected) && expected.length !== (actual as unknown[]).length) return false;
  return Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
}

/**
 * `versions`, pairs of a channel and its version, as SQL rows to match
 * `(channel, version)` against, `(VALUES (?, ?), …)`, and their parameters.
 */
function pairs(versions: [string, unknown][]): [string, string[]] {
  return [
    `(VALUES ${versions.map(() => '(?, ?)').join(', ')})`,
    versions.flatMap(([channel, version]) => [channel, String(version)]),
  ];
}

/** The tables of a thread's checkpoints. */
const TABLES = ['restate_langgraph_checkpoints', 'restate_langgraph_channel_values', 'restate_langgraph_writes'];

/**
 * A checkpoint the latest of its thread needs (see `#kept`): its id, its
 * parent's, its channels' versions, and the delta channels whose steps since
 * their snapshots it counts (`counters_since_delta_snapshot`), of those it
 * holds.
 */
interface Needed {
  id: string;
  parent: string | null;
  versions: ChannelVersions;
  counted: Set<string>;
}

/** `checkpoint` (with `metadata`) as a checkpoint its thread's latest needs. */
function needed(
  id: string,
  parent: string | null,
  checkpoint: Pick<Checkpoint, 'channel_versions'>,
  metadata: unknown,
) {
  const versions = checkpoint.channel_versions ?? {};
  const counters = (metadata as { counters_since_delta_snapshot?: object } | undefined)?.counters_since_delta_snapshot;
  return { id, parent, versions, counted: new Set(Object.keys(counters ?? {}).filter((c) => c in versions)) };
}

/**
 * Drop what the thread `threadId` (namespace `ns`) keeps besides `kept`, its
 * latest checkpoint and those it needs: the other checkpoints, their pending
 * writes, and the channel values at versions none of `kept` has.
 */
async function dropEarlier(tx: DatabaseWriter, threadId: string, ns: string, kept: Needed[]) {
  const thread = [threadId, ns];
  const ids = kept.map((checkpoint) => checkpoint.id);
  for (const table of ['restate_langgraph_checkpoints', 'restate_langgraph_writes']) {
    await tx.execute(
      `DELETE FROM ${table} WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (${ids.map(() => '?').join(', ')})`,
      [...thread, ...ids],
    );
  }
  const versions = new Map<string, [string, unknown]>();
  for (const checkpoint of kept) {
    for (const [channel, version] of Object.entries(checkpoint.versions)) {
      versions.set(`${channel}\u0000${String(version)}`, [channel, version]);
    }
  }
  if (versions.size === 0) {
    await tx.execute('DELETE FROM restate_langgraph_channel_values WHERE thread_id = ? AND checkpoint_ns = ?', thread);
    return;
  }
  const [rows, params] = pairs([...versions.values()]);
  await tx.execute(
    `DELETE FROM restate_langgraph_channel_values WHERE thread_id = ? AND checkpoint_ns = ? AND (channel, version) NOT IN ${rows}`,
    [...thread, ...params],
  );
}

/** A LangGraph checkpointer whose threads are in the database session `db`: see the top of this file. */
export class SqlCheckpointSaver extends BaseCheckpointSaver {
  #db: Database;
  #latest: boolean;
  #metadata: Record<string, unknown>;
  /**
   * With `history: 'latest'`, the checkpoints the latest of each thread
   * (`[thread, namespace]`) needs, from it back, as the last `put` stored
   * them: a `put` of its child needs some of them, which it reads no more.
   */
  #needed = new Map<string, Needed[]>();
  #ready: Promise<void> | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * `db`: a database session (`ctx.db`). `history`: the checkpoints a thread
   * keeps, `all` (the default) or the `latest` only; `serde`: LangGraph's
   * serializer, by default its own; `metadata`: added to each checkpoint's
   * metadata (LangGraph's JavaScript runs do not store their config's).
   */
  constructor(
    db: Database,
    {
      history = 'all',
      serde,
      metadata = {},
    }: { history?: 'all' | 'latest'; serde?: SerializerProtocol; metadata?: Record<string, unknown> } = {},
  ) {
    super(serde);
    this.#db = db;
    this.#latest = history === 'latest';
    this.#metadata = metadata;
  }

  /**
   * The version after `current`: its count plus one, zero-padded so that
   * versions compare as their counts do, and a random part, so that branches
   * of a thread never share one. A string: LangGraph compares string versions
   * as strings, though `compile` types a saver's versions as numbers.
   */
  override getNextVersion(current: number | undefined): number {
    const count = current === undefined ? 0 : Number.parseInt(String(current).split('.')[0]!, 10);
    return `${String(count + 1).padStart(32, '0')}.${randomUUID()}` as unknown as number;
  }

  /** Runs `operation` after the ones before it, on a database with the tables. */
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    this.#ready ??= SCHEMA.ensure(this.#db);
    const result = this.#tail.then(() => this.#ready).then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  /** The values of `checkpoint`'s channels, at its versions. */
  async #channelValues(threadId: string, ns: string, checkpoint: Checkpoint): Promise<Record<string, unknown>> {
    const versions = Object.entries(checkpoint.channel_versions ?? {});
    const values: Record<string, unknown> = {};
    if (versions.length === 0) return values;
    const [pairsOf, params] = pairs(versions);
    const rows = await this.#db.values(
      `SELECT channel, type, value FROM restate_langgraph_channel_values WHERE thread_id = ? AND checkpoint_ns = ? AND (channel, version) IN ${pairsOf}`,
      [threadId, ns, ...params],
    );
    for (const [channel, type, value] of rows as [string, string, Uint8Array][]) {
      if (type !== EMPTY) values[channel] = await this.serde.loadsTyped(type, value);
    }
    return values;
  }

  async #tuple([
    threadId,
    ns,
    checkpointId,
    parentId,
    type,
    stored,
    metadata,
  ]: CheckpointRow): Promise<CheckpointTuple> {
    const checkpoint: Checkpoint = await this.serde.loadsTyped(type, stored);
    checkpoint.channel_values = await this.#channelValues(threadId, ns, checkpoint);
    // A checkpoint of an earlier format (v < 4) keeps its pending sends as
    // writes of its parent.
    if (checkpoint.v < 4 && parentId !== null) await this.#migratePendingSends(checkpoint, threadId, ns, parentId);
    const writes = await this.#db.values(
      'SELECT task_id, channel, type, value FROM restate_langgraph_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY rowid',
      [threadId, ns, checkpointId],
    );
    const config = (id: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: id } });
    return {
      config: config(checkpointId),
      checkpoint,
      metadata: await this.serde.loadsTyped(type, metadata),
      parentConfig: parentId === null ? undefined : config(parentId),
      pendingWrites: await Promise.all(
        (writes as [string, string, string, Uint8Array][]).map(
          async ([taskId, channel, writeType, value]): Promise<CheckpointPendingWrite> => [
            taskId,
            channel,
            await this.serde.loadsTyped(writeType, value),
          ],
        ),
      ),
    };
  }

  async #migratePendingSends(checkpoint: Checkpoint, threadId: string, ns: string, parentId: string) {
    const sends = await this.#db.values(
      'SELECT type, value FROM restate_langgraph_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel = ? ORDER BY rowid',
      [threadId, ns, parentId, TASKS],
    );
    checkpoint.channel_values[TASKS] = await Promise.all(
      (sends as [string, Uint8Array][]).map(([type, value]) => this.serde.loadsTyped(type, value)),
    );
    const versions = Object.values(checkpoint.channel_versions);
    checkpoint.channel_versions[TASKS] =
      versions.length > 0 ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
  }

  /**
   * The checkpoints of `threadId` (namespace `ns`) that its latest,
   * `checkpoint`, needs, by id: itself, and the ancestors LangGraph reads to
   * rebuild its delta channels (`getDeltaChannelHistory`), back to the
   * snapshot of each. A checkpoint's metadata counts, for each delta channel,
   * the steps since its snapshot (`counters_since_delta_snapshot`): a channel
   * with no count there was snapshotted at that checkpoint, and one the
   * checkpoint does not hold (`channel_versions`) was never written, so has
   * nothing to rebuild.
   */
  async #kept(tx: DatabaseWriter, threadId: string, ns: string, latest: Needed) {
    // Its parent's, as the last `put` kept them: what it needs is some of them, as its delta channels'
    // snapshots are its parent's, or itself.
    const cached = this.#needed.get(JSON.stringify([threadId, ns]));
    const ancestors = cached?.[0]?.id === latest.parent ? cached : undefined;
    const kept: Needed[] = [];
    let waiting: Set<string> | undefined;
    for (let next: Needed | undefined = latest, i = 0; next !== undefined;) {
      kept.push(next);
      const { counted } = next;
      waiting = waiting === undefined ? counted : new Set([...waiting].filter((channel) => counted.has(channel)));
      if (waiting.size === 0 || next.parent === null) break;
      next = ancestors ? ancestors[i++] : await this.#read(tx, threadId, ns, next.parent);
    }
    return kept;
  }

  /** Checkpoint `id` of `threadId` (namespace `ns`), as a checkpoint its latest needs, if it is stored. */
  async #read(tx: DatabaseWriter, threadId: string, ns: string, id: string): Promise<Needed | undefined> {
    const rows = await tx.values(
      'SELECT parent_checkpoint_id, type, checkpoint, metadata FROM restate_langgraph_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?',
      [threadId, ns, id],
    );
    const row = rows[0] as [string | null, string, Uint8Array, Uint8Array] | undefined;
    if (!row) return undefined;
    const [parent, type, stored, metadata] = row;
    const loaded: Checkpoint = await this.serde.loadsTyped(type, stored);
    return needed(id, parent, loaded, await this.serde.loadsTyped(type, metadata));
  }

  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.#serial(async () => {
      const { thread_id, checkpoint_ns = '', checkpoint_id } = config.configurable ?? {};
      const rows = checkpoint_id
        ? await this.#db.values(
            `SELECT ${COLUMNS} FROM restate_langgraph_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
            [thread_id, checkpoint_ns, checkpoint_id],
          )
        : await this.#db.values(
            `SELECT ${COLUMNS} FROM restate_langgraph_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`,
            [thread_id, checkpoint_ns],
          );
      return rows.length === 0 ? undefined : this.#tuple(rows[0] as CheckpointRow);
    });
  }

  async *list(
    config: RunnableConfig,
    { limit, before, filter }: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const tuples = await this.#serial(async () => {
      const { thread_id, checkpoint_ns } = config.configurable ?? {};
      const where: string[] = [];
      const params: SqlValue[] = [];
      const filters: [string, SqlValue | undefined][] = [
        ['thread_id = ?', thread_id],
        ['checkpoint_ns = ?', checkpoint_ns ?? undefined],
        ['checkpoint_id < ?', before?.configurable?.checkpoint_id],
      ];
      for (const [condition, value] of filters) {
        if (value === undefined) continue;
        where.push(condition);
        params.push(value);
      }
      const rows = await this.#db.values(
        `SELECT ${COLUMNS} FROM restate_langgraph_checkpoints ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY checkpoint_id DESC`,
        params,
      );
      const wanted = Object.fromEntries(Object.entries(filter ?? {}).filter(([, value]) => value !== undefined));
      const found: CheckpointTuple[] = [];
      for (const row of rows) {
        if (limit !== undefined && found.length >= limit) break;
        const tuple = await this.#tuple(row as CheckpointRow);
        if (matches(tuple.metadata, wanted)) found.push(tuple);
      }
      return found;
    });
    yield* tuples;
  }

  put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return this.#serial(async () => {
      const { thread_id, checkpoint_ns = '', checkpoint_id: parentId } = config.configurable ?? {};
      if (!thread_id) throw new Error('Missing "thread_id" field in passed "config.configurable".');
      const { channel_values: values, ...rest } = copyCheckpoint(checkpoint);
      const [type, stored] = await this.serde.dumpsTyped(rest);
      const [metadataType, metadataValue] = await this.serde.dumpsTyped({ ...metadata, ...this.#metadata });
      if (type !== metadataType) throw new Error('Failed to serialize checkpoint and metadata to the same type.');
      // The channels this step changed, at their new versions.
      const changed = await Promise.all(
        Object.entries(newVersions ?? {}).map(async ([channel, version]): Promise<SqlValue[]> => {
          const [valueType, value] = channel in values ? await this.serde.dumpsTyped(values[channel]) : [EMPTY, null];
          return [channel, String(version), valueType, value];
        }),
      );
      let kept: Needed[] | undefined;
      await this.#db.transaction(async (tx) => {
        for (const row of changed) {
          await tx.execute(
            'INSERT OR REPLACE INTO restate_langgraph_channel_values (thread_id, checkpoint_ns, channel, version, type, value) VALUES (?, ?, ?, ?, ?, ?)',
            [thread_id, checkpoint_ns, ...row],
          );
        }
        await tx.execute(
          `INSERT OR REPLACE INTO restate_langgraph_checkpoints (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [thread_id, checkpoint_ns, checkpoint.id, parentId ?? null, type, stored, metadataValue],
        );
        if (!this.#latest) return;
        const latest = needed(checkpoint.id, parentId ?? null, rest, metadata);
        kept = await this.#kept(tx, thread_id, checkpoint_ns, latest);
        await dropEarlier(tx, thread_id, checkpoint_ns, kept);
      });
      // Once stored: a transaction rolled back keeps the ones before.
      if (kept) this.#needed.set(JSON.stringify([thread_id, checkpoint_ns]), kept);
      return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } };
    });
  }

  putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return this.#serial(async () => {
      const { thread_id, checkpoint_ns = '', checkpoint_id } = config.configurable ?? {};
      if (!thread_id) throw new Error('Missing thread_id field in config.configurable.');
      if (!checkpoint_id) throw new Error('Missing checkpoint_id field in config.configurable.');
      // Special writes (errors, interrupts) replace; others keep the first.
      const verb = writes.every(([channel]) => channel in WRITES_IDX_MAP) ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
      const rows = await Promise.all(
        writes.map(async ([channel, value], idx): Promise<SqlValue[]> => {
          const [type, stored] = await this.serde.dumpsTyped(value);
          return [
            thread_id,
            checkpoint_ns,
            checkpoint_id,
            taskId,
            WRITES_IDX_MAP[channel] ?? idx,
            channel,
            type,
            stored,
          ];
        }),
      );
      await this.#db.transaction(async (tx) => {
        for (const row of rows) {
          await tx.execute(
            `${verb} INTO restate_langgraph_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            row,
          );
        }
      });
    });
  }

  /**
   * Delete checkpoints of `threadIds`: all but the latest of each namespace
   * (`keepLatest`, the default), or all (`delete`), as LangGraph's `prune`.
   * With `keepLatest`, the writes and channel values that only the deleted
   * checkpoints referenced go with them; the latest keeps its pending writes,
   * so a paused run still resumes, and its ancestors back to the snapshot of
   * each of its delta channels (see `#kept`). A namespace is the thread's own
   * (`''`) or a subgraph run's, which keeps its latest checkpoint too.
   */
  prune(threadIds: string[], { strategy = 'keepLatest' }: { strategy?: 'keepLatest' | 'delete' } = {}): Promise<void> {
    return this.#serial(() =>
      this.#db.transaction(async (tx) => {
        for (const threadId of threadIds) {
          if (strategy === 'delete') {
            for (const table of TABLES) await tx.execute(`DELETE FROM ${table} WHERE thread_id = ?`, [threadId]);
            continue;
          }
          const latest = await tx.values(
            'SELECT c.checkpoint_ns, c.checkpoint_id FROM restate_langgraph_checkpoints c WHERE c.thread_id = ? AND c.checkpoint_id = ' +
              '(SELECT max(l.checkpoint_id) FROM restate_langgraph_checkpoints l WHERE l.thread_id = c.thread_id AND l.checkpoint_ns = c.checkpoint_ns)',
            [threadId],
          );
          for (const [ns, id] of latest) {
            const checkpoint = await this.#read(tx, threadId, String(ns), String(id));
            if (!checkpoint) continue;
            this.#needed.delete(JSON.stringify([threadId, String(ns)]));
            await dropEarlier(tx, threadId, String(ns), await this.#kept(tx, threadId, String(ns), checkpoint));
          }
        }
      }),
    );
  }

  deleteThread(threadId: string): Promise<void> {
    return this.#serial(() =>
      this.#db.transaction(async (tx) => {
        for (const table of TABLES) await tx.execute(`DELETE FROM ${table} WHERE thread_id = ?`, [threadId]);
      }),
    );
  }
}
