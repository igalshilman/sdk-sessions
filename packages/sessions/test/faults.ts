// Fault injection for crash tests: with ABORT_PER_MILLE, the process aborts
// at random requests of the session objects to Restate; and with ABORT_AT, at
// that request (counted from 1), so that it aborts at least once. ABORT_SEED
// seeds the random aborts: a process given the same seed aborts at the same of
// its requests (the requests themselves depend on timing). With
// ABORT_AFTER_MS, the random aborts start only once the process has run that
// long: the process-wide rate of ABORT_PER_MILLE is per request of every
// invocation the process runs, so under enough load a process dies before an
// attempt longer than a few requests can finish, and its retries, which make
// more requests, bring the next abort sooner. A lifetime floor bounds how
// often a process dies whatever the load. ABORT_AT is not held back by it.
//
// A request is what an attempt asks of Restate and awaits: a read of the
// object's state, a commit's writes, a call. A session object's attempt runs
// on the explicit recovery VM, whose store is in the addon: its reads and
// writes never cross into JavaScript, so there is no store here to wrap
// (`withStoreWrapper` is refused on the VM). They cross the VM's boundary
// instead, and the process aborts there:
//
//   - before a request goes out: as the attempt's driver takes the VM's
//     output (`takeOutput`), before it is written. A read, a commit's tail and
//     head, a call, the answer at the end: what was buffered is lost with the
//     process;
//   - after it is answered: as a chunk of Restate's comes in once the attempt
//     runs (`notifyInput`), before the VM reads it. A read's state, or the ack
//     of a commit: the commit stored, and the attempt killed before it acts
//     on anything more.
//
// The invocation's own input, before the handler starts, is no abort point;
// neither is a turn that writes nothing. A commit is one request, whatever
// it writes: two abort points, as a commit was when the store's sync was its
// abort point.
import * as restate from '@restatedev/restate-sdk';
import { served, Vm } from '@restatedev/sessions/internal';
import { fileURLToPath } from 'node:url';
import { seeded, seedFromEnv } from './random.ts';

const perMille = Number(process.env.ABORT_PER_MILLE ?? 0);
const at = Number(process.env.ABORT_AT ?? 0);
const after = performance.now() + Number(process.env.ABORT_AFTER_MS ?? 0);
const random = seeded(seedFromEnv());
let requests = 0;

const maybeAbort = () => {
  // Drawn as without the floor: a seed rolls the same numbers at the same requests.
  if (++requests === at || (random() * 1000 < perMille && performance.now() >= after)) {
    console.error(`aborting at request ${requests}`);
    // As abruptly as process.abort(), without a core dump or a crash report.
    process.kill(process.pid, 'SIGKILL');
  }
};

/** Abort the process at the requests of every attempt on the VM (see above), once per process. */
let installed = false;
function abortAtRequests() {
  if (installed) return;
  installed = true;
  const vm = (Vm as unknown as { prototype: Vm }).prototype;
  // The addon's own, called with the attempt's VM as `this`.
  const original = (name: keyof Vm): unknown => Object.getOwnPropertyDescriptor(vm, name)!.value;
  const takeOutput = original('takeOutput') as (this: Vm) => Buffer;
  vm.takeOutput = function (this: Vm) {
    const output = takeOutput.call(this);
    if (output.length > 0) maybeAbort();
    return output;
  };
  const notifyInput = original('notifyInput') as (this: Vm, chunk: Uint8Array) => void;
  vm.notifyInput = function (this: Vm, chunk: Uint8Array) {
    if (this.isReadyToExecute()) maybeAbort();
    notifyInput.call(this, chunk);
  };
}

/**
 * `services`, with what they need beside them (`served`: an agent's
 * companion, say), the process aborting at their session objects' requests
 * with ABORT_PER_MILLE or ABORT_AT.
 */
export const withFaults = (services: restate.ServeOptions['services']): restate.ServeOptions['services'] => {
  if (perMille > 0 || at > 0) abortAtRequests();
  return served(services);
};

/** Serve `services` when `meta` is the entry module's `import.meta`. */
export function serveIfMain(meta: ImportMeta, services: restate.ServeOptions['services']) {
  if (process.argv[1] && fileURLToPath(meta.url) === process.argv[1]) {
    void restate.serve({ services: withFaults(services), port: Number(process.env.PORT ?? 9080) });
  }
}
