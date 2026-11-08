// Fault injection for crash tests: with ABORT_PER_MILLE, the process aborts
// at random requests of the objects' stores to Restate; and with ABORT_AT, at
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
// A request is what an attempt awaits of Restate: a read (`get`), the state's
// keys (`keys`), a sync. It aborts before each, and after a sync too: a
// commit stored, and the attempt killed before it awaits anything more.
// Writes (`set`, `clear`) are commands the SDK sends with the next request,
// so killing the process between two of them is killing it before that
// request: they are no abort points of their own. As they were, a commit
// that writes many keys (a checkpoint, deleting a long tail) rolled for an
// abort at each write, twice, and hardly ever survived; a key whose every
// commit is one could not commit at all.
import * as restate from '@restatedev/restate-sdk';
import { type Store, withStoreWrapper } from '@restatedev/sessions/internal';
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
    console.error(`aborting at state request ${requests}`);
    // As abruptly as process.abort(), without a core dump or a crash report.
    process.kill(process.pid, 'SIGKILL');
  }
};

/** `store`, aborting the process at its requests (see above). */
const faulty = (store: Store): Store => ({
  get: async (key) => {
    maybeAbort();
    return store.get(key);
  },
  set: (key, value) => store.set(key, value),
  clear: (key) => store.clear(key),
  sync: async () => {
    maybeAbort();
    await store.sync();
    maybeAbort();
  },
  // A store that cannot list its keys stays one: it is never swept.
  keys:
    store.keys &&
    (async () => {
      maybeAbort();
      return store.keys!();
    }),
});

/** `services`, their session objects' stores aborting the process with ABORT_PER_MILLE. */
export const withFaults = (services: restate.ServeOptions['services']): restate.ServeOptions['services'] =>
  perMille > 0 ? services.map((service) => withStoreWrapper(service, faulty)) : services;

/** Serve `services` when `meta` is the entry module's `import.meta`. */
export function serveIfMain(meta: ImportMeta, services: restate.ServeOptions['services']) {
  if (process.argv[1] && fileURLToPath(meta.url) === process.argv[1]) {
    void restate.serve({ services: withFaults(services), port: Number(process.env.PORT ?? 9080) });
  }
}
