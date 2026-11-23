// A commit on the attempt's VM calls back into JavaScript, at its sync, only
// when its transaction gave `withCommit` work to run: otherwise the call
// would run an empty function. Without the VM, every commit does.
import { expect, it } from 'vitest';
import { AttemptDriver } from '../src/driver.ts';
import { openOnVm } from '../src/database.ts';
import { frame, uint } from './wire.ts';
import { messages, REQUESTED_ACK, startedVm, TYPE } from './vm-support.ts';

/** An attempt whose Restate acks every command that asks to be. */
function attempt() {
  const vm = startedVm('"in"');
  let commands = 0;
  const driver = new AttemptDriver(
    vm,
    (chunk: Uint8Array) => {
      for (const message of messages(chunk)) {
        if (message.type < 0x0400 || message.type >= 0x8000) continue;
        const nth = ++commands;
        if ((message.flags & REQUESTED_ACK) !== 0) {
          queueMicrotask(() => driver.notifyInput(frame(TYPE.commandAck, uint(1, nth))));
        }
      }
    },
    { service: 'Probe', handler: 'run' },
  );
  vm.setScheduler(() => driver.scheduleTick());
  return vm;
}

/** A database on the VM over a store that counts its syncs. */
async function database(name: string) {
  const syncs = { count: 0 };
  const store = {
    get: async () => undefined,
    set: () => {},
    clear: () => {},
    sync: async () => void syncs.count++,
  };
  return { db: await openOnVm(`hook-${name}`, store, attempt(), {}), syncs };
}

it('a commit without withCommit work does not call back into JavaScript, and one with it does', async () => {
  const { db, syncs } = await database('both');
  await db.execute('CREATE TABLE t(x)');
  syncs.count = 0;

  await db.transaction(async (tx) => tx.execute('INSERT INTO t VALUES(1)'));
  expect(syncs.count).toBe(0);

  const ran: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO t VALUES(2)');
    tx.withCommit(() => ran.push('with'));
  });
  expect(ran).toEqual(['with']);
  expect(syncs.count).toBe(1);

  // The next one has none again: the flag of the one before did not stay.
  await db.transaction(async (tx) => tx.execute('INSERT INTO t VALUES(3)'));
  expect(syncs.count).toBe(1);
  expect(ran).toEqual(['with']);

  // A transaction that rolls back runs nothing, whichever it is.
  await expect(
    db.transaction(async (tx) => {
      await tx.execute('INSERT INTO t VALUES(4)');
      tx.withCommit(() => ran.push('rolled back'));
      throw new Error('abort');
    }),
  ).rejects.toThrow('abort');
  expect(ran).toEqual(['with']);
  expect(await db.values('SELECT x FROM t ORDER BY x')).toEqual([[1], [2], [3]]);
  await db.save();
});

it('a commit that fails leaves the next commit to decide for itself', async () => {
  const { db, syncs } = await database('failed');
  await db.execute('CREATE TABLE p(id INTEGER PRIMARY KEY)');
  await expect(
    db.transaction(async (tx) => {
      await tx.execute('INSERT INTO p VALUES(1)');
      await tx.execute('INSERT INTO p VALUES(1)');
    }),
  ).rejects.toThrow(/constraint|UNIQUE|unique/i);
  syncs.count = 0;
  const ran: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO p VALUES(2)');
    tx.withCommit(() => ran.push('with'));
  });
  expect(ran).toEqual(['with']);
  expect(syncs.count).toBe(1);
  await db.save();
});
