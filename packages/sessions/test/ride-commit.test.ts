// A write that rides the next commit of a database (`rideCommit`): written in
// that commit's transaction, before its commit, so that it costs no commit of
// its own; `flushRiders` writes what is still pending.
import { beforeEach, describe, expect, it } from 'vitest';
import { database, flushRiders, rideCommit } from '@restatedev/sessions/internal';
import { sqlAttempt } from './support.ts';

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
