// Is an attempt's VM freed once the attempt ends?
//
// The scheduler is a threadsafe function that holds JavaScript's tick, which
// holds the driver, which holds the VM, which owns the function: a cycle the
// collector cannot see across the addon, and one attempt of it is the whole
// state machine. The driver lets the scheduler go when the attempt ends;
// without that, every attempt a deployment ever runs is retained.
//
//   pnpm --filter e2e leak
import { AttemptDriver, Vm } from '@restatedev/sessions/internal';

const V8 = 'application/vnd.restate.invocation.v8';
const ATTEMPTS = 300;

if (typeof global.gc !== 'function') {
  console.error('run with --expose-gc: `node --expose-gc leak.ts`');
  process.exit(2);
}

const refs: WeakRef<Vm>[] = [];
for (let i = 0; i < ATTEMPTS; i++) {
  const vm = new Vm([{ key: 'content-type', value: V8 }], true);
  const driver = new AttemptDriver(vm, () => {}, { service: 'S', handler: 'h' });
  vm.setScheduler(() => driver.scheduleTick());
  // Restate shuts the attempt down: the end of the request body.
  driver.notifyInputClosed();
  await new Promise((resolve) => setTimeout(resolve, 0));
  refs.push(new WeakRef(vm));
}

for (let i = 0; i < 5; i++) {
  global.gc();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// The last is still held by this scope's own locals; anything beyond a
// handful means the cycle is back.
const alive = refs.filter((r) => r.deref() !== undefined).length;
const ok = alive <= ATTEMPTS / 10;
console.log(`${ok ? 'ok  ' : 'FAIL'}  ${alive} of ${ATTEMPTS} attempts' VMs still reachable after their attempt ended`);
process.exit(ok ? 0 : 1);
