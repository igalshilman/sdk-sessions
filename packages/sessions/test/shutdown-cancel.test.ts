// An attempt shut down while a call is outstanding suspends on that call's
// result, and Restate starts the next attempt when it comes. What else the
// suspension waits on decides whether a cancellation that comes meanwhile
// reaches the invocation before the call answers: the cancel signal (signal
// 1), unless the attempt already knows of a cancellation, since waiting on one
// Restate has stored would resume the invocation at once, every time.
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import { serveSession } from '../src/handler.ts';
import { decode } from './wire.ts';
import { restateSide, TYPE, type SideOptions } from './side.ts';

/** The cancel signal: signal 1 of every invocation. */
const CANCEL_SIGNAL = 1;

const waiter = restate.sessionObject({
  name: 'Waiter',
  handlers: {
    // A cancellation leaves its await as it is: the call stays outstanding
    // in an attempt that knows of the cancellation.
    wait: {
      explicitCancellation: true,
      handler: async (ctx: restate.SessionContext) =>
        ctx.rpc({ service: 'Approvals', key: 'a', handler: 'approve', input: null }),
    },
  },
});

/** The values of repeated uint32 field `number` of `fields`, packed or not. */
function uints(fields: Map<number, (number | Uint8Array)[]>, number: number): number[] {
  return (fields.get(number) ?? []).flatMap((v) => {
    if (typeof v === 'number') return [v];
    const out: number[] = [];
    for (let at = 0; at < v.length;) {
      let n = 0;
      for (let scale = 1; ; scale *= 128) {
        const byte = v[at++]!;
        n += (byte & 127) * scale;
        if (byte < 128) break;
      }
      out.push(n);
    }
    return out;
  });
}

/**
 * Shut down an attempt of `wait` while its call is outstanding: what its
 * suspension waits on.
 */
async function suspendedOn(options: SideOptions = {}) {
  const r = restateSide(new Map(), { hold: ['Approvals/approve'], ...options });
  const serving = serveSession(waiter, 'wait', r.stream);
  r.start('k1', null);
  const settling = r.settle();
  await r.until(() => r.calls.length === 1, 'the call');
  r.shutDown();
  await Promise.all([serving, settling]);
  const suspensions = r.sent().filter((m) => m.type === TYPE.suspension);
  expect(suspensions).toHaveLength(1);
  const awaiting = decode(suspensions[0]!.fields.get(4)![0] as Uint8Array);
  const on = { completions: uints(awaiting, 1), signals: uints(awaiting, 2) };
  // The premise: the call's result is waited on, whatever else is.
  expect(on.completions.length).toBeGreaterThan(0);
  return on;
}

describe('an attempt shut down while a call is outstanding', () => {
  // The suspension names the cancel signal while no cancellation has come, so
  // that cancelling a suspended invocation starts its next attempt.
  it('suspends on the cancel signal too, while no cancellation has come', async () => {
    expect((await suspendedOn()).signals).toContain(CANCEL_SIGNAL);
  }, 30_000);

  it('suspends on the call alone once a cancellation came: waiting on it would resume at once', async () => {
    expect((await suspendedOn({ cancelAtStart: true })).signals).not.toContain(CANCEL_SIGNAL);
  }, 30_000);
});
