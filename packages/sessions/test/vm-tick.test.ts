// How often the addon asks JavaScript to tick the attempt's VM (`setScheduler`)
// for what the database's store does to the object's state: once until the
// tick begins (it writes the output of every command issued before it), and
// anew for a command issued after.
import { describe, expect, it } from 'vitest';
import { openOnVm } from '../src/database.ts';
import { frame, uint } from './wire.ts';
import { drain, messages, REQUESTED_ACK, startedVm, TYPE } from './vm-support.ts';

const nothing = { get: async () => undefined, set: () => {}, clear: () => {}, sync: async () => {} };

/** Wait until `done`: the threadsafe function's calls arrive on the event loop, when they do. */
async function until(done: () => boolean): Promise<void> {
  for (const start = Date.now(); !done();) {
    if (Date.now() - start > 10_000) throw new Error('the awaited calls did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let calls that should not come, come: the ones that did are counted after. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('the tick the addon asks for', () => {
  it('is asked for once for the commands a commit issues before it begins', async () => {
    const vm = startedVm('"in"');
    let asked = 0;
    vm.setScheduler(() => void asked++);
    const db = await openOnVm('tick-commit', nothing, vm, {});
    await until(() => asked > 0);
    await settle();
    vm.takeOutput();

    // A commit writes its pages, which ask for no ack, and its head, which does:
    // two commands of the VM, one request for the tick.
    asked = 0;
    const created = db.execute('CREATE TABLE t(x)');
    await until(() => asked > 0);
    await settle();
    expect(asked).toBe(1);

    // The tick begins and writes both; Restate acks the head, and the commit goes on.
    let commands = 0;
    const tick = () => {
      for (const message of messages(vm.takeOutput())) {
        if (message.type < 0x0400 || message.type >= 0x8000) continue;
        commands++;
        if ((message.flags & REQUESTED_ACK) !== 0) vm.notifyInput(frame(TYPE.commandAck, uint(1, commands)));
      }
      drain(vm);
    };
    tick();
    await created;
    expect(commands).toBeGreaterThan(1);

    // A command issued once the tick began asks anew.
    asked = 0;
    const next = db.execute('INSERT INTO t VALUES(1)');
    await until(() => asked > 0);
    await settle();
    expect(asked).toBe(1);
    tick();
    await next;
    expect(await db.values('SELECT x FROM t')).toEqual([[1]]);
  });
});
