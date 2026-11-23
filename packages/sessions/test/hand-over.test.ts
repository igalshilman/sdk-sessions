// A call to the addon is polled where it is made, and handed to the runtime if
// it has to wait: a call that is ready at once, one that waits, and a mix of
// both in a transaction that rolls back or a savepoint that does must come to
// the same. The scenarios run here with the default page cache, and in a
// process whose cache holds no page, where the calls that read wait.
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { closedWhilePending, scenarios } from './hand-over-scenarios.ts';

const run = fileUrl('hand-over-run.ts');

function fileUrl(name: string): string {
  return new URL(name, import.meta.url).pathname;
}

/** The scenarios in a process of its own, with `env` added to the environment. */
function elsewhere(env: Record<string, string>) {
  const out = execFileSync(process.execPath, [run], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return JSON.parse(out) as { transcript: string[]; closed: Awaited<ReturnType<typeof closedWhilePending>> };
}

it('calls that are ready and calls that wait come to the same results', { timeout: 120_000 }, async () => {
  const here = await scenarios();
  const cold = elsewhere({ RESTATE_SQL_CACHE_MEMORY: '1KiB' });
  expect(cold.transcript).toEqual(here);
  // The transcript says what happened, not only that it was alike.
  const said = (what: string) => here.find((line) => line.startsWith(`${what}:`));
  expect(said('values')).toContain('bigint:4611686018427387904');
  expect(said('values')).toContain('bytes:00ff07');
  expect(said('after rollback')).toBe('after rollback: [[5]]');
  expect(said('in savepoint tx')).toBe('in savepoint tx: [[20],[22]]');
  expect(said('after savepoint')).toBe('after savepoint: [[20],[22]]');
  expect(said('proto')).toContain('"__proto__"');
  expect(said('wide')).toBe('wide: 300');
  expect(said('missing table')).toContain('no such table');
  expect(said('usable')).toBe('usable: true');
});

it('a session closed while a call is outstanding settles it, and ends', { timeout: 60_000 }, async () => {
  for (const closed of [await closedWhilePending(), elsewhere({ RESTATE_SQL_CACHE_MEMORY: '1KiB' }).closed]) {
    expect(['resolved', 'rejected']).toContain(closed.settled);
    expect(closed.usable).toBe(false);
    expect(closed.after).not.toBe('did not fail');
  }
});
