// A task's pending writes in `SqlCheckpointSaver`: stored with the checkpoint that follows them in the same
// macrotask, in one commit, else on their own at the end of it, and a `putWrites` promise resolves once they are
// stored, as LangGraph awaits it. Commits are counted at the database's sync.
import { emptyCheckpoint, JsonPlusSerializer } from '@langchain/langgraph-checkpoint';
import { Annotation, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import type { Database } from '@restatedev/sessions';
import { describe, expect, it } from 'vitest';
import { SqlCheckpointSaver } from '@restatedev/agents/langgraph';
import { sqlAttempt } from './support.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const at = (checkpoint_id?: string) => ({ configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id } });
const metadata = { source: 'loop' as const, step: 0, parents: {} };

/** A serializer that cannot store `'bad'`, so that a write of it fails. */
class Refusing extends JsonPlusSerializer {
  override async dumpsTyped(value: unknown): Promise<[string, Uint8Array]> {
    if (value === 'bad') throw new Error('cannot store that');
    return super.dumpsTyped(value);
  }
}

/** The stored writes, as their task and channel, in the order they were stored. */
async function rowsOf(db: Pick<Database, 'values'>) {
  const rows = await db.values('SELECT task_id, channel FROM restate_langgraph_writes ORDER BY rowid');
  return rows.map(([task, channel]) => `${String(task)}:${String(channel)}`);
}

/** A saver over a database of its own, with `body` run in its attempt; `commits` counts the database's commits. */
async function inAttempt(
  body: (saver: SqlCheckpointSaver, commits: () => number, rows: () => Promise<string[]>) => Promise<void>,
  options: { serde?: JsonPlusSerializer } = {},
) {
  let commits = 0;
  const sql = sqlAttempt({ map: new Map(), onSync: async () => void commits++ });
  const saver = new SqlCheckpointSaver(sql.db, options);
  await sql.end(async () => {
    // The first call makes the schema: not counted.
    await saver.getTuple(at());
    const before = commits;
    await body(
      saver,
      () => commits - before,
      () => rowsOf(sql.db),
    );
  });
}

/** A checkpoint stored, as the one of a step's start. */
async function stored(saver: SqlCheckpointSaver) {
  const first = emptyCheckpoint();
  await saver.put(at(), first, metadata, {});
  return first;
}

const next = { ...emptyCheckpoint(), id: 'z' };
const step = { ...metadata, step: 1 };

describe("a task's pending writes", () => {
  it("are stored in the transaction of the put that follows in the same macrotask, in the calls' order", async () => {
    await inAttempt(async (saver, commits, rows) => {
      const first = await stored(saver);
      expect(commits()).toBe(1);
      // As LangGraph calls them: the promises are not awaited before the put.
      const writes = [
        saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p'),
        saver.putWrites(at(first.id), [['b', 2]], 'task-2', 'p'),
      ];
      await saver.put(at(first.id), next, step, {});
      await Promise.all(writes);
      // The put's own commit, and no other.
      expect(commits()).toBe(2);
      expect(await rows()).toEqual(['task-1:a', 'task-2:b']);
      await sleep(10);
      expect(commits()).toBe(2);
      // A read sees the checkpoint and the writes of the step it started.
      expect((await saver.getTuple(at(first.id)))?.pendingWrites).toEqual([
        ['task-1', 'a', 1],
        ['task-2', 'b', 2],
      ]);
      expect((await saver.getTuple(at()))?.checkpoint.id).toBe('z');
    });
  });

  it("are stored on their own at the end of the macrotask when no put follows, and a later put's commit is after", async () => {
    await inAttempt(async (saver, commits, rows) => {
      const first = await stored(saver);
      const writes = [
        saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p'),
        saver.putWrites(at(first.id), [['b', 2]], 'task-2', 'p'),
      ];
      expect(commits()).toBe(1);
      // The promises resolve with the commit, which no put waits for: both in one.
      await Promise.all(writes);
      expect(commits()).toBe(2);
      expect(await rows()).toEqual(['task-1:a', 'task-2:b']);
      await saver.put(at(first.id), next, step, {});
      expect(commits()).toBe(3);
    });
  });

  it('are stored when their promise resolves, for a connection over the same store', async () => {
    const map = new Map<string, Uint8Array>();
    const writer = sqlAttempt({ map, key: 'k', id: 'writer' });
    await writer.end(async () => {
      const saver = new SqlCheckpointSaver(writer.db);
      const first = await stored(saver);
      await saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
      const reader = sqlAttempt({ map, key: 'k', id: 'reader', shared: true });
      expect(await reader.end(() => rowsOf(reader.view.db))).toEqual(['task-1:a']);
    });
  });

  it('do not wait for a put to be called, as a delta channel needs: its put comes after they resolve', async () => {
    await inAttempt(async (saver, commits, rows) => {
      const first = await stored(saver);
      await saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
      await saver.put(at(first.id), next, step, {});
      expect(commits()).toBe(3);
      expect(await rows()).toEqual(['task-1:a']);
    });
  });

  it('are stored before a read, which sees them', async () => {
    await inAttempt(async (saver, commits) => {
      const first = await stored(saver);
      const writes = [saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p')];
      expect((await saver.getTuple(at(first.id)))?.pendingWrites).toEqual([['task-1', 'a', 1]]);
      expect(commits()).toBe(2);
      writes.push(saver.putWrites(at(first.id), [['b', 2]], 'task-2', 'p'));
      const listed = [];
      for await (const tuple of saver.list(at())) listed.push(tuple.pendingWrites);
      expect(listed).toEqual([
        [
          ['task-1', 'a', 1],
          ['task-2', 'b', 2],
        ],
      ]);
      await Promise.all(writes);
      await sleep(10);
      expect(commits()).toBe(3);
    });
  });

  it('are stored before a prune', async () => {
    await inAttempt(async (saver, _commits, rows) => {
      const first = await stored(saver);
      const write = saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
      await saver.prune(['t']);
      await write;
      // The latest checkpoint keeps its pending writes.
      expect(await rows()).toEqual(['task-1:a']);
    });
  });

  it('make a put without any the same single commit as before', async () => {
    await inAttempt(async (saver, commits) => {
      await stored(saver);
      expect(commits()).toBe(1);
    });
  });

  it('fail their promise with the error of a store that failed on its own, and nothing after it', async () => {
    await inAttempt(
      async (saver, commits) => {
        const first = await stored(saver);
        await expect(saver.putWrites(at(first.id), [['a', 'bad']], 'task-1', 'p')).rejects.toThrow('cannot store that');
        expect(commits()).toBe(1);
        // Nothing is remembered: the next calls work.
        await saver.putWrites(at(first.id), [['b', 2]], 'task-2', 'p');
        await saver.put(at(first.id), next, step, {});
        expect((await saver.getTuple(at()))?.checkpoint.id).toBe('z');
      },
      { serde: new Refusing() },
    );
  });

  it('fail the put that carries them, and their promises, when one cannot be stored', async () => {
    await inAttempt(
      async (saver, commits) => {
        const first = await stored(saver);
        const writes = [
          saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p'),
          saver.putWrites(at(first.id), [['b', 'bad']], 'task-2', 'p'),
        ];
        const put = saver.put(at(first.id), next, step, {});
        await expect(put).rejects.toThrow('cannot store that');
        for (const write of writes) await expect(write).rejects.toThrow('cannot store that');
        // Nothing of the put was stored; the writes are not kept for a later put; a later call works.
        expect(commits()).toBe(1);
        await saver.put(at(first.id), next, step, {});
        expect((await saver.getTuple(at(first.id)))?.pendingWrites).toEqual([]);
      },
      { serde: new Refusing() },
    );
  });
});

describe("a graph run's writes, with a handler that returns as `invoke` does", () => {
  const State = Annotation.Root({ n: Annotation<number>() });
  const thread = { configurable: { thread_id: 't' } };

  /** `body`'s node, in a graph with the saver over `db`. */
  const graphOf = (db: Database, body: () => unknown) =>
    new StateGraph(State)
      .addNode('work', body as never)
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile({ checkpointer: new SqlCheckpointSaver(db) });

  /** The attempt of a handler: it runs the graph and returns at once; then what the database holds. */
  async function ran(body: () => unknown, durability: 'sync' | 'async' | 'exit', map = new Map<string, Uint8Array>()) {
    const sql = sqlAttempt({ map, key: 'k', id: 'inv' });
    const outcome = await sql.end(async () => {
      try {
        await graphOf(sql.db, body).invoke({ n: 1 }, { ...thread, durability });
        return 'returned';
      } catch (error) {
        return (error as Error).message;
      }
    });
    // The attempt is over: a later attempt over the same state sees what was stored, with no macrotask given between.
    const later = sqlAttempt({ map, key: 'k', id: 'later' });
    const writes = await later.end(() => later.db.values('SELECT channel FROM restate_langgraph_writes'));
    return { outcome, channels: writes.map(([channel]) => String(channel)), map };
  }

  it.each(['sync', 'async', 'exit'] as const)(
    "has an interrupt's write stored when invoke returns, and a new saver sees the interrupt: durability %s",
    async (durability) => {
      const { channels, map } = await ran(() => interrupt('wait'), durability);
      expect(channels).toContain('__interrupt__');
      const sql = sqlAttempt({ map, key: 'k', id: 'again' });
      const state = await sql.end(() => graphOf(sql.db, () => ({})).getState(thread));
      expect(state.tasks.flatMap((task) => task.interrupts.map((i) => i.value))).toEqual(['wait']);
    },
  );

  it.each(['sync', 'async', 'exit'] as const)(
    "has a failed task's error stored when invoke rejects: durability %s",
    async (durability) => {
      const { outcome, channels } = await ran(() => {
        throw new Error('the node failed');
      }, durability);
      expect(outcome).toBe('the node failed');
      expect(channels).toContain('__error__');
    },
  );
});
