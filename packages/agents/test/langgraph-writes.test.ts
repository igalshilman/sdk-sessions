// A task's pending writes in `SqlCheckpointSaver`: stored with the checkpoint that follows them in the same
// macrotask, in one commit, else on their own at the end of it. Commits are counted at the database's sync.
import { emptyCheckpoint, JsonPlusSerializer } from '@langchain/langgraph-checkpoint';
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
async function rowsOf(db: Database) {
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

describe("a task's pending writes", () => {
  it("are stored in the transaction of the put that follows in the same macrotask, in the calls' order", async () => {
    await inAttempt(async (saver, commits, rows) => {
      const first = await stored(saver);
      expect(commits()).toBe(1);
      await saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
      await saver.putWrites(at(first.id), [['b', 2]], 'task-2', 'p');
      expect(commits()).toBe(1);
      const second = { ...emptyCheckpoint(), id: 'z' };
      await saver.put(at(first.id), second, { ...metadata, step: 1 }, {});
      // The put's own commit, and no other.
      expect(commits()).toBe(2);
      expect(await rows()).toEqual(['task-1:a', 'task-2:b']);
      // Stored with the put's: nothing is written when the macrotask ends.
      await sleep(10);
      expect(commits()).toBe(2);
      // A read sees the checkpoint and the writes of the step it started.
      const tuple = await saver.getTuple(at(first.id));
      expect(tuple?.pendingWrites).toEqual([
        ['task-1', 'a', 1],
        ['task-2', 'b', 2],
      ]);
      expect((await saver.getTuple(at()))?.checkpoint.id).toBe('z');
    });
  });

  it("are stored on their own at the end of the macrotask when no put follows, and a later put's commit is after", async () => {
    await inAttempt(async (saver, commits, rows) => {
      const first = await stored(saver);
      await saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
      await saver.putWrites(at(first.id), [['b', 2]], 'task-2', 'p');
      // The promise is resolved at once, and nothing is stored yet.
      expect(commits()).toBe(1);
      await sleep(10);
      // Both, in one commit.
      expect(commits()).toBe(2);
      expect(await rows()).toEqual(['task-1:a', 'task-2:b']);
      await saver.put(at(first.id), { ...emptyCheckpoint(), id: 'z' }, { ...metadata, step: 1 }, {});
      expect(commits()).toBe(3);
    });
  });

  it('are stored before a read, which sees them', async () => {
    await inAttempt(async (saver, commits) => {
      const first = await stored(saver);
      await saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
      expect((await saver.getTuple(at(first.id)))?.pendingWrites).toEqual([['task-1', 'a', 1]]);
      expect(commits()).toBe(2);
      await saver.putWrites(at(first.id), [['b', 2]], 'task-2', 'p');
      const listed = [];
      for await (const tuple of saver.list(at())) listed.push(tuple.pendingWrites);
      expect(listed).toEqual([
        [
          ['task-1', 'a', 1],
          ['task-2', 'b', 2],
        ],
      ]);
      await sleep(10);
      expect(commits()).toBe(3);
    });
  });

  it('are stored before a prune', async () => {
    await inAttempt(async (saver, _commits, rows) => {
      const first = await stored(saver);
      await saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
      await saver.prune(['t']);
      // The latest checkpoint keeps its pending writes.
      expect(await rows()).toEqual(['task-1:a']);
    });
  });

  it('are stored by flush, which leaves nothing for the end of the macrotask', async () => {
    await inAttempt(async (saver, commits) => {
      const first = await stored(saver);
      await saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
      await saver.flush();
      expect(commits()).toBe(2);
      await saver.flush();
      await sleep(10);
      expect(commits()).toBe(2);
    });
  });

  it('make a put without any the same single commit as before', async () => {
    await inAttempt(async (saver, commits) => {
      await stored(saver);
      expect(commits()).toBe(1);
    });
  });

  it('fail the next put with the error of a write that failed on its own, and are not an unhandled rejection', async () => {
    await inAttempt(
      async (saver, commits) => {
        const first = await stored(saver);
        // The promise resolves at once, as LangGraph does not wait for a write.
        await saver.putWrites(at(first.id), [['a', 'bad']], 'task-1', 'p');
        await sleep(10);
        expect(commits()).toBe(1);
        await expect(
          saver.put(at(first.id), { ...emptyCheckpoint(), id: 'z' }, { ...metadata, step: 1 }, {}),
        ).rejects.toThrow('cannot store that');
        // Any later call fails with it too: the attempt is over.
        await expect(saver.getTuple(at())).rejects.toThrow('cannot store that');
        await expect(saver.flush()).rejects.toThrow('cannot store that');
      },
      { serde: new Refusing() },
    );
  });

  it('fail the put that carries them when one cannot be stored, and the saver after it', async () => {
    await inAttempt(
      async (saver, commits) => {
        const first = await stored(saver);
        await saver.putWrites(at(first.id), [['a', 1]], 'task-1', 'p');
        await saver.putWrites(at(first.id), [['b', 'bad']], 'task-2', 'p');
        await expect(
          saver.put(at(first.id), { ...emptyCheckpoint(), id: 'z' }, { ...metadata, step: 1 }, {}),
        ).rejects.toThrow('cannot store that');
        // Nothing of the put was stored, and the writes are not kept for a later put: the attempt fails.
        expect(commits()).toBe(1);
        await expect(saver.getTuple(at())).rejects.toThrow('cannot store that');
      },
      { serde: new Refusing() },
    );
  });
});
