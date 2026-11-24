// A write that rides the next commit of a database (`rideCommit`): written in
// that commit's transaction, before its commit, so that it costs no commit of
// its own; `flushRiders` writes what is still pending.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { database, flushRiders, rideCommit } from '@restatedev/sessions/internal';
import { sqlAttempt } from './support.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let syncs = 0;
/** An attempt over a store of its own, with a table `t` and `syncs` counting its commits from then on. */
async function attempt(options: { shared?: boolean } = {}) {
  const map = new Map<string, Uint8Array>();
  const sql = sqlAttempt({ map, onSync: async () => void syncs++, ...options });
  return { map, sql };
}
const rows = (db: { values: (s: string) => Promise<unknown[][]> }) => db.values('SELECT x FROM t ORDER BY x');
const insert = (x: string) => async (tx: { execute: (s: string, p?: never[]) => Promise<void> }) =>
  tx.execute(`INSERT INTO t VALUES ('${x}')`);

beforeEach(() => {
  syncs = 0;
});

describe('a rider', () => {
  it('is written by the next transaction that commits, in it: no commit of its own', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      expect(rideCommit(db, 'a', insert('rode'))).toBe(true);
      // Nothing is written yet, and nothing committed.
      expect(await rows(db)).toEqual([]);
      expect(syncs).toBe(0);
      await db.transaction(async (tx) => tx.execute("INSERT INTO t VALUES ('own')"));
      expect(syncs).toBe(1);
      expect(await rows(db)).toEqual([['own'], ['rode']]);
      // Once: the next transaction does not write it again.
      await db.transaction(async (tx) => tx.execute("INSERT INTO t VALUES ('again')"));
      expect(await rows(db)).toEqual([['again'], ['own'], ['rode']]);
    });
  });

  it('is written by a write outside a transaction, in its commit', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      rideCommit(db, 'a', insert('rode'));
      await db.execute("INSERT INTO t VALUES ('own')");
      expect(syncs).toBe(1);
      expect(await rows(db)).toEqual([['own'], ['rode']]);
    });
  });

  it('is not written by a read, which commits nothing', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      rideCommit(db, 'a', insert('rode'));
      await db.get('SELECT 1');
      await db.values('SELECT x FROM t');
      await db.query('SELECT x FROM t');
      expect(await rows(db)).toEqual([]);
      expect(syncs).toBe(0);
    });
  });

  it('is written by the transaction that was open when it was registered, as that one commits', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      await db.transaction(async (tx) => {
        await tx.execute("INSERT INTO t VALUES ('own')");
        rideCommit(db, 'a', insert('rode'));
        expect(await tx.values('SELECT x FROM t')).toEqual([['own']]);
      });
      expect(syncs).toBe(1);
      expect(await rows(db)).toEqual([['own'], ['rode']]);
    });
  });

  it('stays pending when its transaction rolls back, and is written by the next commit', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      rideCommit(db, 'a', insert('rode'));
      await expect(
        db.transaction(async (tx) => {
          await tx.execute("INSERT INTO t VALUES ('lost')");
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await rows(db)).toEqual([]);
      await db.execute("INSERT INTO t VALUES ('own')");
      expect(await rows(db)).toEqual([['own'], ['rode']]);
    });
  });

  it('stays pending when its own write fails, and the transaction with it', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      rideCommit(db, 'a', async (tx) => tx.execute('INSERT INTO nowhere VALUES (1)'));
      await expect(db.execute("INSERT INTO t VALUES ('own')")).rejects.toThrow(/nowhere/);
      expect(await rows(db)).toEqual([]);
      // Replaced, it rides the next.
      rideCommit(db, 'a', insert('rode'));
      await db.execute("INSERT INTO t VALUES ('own')");
      expect(await rows(db)).toEqual([['own'], ['rode']]);
    });
  });

  it('is one per slot: a later one replaces the earlier, and undefined clears it', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      rideCommit(db, 'a', insert('first'));
      rideCommit(db, 'a', insert('second'));
      rideCommit(db, 'b', insert('other'));
      rideCommit(db, 'c', insert('cleared'));
      rideCommit(db, 'c', undefined);
      await db.execute("INSERT INTO t VALUES ('own')");
      expect(await rows(db)).toEqual([['other'], ['own'], ['second']]);
    });
  });

  it('registered while the commit that writes the earlier one is under way, is for the next commit', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      rideCommit(db, 'a', async (tx) => {
        await tx.execute("INSERT INTO t VALUES ('first')");
        rideCommit(db, 'a', insert('second'));
      });
      await db.execute("INSERT INTO t VALUES ('own')");
      expect(await rows(db)).toEqual([['first'], ['own']]);
      await db.execute("INSERT INTO t VALUES ('next')");
      expect(await rows(db)).toEqual([['first'], ['next'], ['own'], ['second']]);
    });
  });
});

describe('flushRiders', () => {
  it('writes what is pending in a transaction of its own, and nothing if nothing is', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      await flushRiders(db);
      expect(syncs).toBe(0);
      rideCommit(db, 'a', insert('rode'));
      await flushRiders(db);
      expect(syncs).toBe(1);
      expect(await rows(db)).toEqual([['rode']]);
      await flushRiders(db);
      expect(syncs).toBe(1);
    });
  });

  it("does not write a rider of another database, such as the key's other databases", async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      const other = database(db, 'other');
      await other.execute('CREATE TABLE t(x)');
      rideCommit(other, 'a', insert('rode'));
      await db.execute("INSERT INTO t VALUES ('own')");
      expect(await rows(other)).toEqual([]);
      await flushRiders(other);
      expect(await rows(other)).toEqual([['rode']]);
    });
  });
});

describe('a view', () => {
  it('takes no rider: its caller writes at once', async () => {
    const { map } = await attempt();
    const view = sqlAttempt({ map, shared: true });
    await view.end(async () => {
      expect(rideCommit(view.db, 'a', insert('rode'))).toBe(false);
      await flushRiders(view.db);
    });
  });
});

describe('an urgent rider', () => {
  const urgent = { urgent: true };

  it('with no transaction under way is written alone at the end of the macrotask: one commit', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      rideCommit(db, 'a', insert('rode'), urgent);
      expect(syncs).toBe(0);
      await vi.waitFor(async () => expect(await rows(db)).toEqual([['rode']]));
      expect(syncs).toBe(1);
      await flushRiders(db);
      expect(syncs).toBe(1);
    });
  });

  it('is written by the transaction under way, and not again', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      rideCommit(db, 'a', insert('rode'), urgent);
      // Started in the same macrotask: under way when the timer fires, and held open past it.
      await db.transaction(async (tx) => {
        await tick();
        await tick();
        await tx.execute("INSERT INTO t VALUES ('own')");
      });
      expect(syncs).toBe(1);
      await tick();
      await tick();
      expect(await rows(db)).toEqual([['own'], ['rode']]);
      expect(syncs).toBe(1);
    });
  });

  it('is written by a transaction held open when it was registered, as that one commits', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      await db.transaction(async () => {
        rideCommit(db, 'a', insert('rode'), urgent);
        await tick();
        await tick();
        // Not written alone while the transaction is open.
        expect(syncs).toBe(0);
      });
      expect(syncs).toBe(1);
      expect(await rows(db)).toEqual([['rode']]);
    });
  });

  it('left by a transaction that rolls back is written alone after it', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      rideCommit(db, 'a', insert('rode'), urgent);
      await expect(
        db.transaction(async () => {
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      await vi.waitFor(async () => expect(await rows(db)).toEqual([['rode']]));
    });
  });

  it('registered after the transaction ran its riders is written alone after it', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      rideCommit(db, 'a', async (tx) => {
        await tx.execute("INSERT INTO t VALUES ('first')");
        rideCommit(db, 'b', insert('later'), urgent);
      });
      await db.execute("INSERT INTO t VALUES ('own')");
      await vi.waitFor(async () => expect(await rows(db)).toEqual([['first'], ['later'], ['own']]));
    });
  });

  it('whose own write fails stays pending, raises nothing, and is not tried again by itself', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      let tried = 0;
      rideCommit(
        db,
        'a',
        async (tx) => {
          tried++;
          await tx.execute('INSERT INTO nowhere VALUES (1)');
        },
        urgent,
      );
      await tick();
      await tick();
      await tick();
      expect(tried).toBe(1);
      // Replaced, it is written by the next commit.
      rideCommit(db, 'a', insert('rode'));
      await db.execute("INSERT INTO t VALUES ('own')");
      expect(await rows(db)).toEqual([['own'], ['rode']]);
    });
  });

  it('is not written once the attempt ended', async () => {
    const { sql, map } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      rideCommit(db, 'a', insert('rode'), urgent);
    });
    const ended = syncs;
    await tick();
    await tick();
    expect(syncs).toBe(ended);
    const read = sqlAttempt({ map, shared: true });
    expect(await read.end(() => rows(read.db))).toEqual([]);
  });

  it('keeps its urgency when a rider of the same slot that is not urgent replaces it', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      rideCommit(db, 'a', insert('first'), urgent);
      rideCommit(db, 'a', insert('second'));
      await vi.waitFor(async () => expect(await rows(db)).toEqual([['second']]));
    });
  });

  it('is the only kind a timer writes: a rider that is not urgent waits for a commit', async () => {
    const { sql } = await attempt();
    await sql.end(async () => {
      const { db } = sql;
      await db.execute('CREATE TABLE t(x)');
      syncs = 0;
      rideCommit(db, 'a', insert('rode'));
      await tick();
      await tick();
      await tick();
      expect(syncs).toBe(0);
      expect(await rows(db)).toEqual([]);
    });
  });

  // One that comes while the timer's own commit is syncing: its timer fires with that transaction under way, so
  // the commit's end is what must set it again (agents answer in one slot, each answer replacing the last).
  it.each([
    ['of another slot', 'b'],
    ['of the same slot, replacing the one being written', 'a'],
  ])(
    'registered while the commit that writes the one before it syncs, %s, is written after it',
    async (_name, slot) => {
      const map = new Map<string, Uint8Array>();
      let during: (() => void) | undefined;
      syncs = 0;
      const sql = sqlAttempt({
        map,
        onSync: async () => {
          syncs++;
          const run = during;
          during = undefined;
          run?.();
        },
      });
      await sql.end(async () => {
        const { db } = sql;
        await db.execute('CREATE TABLE t(x)');
        syncs = 0;
        during = () => rideCommit(db, slot, insert('second'), { urgent: true });
        rideCommit(db, 'a', insert('first'), { urgent: true });
        await vi.waitFor(async () => expect(await rows(db)).toEqual([['first'], ['second']]));
        // One commit each, and nothing armed after: no more commits by themselves.
        expect(syncs).toBe(2);
        await tick();
        await tick();
        await tick();
        expect(syncs).toBe(2);
      });
    },
  );
});
