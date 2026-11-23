// pi's commits in batches (`commits: 'effects'`, src/pi/storage.ts): the adapter
// over a session of its own, and pi's chat in both modes, without a Restate
// server. A commit is one `ctx.run` of the attempt (`onSync`).
import * as restate from '@restatedev/sessions';
import { chatHandler, tool } from '@restatedev/agents';
import { z } from 'zod';
import { defineTool } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import * as pi from '@restatedev/agents/pi';
import { SqlKvDatabase, type Commits } from '@restatedev/agents/pi/storage';
import type { SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { platform } from '../../sessions/src/platform.ts';
import { callTools, fakeProvider, say, textOf, unavailable } from './fakes/pi.ts';
import { handlerOf, sqlAttempt, withoutIds } from './support.ts';

/** What the model does next: by the last message, as the test sets it. */
const script = vi.hoisted(() => ({ respond: undefined as undefined | ((last: string, role: string) => unknown) }));

vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  builtinProviders: () => [
    fakeProvider('openai', 'gpt-6-sol', ({ messages }) => {
      const last = messages.at(-1)!;
      return (script.respond?.(textOf(last.content), last.role) ?? say('ok')) as ReturnType<typeof say>;
    }),
  ],
}));

const never = (ms: number) => new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), ms));

/** The adapter over a fresh session: `commits` counts the session's real commits. */
function adapter(options: { commits?: Commits; failed?: (error: unknown) => void } = { commits: 'effects' }) {
  const map = new Map<string, Uint8Array>();
  const counted = { commits: 0 };
  const sql = sqlAttempt({
    map,
    onSync: async () => {
      counted.commits++;
    },
  });
  const database = new SqlKvDatabase(sql.db, options);
  const run = <T>(body: (d: SqlKvDatabase) => Promise<T>) => sql.end(() => body(database));
  return { sql, database, counted, run };
}

describe("the adapter's batch", () => {
  it('writes the commits gap two flushes as one, and tells each afterCommit once it is written', async () => {
    const { database, counted, run } = adapter();
    const told: number[] = [];
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER)');
      await database.run('INSERT INTO t VALUES (?)', 0);
      counted.commits = 0;
      database.armed = true;
      for (const n of [1, 2, 3]) {
        database.afterCommit = async () => void told.push(counted.commits * 100 + n);
        await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (?)', n));
      }
      // Nothing is written, and none is told.
      expect(counted.commits).toBe(0);
      expect(told).toEqual([]);
      expect(await database.all('SELECT n FROM t ORDER BY n')).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }]);
      await database.flush();
      expect(counted.commits).toBe(1);
      // In order, after the commit.
      expect(told).toEqual([101, 102, 103]);
      // Nothing open: nothing to write.
      await database.flush();
      expect(counted.commits).toBe(1);
    });
  });

  it('undoes only a pi commit that throws, which rejects with its error', async () => {
    const { database, counted, run } = adapter();
    const told: string[] = [];
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER PRIMARY KEY)');
      database.armed = true;
      database.afterCommit = async () => void told.push('after');
      await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (1)'));
      await expect(
        database.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (2)');
          await tx.run('INSERT INTO t VALUES (2)'); // a duplicate
        }),
      ).rejects.toThrow(/UNIQUE/);
      await expect(
        database.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (4)');
          throw new Error('pi changed its mind');
        }),
      ).rejects.toThrow('pi changed its mind');
      await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (3)'));
      await database.flush();
      expect(await database.all('SELECT n FROM t ORDER BY n')).toEqual([{ n: 1 }, { n: 3 }]);
      // The two that succeeded are told, the others not; one commit.
      expect(told).toEqual(['after', 'after']);
      expect(counted.commits).toBe(2); // the table, and the batch
    });
  });

  it('reads what the batch wrote, and a read with none open opens nothing', async () => {
    const { database, counted, run } = adapter();
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER)');
      const before = counted.commits;
      database.armed = true;
      expect(await database.all('SELECT n FROM t')).toEqual([]);
      expect(await database.get('SELECT count(*) AS c FROM t')).toEqual({ c: 0 });
      await database.flush();
      expect(counted.commits).toBe(before);
      await database.run('INSERT INTO t VALUES (7)');
      expect(await database.get('SELECT n FROM t')).toEqual({ n: 7 });
      expect(counted.commits).toBe(before);
      await database.flush();
      expect(counted.commits).toBe(before + 1);
    });
  });

  it('is ended by a call to ctx.db that queues behind it: one commit, and the call sees it', async () => {
    const { sql, database, counted, run } = adapter();
    const told: string[] = [];
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER)');
      database.armed = true;
      database.afterCommit = async () => void told.push('after');
      await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (1)'));
      const before = counted.commits;
      const seen = await Promise.race([sql.db.values('SELECT n FROM t'), never(3000)]);
      expect(seen).toEqual([[1]]);
      expect(counted.commits).toBe(before + 1);
      // Its afterCommit comes after the commit, whoever ended the batch.
      await database.flush();
      expect(told).toEqual(['after']);
      // The next pi commit opens another batch, behind the call.
      await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (2)'));
      await database.flush();
      expect(await sql.db.values('SELECT n FROM t ORDER BY n')).toEqual([[1], [2]]);
    });
  });

  it('refuses a call to ctx.db from a pi commit at once, as a transaction of the session does, and does not hang', async () => {
    const { sql, database, run } = adapter();
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER)');
      database.armed = true;
      // The first pi commit of the batch, and a later one: both run in the context of the batch's transaction.
      for (let i = 0; i < 2; i++) {
        const refused = database.transaction(async () => {
          await sql.db.values('SELECT n FROM t');
        });
        expect(
          await Promise.race([
            refused.then(
              () => 'ran',
              (e: unknown) => e,
            ),
            never(3000),
          ]),
        ).toMatchObject({
          message: expect.stringMatching(/use the transaction handle/) as unknown,
        });
      }
      // From the adapter itself, which would wait for its own chain, and from its flush.
      const again = database.transaction(async () => {
        await database.get('SELECT 1');
      });
      expect(
        await Promise.race([
          again.then(
            () => 'ran',
            (e: unknown) => e,
          ),
          never(3000),
        ]),
      ).toBeInstanceOf(Error);
      const flushing = database.transaction(async () => {
        await database.flush();
      });
      expect(
        await Promise.race([
          flushing.then(
            () => 'ran',
            (e: unknown) => e,
          ),
          never(3000),
        ]),
      ).toBeInstanceOf(Error);
      // And the adapter and the session still work.
      await database.run('INSERT INTO t VALUES (1)');
      await database.flush();
      expect(await sql.db.values('SELECT n FROM t')).toEqual([[1]]);
    });
  });

  it('writes at once while an effect is in flight, and batches again when it ends, however often it is ended', async () => {
    const { database, counted, run } = adapter();
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER)');
      database.armed = true;
      const insert = (n: number) => database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (?)', n));
      const base = counted.commits;
      const one = database.effectStarted();
      const two = database.effectStarted();
      await insert(1);
      await insert(2);
      expect(counted.commits).toBe(base + 2);
      one();
      one();
      await insert(3);
      expect(counted.commits).toBe(base + 3);
      two();
      await insert(4);
      await insert(5);
      expect(counted.commits).toBe(base + 3);
      await database.flush();
      expect(counted.commits).toBe(base + 4);
      // An effect that never ends leaves it as it was without batching.
      database.effectStarted();
      await insert(6);
      await insert(7);
      expect(counted.commits).toBe(base + 6);
      expect((await database.all('SELECT n FROM t')).length).toBe(7);
    });
  });

  it("is today's, a commit each, with `commits: 'each'`, armed or not", async () => {
    const { database, counted, run } = adapter({ commits: 'each' });
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER)');
      database.armed = true;
      const base = counted.commits;
      const end = database.effectStarted();
      await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (1)'));
      await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (2)'));
      end();
      expect(counted.commits).toBe(base + 2);
      await database.flush();
      expect(counted.commits).toBe(base + 2);
    });
  });

  it('fails the attempt when the real commit fails, and every later call', async () => {
    const failures: unknown[] = [];
    const told: string[] = [];
    const { sql, database, run } = adapter({ commits: 'effects', failed: (e) => failures.push(e) });
    await run(async () => {
      await sql.db.execute('PRAGMA foreign_keys=ON');
      await database.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
      await database.exec('CREATE TABLE c (pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
      database.armed = true;
      database.afterCommit = async () => void told.push('after');
      // pi is told the commit is done: the constraint is checked when the batch commits.
      await database.transaction(async (tx) => tx.run('INSERT INTO c VALUES (7)'));
      await expect(database.flush()).rejects.toThrow(/FOREIGN KEY/);
      expect(failures).toHaveLength(1);
      expect(String(failures[0])).toMatch(/FOREIGN KEY/);
      // Never told, and every call after rejects with the same error, none swallowed or retried.
      expect(told).toEqual([]);
      for (const call of [
        () => database.transaction(async (tx) => tx.run('INSERT INTO p VALUES (1)')),
        () => database.get('SELECT 1'),
        () => database.run('INSERT INTO p VALUES (1)'),
        () => database.flush(),
      ]) {
        await expect(call()).rejects.toThrow(/FOREIGN KEY/);
      }
      // Closing does not fail the end of an attempt that failed: the error is the attempt's.
      await database.close();
      expect(failures).toHaveLength(1);
      // Nothing of the batch is stored, and the session is as it was.
      expect(await sql.db.values('SELECT count(*) FROM c')).toEqual([[0]]);
    });
  });

  it('writes what it holds when it is closed', async () => {
    const { database, counted, run } = adapter();
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER)');
      database.armed = true;
      const base = counted.commits;
      await database.run('INSERT INTO t VALUES (1)');
      await database.close();
      expect(counted.commits).toBe(base + 1);
    });
  });

  it("is written by the handler's end if nothing else wrote it, and leaves nothing open", async () => {
    const map = new Map<string, Uint8Array>();
    const count = async () => {
      const read = sqlAttempt({ map, key: 'k', id: `read${Math.random()}`, shared: true });
      return read.end(async () => (await read.ctx.db.values('SELECT count(*) FROM t'))[0]![0]);
    };
    const attempt = async (flush: boolean) => {
      const sql = sqlAttempt({ map, key: 'k', id: 'inv' });
      const database = new SqlKvDatabase(sql.db, { commits: 'effects' });
      await sql.end(async () => {
        await database.exec('CREATE TABLE IF NOT EXISTS t (n INTEGER)');
        database.armed = true;
        await database.run('INSERT INTO t VALUES (1)');
        // The handler ends with the batch open, or after the flush a prompt's end makes: the end's own call to
        // the session queues behind the batch, which ends it, so the session saves and nothing is left open.
        if (flush) await database.flush();
      });
    };
    await attempt(false);
    expect(await count()).toBe(1);
    await attempt(true);
    expect(await count()).toBe(2);
  });
});

/**
 * The adapter over a session on `map` that records its sends, whose `onCommit` sends and then, for the commit
 * numbered `failing`, throws. `commits` is how many pi commits it runs: each inserts its own row.
 */
async function sending(map: Map<string, Uint8Array>, commits: Commits, failing: number | undefined, count = 3) {
  const sent: number[] = [];
  const failures: unknown[] = [];
  const sql = sqlAttempt({
    map,
    send: (s) => sent.push(JSON.parse(new TextDecoder().decode(s.parameter)) as number),
  });
  const database = new SqlKvDatabase(sql.db, { commits, failed: (e) => failures.push(e) });
  let calls = 0;
  database.onCommit = async (tx) => {
    const n = ++calls;
    tx.send({ service: 'svc', key: 'k', handler: 'taken', input: n });
    if (n === failing) throw new Error('the copy failed after its send');
  };
  const outcomes: string[] = [];
  await sql.end(async () => {
    await database.exec('CREATE TABLE IF NOT EXISTS t (n INTEGER)');
    database.armed = true;
    for (let i = 1; i <= count; i++) {
      outcomes.push(
        await database
          .transaction(async (tx) => tx.run('INSERT INTO t VALUES (?)', i))
          .then(
            () => 'done',
            (e: unknown) => String(e).replace(/^Error: /, ''),
          ),
      );
    }
    await database.flush().catch((e: unknown) => outcomes.push(`flush: ${String(e).replace(/^Error: /, '')}`));
  });
  const read = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
  const rows = await read.end(async () => (await read.ctx.db.values('SELECT n FROM t ORDER BY n')).map((r) => r[0]));
  return { sent, rows, failures: failures.length, outcomes };
}

describe('the sends of a pi commit in a batch', () => {
  it('are made for every commit that stays', async () => {
    for (const commits of ['each', 'effects'] as const) {
      const { sent, rows, failures } = await sending(new Map(), commits, undefined);
      expect({ sent, rows, failures }).toEqual({ sent: [1, 2, 3], rows: [1, 2, 3], failures: 0 });
    }
  });

  it('are not made for a commit that failed, with a commit each: only that commit is undone', async () => {
    const { sent, rows } = await sending(new Map(), 'each', 2);
    expect({ sent, rows }).toEqual({ sent: [1, 3], rows: [1, 3] });
  });

  it('are never made if their commit failed after sending: the batch is dropped, the attempt told, and a retry completes', async () => {
    const map = new Map<string, Uint8Array>();
    // The second commit of the batch sends and then fails: its savepoint cannot take the send back, so the
    // whole transaction is rolled back, the first commit with it, and nothing after it is accepted.
    const failed = await sending(map, 'effects', 2);
    expect(failed.sent).toEqual([]);
    expect(failed.rows).toEqual([]);
    expect(failed.failures).toBe(1);
    expect(failed.outcomes[0]).toBe('done');
    expect(failed.outcomes[1]).toMatch(/failed after its send/);
    expect(failed.outcomes.slice(2).join()).toMatch(/failed after its send/);
    // The retry (a new attempt over the same state) goes through from what was stored.
    const retried = await sending(map, 'effects', undefined);
    expect(retried).toMatchObject({ sent: [1, 2, 3], rows: [1, 2, 3], failures: 0 });
  });

  it('do not fail the attempt if nothing was told as done: the first commit of a batch that sent and failed', async () => {
    const { sent, rows, failures, outcomes } = await sending(new Map(), 'effects', 1);
    // That commit failed alone, with its batch, which held nothing else; the next ones open another.
    expect(outcomes[0]).toMatch(/failed after its send/);
    expect({ sent, rows, failures }).toEqual({ sent: [2, 3], rows: [2, 3], failures: 0 });
  });

  it('leave a commit that failed without sending undoing only itself', async () => {
    const map = new Map<string, Uint8Array>();
    const sent: number[] = [];
    const sql = sqlAttempt({
      map,
      send: (s) => sent.push(JSON.parse(new TextDecoder().decode(s.parameter)) as number),
    });
    const database = new SqlKvDatabase(sql.db, { commits: 'effects' });
    let n = 0;
    database.onCommit = async (tx) => {
      // The failing commit throws before it sends.
      if (++n === 2) throw new Error('the copy failed before a send');
      tx.send({ service: 'svc', key: 'k', handler: 'taken', input: n });
    };
    await sql.end(async () => {
      await database.exec('CREATE TABLE t (n INTEGER)');
      database.armed = true;
      for (const i of [1, 2, 3])
        await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (?)', i)).catch(() => {});
      await database.flush();
      expect(await database.all('SELECT n FROM t ORDER BY n')).toEqual([{ n: 1 }, { n: 3 }]);
    });
    expect(sent).toEqual([1, 3]);
  });
});

describe("the adapter's batch, when it cannot be opened", () => {
  it('rejects the call that asked, as without batching, and the next one opens it: nothing latches', async () => {
    for (const commits of ['each', 'effects'] as const) {
      const failures: unknown[] = [];
      const sql = sqlAttempt({ map: new Map() });
      // The session's `asked` fails a call of the handler once, with a cancellation it was owed.
      let owed = false;
      const db: typeof sql.db = {
        ...sql.db,
        transaction: (body) =>
          owed && !(owed = false) ? Promise.reject(new restate.CancelledError()) : sql.db.transaction(body),
      };
      const database = new SqlKvDatabase(db, { commits, failed: (e) => failures.push(e) });
      await sql.end(async () => {
        await database.exec('CREATE TABLE t (n INTEGER)');
        database.armed = true;
        owed = true;
        await expect(database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (1)'))).rejects.toBeInstanceOf(
          restate.CancelledError,
        );
        await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (2)'));
        await database.flush();
        expect(await database.all('SELECT n FROM t')).toEqual([{ n: 2 }]);
        expect(failures).toEqual([]);
      });
    }
  });
});

describe("the adapter's batch, as the attempt ends", () => {
  it('is never written once the attempt has ended, and its flush fails rather than hangs', async () => {
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    const failures: unknown[] = [];
    const sql = sqlAttempt({ map, fence, key: 'k', id: 'inv' });
    const database = new SqlKvDatabase(sql.db, { commits: 'effects', failed: (e) => failures.push(e) });
    const outcome = await sql
      .end(async () => {
        await database.exec('CREATE TABLE t (n INTEGER)');
        database.armed = true;
        await database.run('INSERT INTO t VALUES (1)');
        // Restate ends the attempt (a suspension, a lost connection): the SDK's context writes no more.
        fence.closed = true;
        sql.abort();
        return Promise.race([
          database.flush().then(
            () => 'flushed',
            () => 'failed',
          ),
          never(3000),
        ]);
      })
      .catch(() => 'ended');
    expect(['failed', 'ended']).toContain(outcome);
    const read = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
    expect(await read.end(async () => (await read.ctx.db.values('SELECT count(*) FROM t'))[0]![0])).toBe(0);
  });
});

/** A turn of `steps` model requests, a tool call each but the last: `t` writes to ctx.db as it runs. */
function steps(count: number, parallel = 1) {
  let asked = 0;
  script.respond = (_last, role) => {
    if (role !== 'toolResult' && role !== 'user') return say('ok');
    return ++asked < count
      ? callTools(
          Array.from({ length: parallel }, (_, i) => [`t${i + 1}`, { n: asked }] as [string, { n: number }]),
          'On it.',
        )
      : say('Done');
  };
}

/** A tool `name` that writes a row, reads the rows, and says how the durable state looked as it started. */
function tools(
  names: string[],
  seen: { durable: number[]; own: number[] },
  durable: () => Promise<number>,
  ctxOf: () => restate.SessionContext,
) {
  return names.map((name) =>
    tool({
      name,
      description: `tool ${name}`,
      input: z.object({ n: z.number().optional() }),
      run: async (input) => {
        // Before the tool does anything: what pi committed so far is stored.
        seen.durable.push(await durable());
        const ctx = ctxOf();
        await ctx.db.execute('CREATE TABLE IF NOT EXISTS mine (name TEXT, n INTEGER)');
        await ctx.db.execute('INSERT INTO mine VALUES (?, ?)', [name, input.n ?? 0]);
        const rows = await ctx.db.values('SELECT count(*) FROM mine');
        seen.own.push(Number(rows[0]![0]));
        return `${name} done`;
      },
    }),
  );
}

describe.each<Commits>(['each', 'effects'])('pi chat, commits: %s', (commits) => {
  /** A turn in `commits` mode over a database of its own, with tools that use ctx.db. */
  async function turn(steps_: number, names: string[]) {
    const map = new Map<string, Uint8Array>();
    let commitsMade = 0;
    const seen = { durable: [] as number[], own: [] as number[] };
    steps(steps_, names.length);
    let ctx: restate.SessionContext | undefined;
    const sql = sqlAttempt({
      map,
      key: 'batch',
      id: 'inv1',
      onSync: async () => void commitsMade++,
    });
    // What is stored, as a reader of the database sees it: pi's entries.
    const durable = async () => {
      const read = sqlAttempt({ map, key: 'batch', id: `read${Math.random()}`, shared: true });
      return read.end(async () => {
        try {
          return Number((await read.ctx.db.values('SELECT count(*) FROM restate_pi_entries'))[0]![0]);
        } catch {
          return 0;
        }
      });
    };
    const chat = pi.chat((c) => {
      ctx = c;
      return { tools: tools(names, seen, durable, () => ctx!), commits };
    });
    const answer = await sql.end(() => handlerOf(chat)(sql.ctx, 'go'));
    // What the tools wrote, and what pi stored in the end.
    const after = sqlAttempt({ map, key: 'batch', id: 'after', shared: true });
    const rows = await after.end(() => after.ctx.db.values('SELECT name, n FROM mine ORDER BY rowid'));
    return { answer, rows, seen, commitsMade, entries: await durable() };
  }

  it('answers a turn whose tools use ctx.db, which sees their writes', async () => {
    const { answer, rows, seen } = await turn(3, ['t1']);
    expect(answer).toBe('Done');
    expect(rows).toEqual([
      ['t1', 1],
      ['t1', 2],
    ]);
    expect(seen.own).toEqual([1, 2]);
  });

  it('stores before each tool starts every commit of pi that was done before it', async () => {
    const { seen, entries } = await turn(4, ['t1']);
    // Each tool started with more entries stored than the one before: the request's reply, and its call.
    expect(seen.durable).toHaveLength(3);
    for (let i = 1; i < seen.durable.length; i++) expect(seen.durable[i]!).toBeGreaterThan(seen.durable[i - 1]!);
    expect(seen.durable[0]!).toBeGreaterThanOrEqual(2); // the prompt and the reply, at least
    expect(entries).toBeGreaterThan(seen.durable.at(-1)!);
  });

  it('runs tools in parallel, each with the state stored before it, and answers', async () => {
    const { answer, rows } = await turn(3, ['t1', 't2', 't3']);
    expect(answer).toBe('Done');
    expect(rows.map(([name]) => String(name)).toSorted((a, b) => a.localeCompare(b))).toEqual([
      't1',
      't1',
      't2',
      't2',
      't3',
      't3',
    ]);
  });

  it('is the same turn, in what it stores, whichever way it commits', async () => {
    const mine = await turn(4, ['t1']);
    expect(mine.answer).toBe('Done');
    expect(mine.rows).toHaveLength(3);
  });

  it('writes what work does gap prompts through ctx.db, and what it stored by the next prompt', async () => {
    steps(1);
    const map = new Map<string, Uint8Array>();
    const sql = sqlAttempt({ map, key: 'work', id: 'inv1' });
    const handler = chatHandler((ctx) =>
      pi.withPi(ctx, { commits }, async (session) => {
        const first = await session.prompt('one');
        await ctx.db.execute('CREATE TABLE IF NOT EXISTS gap (n INTEGER)');
        await ctx.db.execute('INSERT INTO gap VALUES (1)');
        const second = await session.prompt('two');
        await ctx.db.execute('INSERT INTO gap VALUES (2)');
        const rows = await ctx.db.values('SELECT n FROM gap ORDER BY n');
        return `${first}|${second}|${rows.map((r) => r[0]).join(',')}`;
      }),
    );
    expect(await sql.end(() => handlerOf(handler)(sql.ctx, 'start'))).toBe('Done|Done|1,2');
  });

  it('fails the attempt, whatever it was doing, when a commit of the state cannot be written', async () => {
    steps(3);
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    // The second model request closes the fence: the state is no longer writable from then on.
    let requests = 0;
    const base = script.respond!;
    script.respond = (last, role) => {
      if (++requests === 2) fence.closed = true;
      return base(last, role);
    };
    const sql = sqlAttempt({ map, fence, key: 'fenced', id: 'inv1' });
    const chat = pi.chat({
      tools: [tool({ name: 't1', description: 'd', input: z.object({}), run: () => 'ok' })],
      commits,
    });
    const failed = await sql
      .end(() => handlerOf(chat)(sql.ctx, 'go'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(Error);
    // Whatever the session says of a write it could not store.
    expect(String(failed)).toMatch(/fenced|Session failed/);
  });
});

describe('pi chat, commits: effects, cancelled or ended with a batch open', () => {
  it('leaves nothing open when the turn is cancelled while a tool runs', async () => {
    const { cancelledWhileWorking } = await import('./support.ts');
    script.respond = (last, role) =>
      role !== 'toolResult' && /move/.test(last)
        ? callTools([['transfer', { from: 1, to: 2, amount: 5 }]])
        : say('Hello');
    const { failed, answer } = await cancelledWhileWorking(
      (t) => pi.chat({ tools: t, commits: 'effects' }),
      pi.messages(),
    );
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(answer).toBeTypeOf('string');
  });

  it('leaves nothing open when the attempt ends while a tool runs, and the next attempt goes on', async () => {
    const { endedWhileWorking } = await import('./support.ts');
    script.respond = (_last, role) =>
      role === 'toolResult'
        ? say('moved 5 from account 1 to account 2')
        : callTools([['transfer', { from: 1, to: 2, amount: 5 }]]);
    const { failed, closed, answer } = await endedWhileWorking((t) => pi.chat({ tools: t, commits: 'effects' }));
    expect(String(failed)).toMatch(/attempt|ended/i);
    expect(closed).toEqual([]);
    expect(answer).toBe('moved 5 from account 1 to account 2');
  });
});

/**
 * A tool that cancels the invocation (or ends its attempt) and returns at once: its effect is over, so the
 * commit of its result is batched and open when the cancellation or the end lands. The first invocation's
 * failure, the second's answer, and the conversation's parts.
 */
async function landed(commits: Commits, how: 'cancel' | 'end') {
  script.respond = (last, role) =>
    role !== 'toolResult' && /move/.test(last)
      ? callTools([['transfer', { from: 1, to: 2, amount: 5 }]])
      : say('Hello');
  const map = new Map<string, Uint8Array>();
  const fence = { closed: false };
  const attempts: ReturnType<typeof sqlAttempt>[] = [];
  const transfer = tool({
    name: 'transfer',
    description: 'Move money.',
    input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
    run: () => {
      if (fence.closed) return 'moved 5 from account 1 to account 2';
      if (how === 'cancel') attempts[0]!.cancel();
      else {
        fence.closed = true;
        attempts[0]!.abort();
      }
      return 'moved 5 from account 1 to account 2';
    },
  });
  const handler = handlerOf(pi.chat({ tools: [transfer], commits }));
  const first = sqlAttempt({ map, fence, key: 'landed', id: 'inv1' });
  attempts.push(first);
  const failed = await first
    .end(() => handler(first.ctx, 'Please move 5 from 1 to 2'))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  fence.closed = false;
  const second = sqlAttempt({ map, key: 'landed', id: how === 'cancel' ? 'inv2' : 'inv1' });
  const answer = await second.end(() => handler(second.ctx, how === 'cancel' ? 'Hello' : 'Please move 5 from 1 to 2'));
  const read = sqlAttempt({ map, key: 'landed', id: 'read', shared: true });
  const page = await read.end(() => pi.messages()(read.view, {}));
  return { failed, answer, parts: withoutIds(page.messages.map((m) => m.parts)) };
}

describe('pi chat, cancelled or ended with commits batched and open', () => {
  it.each(['cancel', 'end'] as const)('goes as with a commit each: %s', async (how) => {
    const each = await landed('each', how);
    const effects = await landed('effects', how);
    // The same failure: a cancellation, or the attempt's end, as it is with a commit each.
    expect(effects.failed).toBeInstanceOf(
      each.failed instanceof restate.CancelledError ? restate.CancelledError : Error,
    );
    expect(String(effects.failed)).toBe(String(each.failed));
    expect(effects.answer).toEqual(each.answer);
    expect(effects.parts).toEqual(each.parts);
  });
});

/** A tool of pi's own that is not replayable (as a coding tool): it counts its runs. */
function oneShot(runs: string[], returned?: () => void) {
  return defineTool({
    name: 'edit',
    description: 'Edit a file.',
    parameters: obj({}),
    execute: async (_args, api) => {
      runs.push(api.callId);
      if (runs.length === 1) returned?.();
      return { output: [{ type: 'text', text: 'edited' }] };
    },
  });
}

/**
 * A turn whose first request calls the non-replayable `edit`, and whose first attempt dies `when`: as the tool
 * returns, before anything of pi's is stored after it, or as the model's second request starts. What the retried
 * attempt of the same invocation does.
 */
async function diedAfterTool(commits: Commits, when: 'as the tool returns' | 'as the next request starts') {
  const runs: string[] = [];
  const map = new Map<string, Uint8Array>();
  const fence = { closed: false };
  const attempts: ReturnType<typeof sqlAttempt>[] = [];
  const dies = () => {
    fence.closed = true;
    attempts[0]!.abort();
  };
  let requests = 0;
  script.respond = (_last, role) => {
    requests++;
    if (role !== 'toolResult') return callTools([['edit', {}]]);
    if (requests === 2 && when === 'as the next request starts') dies();
    return say('finished');
  };
  const handler = handlerOf(
    pi.chat({ tools: [oneShot(runs, when === 'as the tool returns' ? dies : undefined)], commits }),
  );
  const first = sqlAttempt({ map, fence, key: 'died', id: 'inv1' });
  attempts.push(first);
  const failed = await first
    .end(() => handler(first.ctx, 'edit it'))
    .then(
      () => 'answered',
      (error: unknown) => String(error),
    );
  fence.closed = false;
  const next = sqlAttempt({ map, key: 'died', id: 'inv1' });
  const answer = await next.end(() => handler(next.ctx, 'edit it'));
  const read = sqlAttempt({ map, key: 'died', id: 'read', shared: true });
  const page = await read.end(() => pi.messages()(read.view, {}));
  return { failed, answer, runs: runs.length, parts: withoutIds(page.messages.map((m) => m.parts)) };
}

const INTERRUPTED = '<harness>\n[error] Tool edit was interrupted and may have partially run\n</harness>';
const turn = (output: string, error?: true) => [
  [{ type: 'text', text: 'edit it' }],
  [{ type: 'tool', name: 'edit', input: {}, output, ...(error ? { error } : {}) }],
  [{ type: 'text', text: 'finished' }],
];

describe('a non-replayable tool that finished, with the attempt dying after it', () => {
  // The same in both modes: the commit of the result is lost with the attempt, the tool is not run again, and the
  // model is told that it was interrupted. With `'effects'` that commit is written when the next request starts
  // and not as the tool returns, so the window in which a death loses it is longer (a few milliseconds of
  // pi's bookkeeping), and the same outcome: it needs a death between the two, which the test harness can only
  // make at the tool's return.
  it.each<Commits>(['each', 'effects'])(
    'is not run again, and the model is told it was interrupted: %s',
    async (commits) => {
      const died = await diedAfterTool(commits, 'as the tool returns');
      expect(died.failed).toMatch(/attempt ended/);
      expect(died.runs).toBe(1);
      expect(died.answer).toBe('finished');
      expect(died.parts).toEqual(turn(INTERRUPTED, true));
    },
  );

  it.each<Commits>(['each', 'effects'])('keeps its result once the next request has started: %s', async (commits) => {
    const died = await diedAfterTool(commits, 'as the next request starts');
    expect(died.runs).toBe(1);
    expect(died.answer).toBe('finished');
    expect(died.parts).toEqual(turn('edited'));
  });
});

/**
 * A turn whose first model request fails (a provider's outage), so that pi stores the failure and waits to ask
 * again: no effect is in flight, and the batch holds what pi stored. The invocation is cancelled, or its attempt
 * ends, during the wait.
 */
async function duringRetryWait(commits: Commits, how: 'cancel' | 'end') {
  const map = new Map<string, Uint8Array>();
  const fence = { closed: false };
  const asked = { requests: 0 };
  script.respond = (_last, _role) => (++asked.requests === 1 ? unavailable('503 Service Unavailable') : say('Hello'));
  const handler = handlerOf(pi.chat({ commits, retry: { baseDelayMs: 1500, maxAgentDelayMs: 1500 } }));
  const entries = async () => {
    const read = sqlAttempt({ map, key: 'wait', id: `r${Math.random()}`, shared: true });
    return read.end(async () => {
      try {
        return Number((await read.ctx.db.values('SELECT count(*) FROM restate_pi_entries'))[0]![0]);
      } catch {
        return 0;
      }
    });
  };
  const first = sqlAttempt({ map, fence, key: 'wait', id: 'inv1' });
  const answering = first
    .end(() => handler(first.ctx, 'Hi'))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  // The request failed, and pi waits to ask again.
  while (asked.requests < 1) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 300));
  const stored = await entries();
  const started = Date.now();
  if (how === 'cancel') first.cancel();
  else {
    fence.closed = true;
    first.abort();
  }
  const failed = await Promise.race([answering, never(5000)]);
  const waited = Date.now() - started;
  fence.closed = false;
  const next = sqlAttempt({ map, key: 'wait', id: how === 'cancel' ? 'inv2' : 'inv1' });
  const answer = await next.end(() => handler(next.ctx, how === 'cancel' ? 'Hello' : 'Hi'));
  const read = sqlAttempt({ map, key: 'wait', id: 'read', shared: true });
  const page = await read.end(() => pi.messages()(read.view, {}));
  return { stored, failed, waited, answer, parts: withoutIds(page.messages.map((m) => m.parts)) };
}

describe('a batch that is open as the invocation is cancelled or its attempt ends', () => {
  it.each(['cancel', 'end'] as const)(
    'is never written, hangs nothing, and the turn goes on as with a commit each: %s',
    async (how) => {
      const each = await duringRetryWait('each', how);
      const effects = await duringRetryWait('effects', how);
      // The batch was open: what pi stored for the failed request and its wait was not yet stored.
      expect(effects.stored).toBeLessThan(each.stored);
      // Nothing hung: the handler settled at once, with the failure it has with a commit each.
      expect(effects.failed).not.toBe('stuck');
      expect(effects.waited).toBeLessThan(2000);
      expect(String(effects.failed)).toBe(String(each.failed));
      expect(how === 'cancel' ? effects.failed instanceof restate.CancelledError : true).toBe(true);
      // The turn completes, with the final state of an undisturbed run.
      expect(effects.answer).toBe(each.answer);
      expect(effects.parts).toEqual(each.parts);
    },
  );
});

/**
 * The calls the addon gets from the session while `during` runs, as `entry` and the SQL it runs (what a call
 * carries before its own statement first): the session's crossings of the addon.
 */
async function crossings<T>(during: () => Promise<T>) {
  const addon = createRequire(import.meta.resolve('@restatedev/sessions/internal'))(
    `@restatedev/sessions-${platform()}`,
  ) as { Database: { prototype: Record<string, (...a: unknown[]) => unknown> } };
  const proto = addon.Database.prototype;
  const calls: { entry: string; sql: string[] }[] = [];
  const originals = new Map<string, (...a: unknown[]) => unknown>();
  for (const entry of ['queryColumns', 'queryColumnsAfter', 'begin', 'commit', 'rollback']) {
    const original = proto[entry];
    if (original === undefined) continue; // an addon without the entry
    originals.set(entry, original);
    proto[entry] = function (this: unknown, ...args: unknown[]) {
      const [before, sql] = entry === 'queryColumnsAfter' ? [args[0] as string[], args[1]] : [[], args[0]];
      calls.push({ entry, sql: [...before, ...(typeof sql === 'string' ? [sql] : [])] });
      return original.apply(this, args);
    };
  }
  try {
    const result = await during();
    return { result, calls, sql: calls.flatMap((c) => c.sql) };
  } finally {
    for (const [entry, original] of originals) proto[entry] = original;
  }
}

const SAVEPOINT = 'SAVEPOINT restate_pi';
const RELEASE = 'RELEASE restate_pi';

describe("the adapter's savepoints ride with pi's statements", () => {
  it('costs one crossing a statement: a savepoint with its first, a release with the next call, none at the end', async () => {
    const { database, run } = adapter();
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER PRIMARY KEY)');
      database.armed = true;
      const { calls, sql } = await crossings(async () => {
        for (const n of [1, 2, 3]) {
          await database.transaction(async (tx) => {
            await tx.run('INSERT INTO t VALUES (?)', n * 10);
            await tx.run('INSERT INTO t VALUES (?)', n * 10 + 1);
          });
        }
        await database.flush();
      });
      expect(calls.map((c) => [c.entry, c.sql.length])).toEqual([
        ['begin', 0],
        ['queryColumnsAfter', 2], // the savepoint, and the first statement
        ['queryColumns', 1],
        ['queryColumnsAfter', 3], // the release of the commit before, the savepoint, the first statement
        ['queryColumns', 1],
        ['queryColumnsAfter', 3],
        ['queryColumns', 1],
        ['commit', 0],
      ]);
      // The statements are those of one call each, in the order of the calls, but for the last release.
      expect(sql.filter((s) => s.includes('restate_pi'))).toEqual([SAVEPOINT, RELEASE, SAVEPOINT, RELEASE, SAVEPOINT]);
      expect(await database.all('SELECT n FROM t ORDER BY n')).toEqual([
        { n: 10 },
        { n: 11 },
        { n: 20 },
        { n: 21 },
        { n: 30 },
        { n: 31 },
      ]);
    });
  });

  it('puts the release on a read of the batch, which runs after it', async () => {
    const { database, run } = adapter();
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER PRIMARY KEY)');
      database.armed = true;
      const { sql } = await crossings(async () => {
        await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (1)'));
        expect(await database.all('SELECT n FROM t')).toEqual([{ n: 1 }]);
        await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (2)'));
        await database.flush();
      });
      expect(sql).toEqual([
        SAVEPOINT,
        'INSERT INTO t VALUES (1)',
        RELEASE,
        'SELECT n FROM t',
        SAVEPOINT,
        'INSERT INTO t VALUES (2)',
      ]);
    });
  });

  it('runs neither savepoint nor release for a pi commit that runs no statement', async () => {
    const { database, run } = adapter();
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER PRIMARY KEY)');
      database.armed = true;
      const { sql } = await crossings(async () => {
        await database.transaction(async () => 'nothing');
        await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (1)'));
        await database.transaction(async () => 'nothing');
        await database.flush();
      });
      expect(sql).toEqual([SAVEPOINT, 'INSERT INTO t VALUES (1)']);
      expect(await database.all('SELECT n FROM t')).toEqual([{ n: 1 }]);
    });
  });

  it.each([
    [
      'its first statement',
      async (tx: SqliteExecutor) => {
        await tx.run('INSERT INTO missing VALUES (1)');
        await tx.run('INSERT INTO t VALUES (100)');
      },
      /no such table/,
    ],
    [
      'its last statement',
      async (tx: SqliteExecutor) => {
        await tx.run('INSERT INTO t VALUES (100)');
        await tx.run('INSERT INTO t VALUES (101)');
        await tx.run('INSERT INTO t VALUES (101)');
      },
      /UNIQUE/,
    ],
    [
      'a statement between two',
      async (tx: SqliteExecutor) => {
        await tx.run('INSERT INTO t VALUES (100)');
        await tx.run('INSERT INTO missing VALUES (1)');
        await tx.run('INSERT INTO t VALUES (101)');
      },
      /no such table/,
    ],
    [
      'pi itself, after its statements',
      async (tx: SqliteExecutor) => {
        await tx.run('INSERT INTO t VALUES (100)');
        await tx.run('INSERT INTO t VALUES (101)');
        throw new Error('the commit failed');
      },
      /the commit failed/,
    ],
    [
      'pi itself, before any statement',
      async () => {
        throw new Error('the commit failed');
      },
      /the commit failed/,
    ],
  ])('undoes exactly the commit that fails in %s, and the commits around it stay', async (_, failing, error) => {
    const { database, counted, run } = adapter();
    const told: string[] = [];
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER PRIMARY KEY)');
      database.armed = true;
      const commit = (name: string, body: (tx: SqliteExecutor) => Promise<unknown>) => {
        database.afterCommit = async () => void told.push(name);
        return database.transaction(body);
      };
      await commit('one', async (tx) => tx.run('INSERT INTO t VALUES (1)'));
      await commit('two', async (tx) => {
        await tx.run('INSERT INTO t VALUES (2)');
        await tx.run('INSERT INTO t VALUES (3)');
      });
      await expect(commit('failing', failing)).rejects.toThrow(error);
      await commit('after', async (tx) => tx.run('INSERT INTO t VALUES (9)'));
      // The failed one's rows are gone, the others' stay, in the batch and once it is written.
      expect(await database.all('SELECT n FROM t ORDER BY n')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 9 }]);
      await database.flush();
      expect(counted.commits).toBe(2); // the table, and the batch
      expect(told).toEqual(['one', 'two', 'after']);
      expect(await database.all('SELECT n FROM t ORDER BY n')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 9 }]);
      // The session goes on, and nothing of the batch's savepoints is left in it.
      await database.run('INSERT INTO t VALUES (10)');
      await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (11)'));
      await database.flush();
      expect(await database.all('SELECT n FROM t WHERE n > 9 ORDER BY n')).toEqual([{ n: 10 }, { n: 11 }]);
    });
  });

  it('rolls back to the savepoint of the failing commit alone, however the release of the one before is placed', async () => {
    const { database, run } = adapter();
    await run(async () => {
      await database.exec('CREATE TABLE t (n INTEGER PRIMARY KEY)');
      database.armed = true;
      await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (1)'));
      // The release of the first is still queued; the failing commit has no statement before the failure.
      await expect(
        database.transaction(async () => {
          throw new Error('early');
        }),
      ).rejects.toThrow('early');
      expect(await database.all('SELECT n FROM t')).toEqual([{ n: 1 }]);
      await database.flush();
      expect(await database.all('SELECT n FROM t')).toEqual([{ n: 1 }]);
    });
  });

  it('takes the statements as the session gives them when its transactions cannot defer: a call each, as before', async () => {
    const map = new Map<string, Uint8Array>();
    const sql = sqlAttempt({ map });
    // A transaction of a database of another kind has no way to defer.
    const plain = {
      ...sql.db,
      transaction: <T>(body: (tx: restate.Transaction) => Promise<T>) => sql.db.transaction((tx) => body({ ...tx })),
    };
    const database = new SqlKvDatabase(plain, { commits: 'effects' });
    await sql.end(async () => {
      await database.exec('CREATE TABLE t (n INTEGER PRIMARY KEY)');
      database.armed = true;
      const { sql: calls } = await crossings(async () => {
        await database.transaction(async (tx) => tx.run('INSERT INTO t VALUES (1)'));
        await expect(
          database.transaction(async (tx) => {
            await tx.run('INSERT INTO t VALUES (2)');
            throw new Error('no');
          }),
        ).rejects.toThrow('no');
        await database.flush();
      });
      expect(calls).toEqual([
        SAVEPOINT,
        'INSERT INTO t VALUES (1)',
        RELEASE,
        SAVEPOINT,
        'INSERT INTO t VALUES (2)',
        'ROLLBACK TO restate_pi',
        RELEASE,
      ]);
      expect(await database.all('SELECT n FROM t')).toEqual([{ n: 1 }]);
    });
  });
});
