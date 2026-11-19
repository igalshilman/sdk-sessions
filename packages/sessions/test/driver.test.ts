// One attempt on the explicit recovery VM (`src/driver.ts`), with Restate's
// side played by wire bytes. What the selector had to fake — several promises
// awaited at once, each waiting on Restate — falls out of the VM here: an
// action returns a handle, and the tick settles the promise of that handle.
import { describe, expect, it } from 'vitest';
import { AttemptDriver, AttemptShutDown } from '../src/driver.ts';
import { frame, uint, field } from './wire.ts';
import { drain, messages, startedVm, TYPE, types, value } from './vm-support.ts';

/** An attempt over a started VM, with the bytes it writes. */
function attempt(
  options: {
    partial?: boolean;
    state?: Record<string, string>;
    shared?: boolean;
    explicitCancellation?: boolean;
  } = {},
) {
  const written: Uint8Array[] = [];
  /** Everything ever written, which clearing `written` for an assertion keeps. */
  const all: Uint8Array[] = [];
  const vm = startedVm('"hello"', options);
  const a = new AttemptDriver(vm, (chunk: Uint8Array) => void (written.push(chunk), all.push(chunk)), {
    service: 'Probe',
    handler: 'run',
    shared: options.shared,
    explicitCancellation: options.explicitCancellation,
  });
  return {
    attempt: a,
    vm,
    written,
    /** Everything written so far, as messages. */
    sent: () => messages(Buffer.concat(written)),
    /** A call of the attempt's, which waits on Restate as a `ctx.rpc` does. */
    makeCall(handler = 'reserve') {
      return a.call({ service: 'Store', handler, input: Buffer.from('"x"') });
    },
    /** Answer the `nth` call sent so far (0-based): its invocation id, its result, or both. */
    answerCall(nth: number, { id, result }: { id?: string; result?: string } = {}) {
      const calls = messages(Buffer.concat(all)).filter((m) => m.type === TYPE.call);
      const command = calls[nth]!.fields;
      if (id !== undefined) {
        a.notifyInput(
          frame(TYPE.callInvocationIdCompletion, [...uint(1, command.get(10)![0] as number), ...bytesField(16, id)]),
        );
      }
      if (result !== undefined) {
        a.notifyInput(
          frame(TYPE.callCompletion, [...uint(1, command.get(11)![0] as number), ...field(5, 2, value(result))]),
        );
      }
    },
    /** Restate acks the `nth` command it was sent (1-based, as the journal numbers them). */
    ack(nth: number) {
      a.notifyInput(frame(TYPE.commandAck, uint(1, nth)));
    },
  };
}

/** Let the queued microtasks run. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('an attempt on the explicit recovery VM', () => {
  it('settles two calls awaited at once, which is what the selector existed to do', async () => {
    const r = attempt();
    // Both issued in the same turn, both waiting on Restate. On the SDK's own
    // loop this is "awaitNext already pending".
    const both = Promise.all([r.makeCall('one').result, r.makeCall('two').result]);
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.call, TYPE.call]);
    r.answerCall(0, { result: '"1"' });
    r.answerCall(1, { result: '"2"' });
    await turn();
    expect((await both).map((v: Uint8Array | null) => (v === null ? null : Buffer.from(v).toString()))).toEqual([
      '"1"',
      '"2"',
    ]);
  });

  it('batches the output of the actions issued in one turn into a single write', async () => {
    const r = attempt();
    void r.makeCall('one').result;
    void r.makeCall('two').result;
    void r.attempt.send({ service: 'Store', handler: 'note', input: Buffer.from('"x"') });
    expect(r.written).toHaveLength(0); // nothing is written before the tick
    await turn();
    expect(r.written).toHaveLength(1);
    expect(types(r.written[0]!)).toEqual([TYPE.call, TYPE.call, 0x040e]);
  });

  it('a call gives its invocation id and its result, each from its own notification', async () => {
    const r = attempt();
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', key: 'k', input: Buffer.from('"x"') });
    await turn();
    const sent = r.sent();
    expect(sent.map((m) => m.type)).toEqual([TYPE.call]);
    // Restate answers the id, then the result.
    const command = sent[0]!.fields;
    const idHandle = command.get(10)![0] as number;
    const resultHandle = command.get(11)![0] as number;
    r.attempt.notifyInput(
      frame(TYPE.callInvocationIdCompletion, [...uint(1, idHandle), ...bytesField(16, 'inv_called')]),
    );
    await turn();
    expect(await call.invocationId).toBe('inv_called');
    r.attempt.notifyInput(frame(TYPE.callCompletion, [...uint(1, resultHandle), ...field(5, 2, value('"done"'))]));
    await turn();
    expect(Buffer.from((await call.result)!).toString()).toBe('"done"');
  });

  it('the attempt Restate shuts down rejects everything still waiting', async () => {
    const r = attempt();
    const first = r.makeCall('one').result;
    const second = r.makeCall('two').result;
    await turn();
    r.attempt.notifyInputClosed();
    await turn();
    await expect(first).rejects.toBeInstanceOf(AttemptShutDown);
    await expect(second).rejects.toBeInstanceOf(AttemptShutDown);
    expect(r.attempt.over).toBeInstanceOf(AttemptShutDown);
    // An action after the end rejects rather than hanging.
    await expect(r.makeCall('three').result).rejects.toBeInstanceOf(AttemptShutDown);
  });

  it('tells its listeners once when the attempt ends', async () => {
    const r = attempt({ partial: true });
    let ended = 0;
    r.attempt.whenEnded(() => ended++);
    const unregister = r.attempt.whenEnded(() => ended++);
    unregister();
    r.attempt.notifyInputClosed();
    await turn();
    expect(ended).toBe(1);
    // A listener registered after the end is told at once.
    r.attempt.whenEnded(() => ended++);
    expect(ended).toBe(2);
  });

  it('resolves cancelled() when the cancel signal arrives, and nothing suspends on it', async () => {
    const r = attempt();
    let cancelled = false;
    void r.attempt.cancellation().then(() => (cancelled = true));
    await turn();
    expect(cancelled).toBe(false);
    expect(r.attempt.isCancelled()).toBe(false);
    // The signal has no notification of its own: a tick notices the flag.
    r.attempt.notifyInput(frame(TYPE.signal, [...uint(2, 1), ...bytesField(4, '')]));
    await turn();
    expect(cancelled).toBe(true);
    expect(r.attempt.isCancelled()).toBe(true);
    // Nothing was sent for it: the attempt never told Restate it waits.
    expect(drain(r.vm)).toEqual([]);
  });

  it('cancels the calls it made, by the ids Restate gave them', async () => {
    const r = attempt();
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', input: Buffer.from('"x"') });
    await turn();
    const command = r.sent()[0]!.fields;
    r.attempt.notifyInput(
      frame(TYPE.callInvocationIdCompletion, [...uint(1, command.get(10)![0] as number), ...bytesField(16, 'inv_a')]),
    );
    await turn();
    await call.invocationId;
    r.written.length = 0;
    expect(await r.attempt.cancelPreviousCalls()).toEqual(['inv_a']);
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([0x0410]); // SendSignalCommand: the cancellation
  });

  it('an implicit cancellation fails what waits on Restate, and cancels the calls in flight', async () => {
    const r = attempt({ partial: true });
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', input: Buffer.from('"x"') });
    await turn();
    const command = r.sent()[0]!.fields;
    r.attempt.notifyInput(
      frame(TYPE.callInvocationIdCompletion, [...uint(1, command.get(10)![0] as number), ...bytesField(16, 'inv_a')]),
    );
    await turn();
    await call.invocationId;
    const waiting = r.makeCall('one').result;
    await turn();
    r.written.length = 0;
    r.attempt.notifyInput(frame(TYPE.signal, [...uint(2, 1), ...bytesField(4, '')]));
    await turn();
    // The await fails as a cancelled invocation's do...
    const failed = await waiting.then(
      () => undefined,
      (e: unknown) => e as Error & { code?: number },
    );
    // The class everything downstream classifies on: `cancellation.test.ts`
    // asserts it, and @restatedev/agents branches on it in a dozen places.
    expect(failed?.name).toBe('CancelledError');
    // ...and the call in flight was cancelled.
    expect(types(Buffer.concat(r.written))).toContain(0x0410);
  });

  it('an explicit cancellation only resolves cancelled(), leaving the handler to stop its own work', async () => {
    const r = attempt({ explicitCancellation: true });
    let cancelled = false;
    void r.attempt.cancellation().then(() => (cancelled = true));
    const waiting = r.makeCall('one').result;
    let settled = false;
    void waiting.then(
      () => (settled = true),
      () => (settled = true),
    );
    await turn();
    r.written.length = 0;
    r.attempt.notifyInput(frame(TYPE.signal, [...uint(2, 1), ...bytesField(4, '')]));
    await turn();
    expect(cancelled).toBe(true);
    // The call is left alone: the handler decides what to stop.
    expect(settled).toBe(false);
    expect(types(Buffer.concat(r.written))).toEqual([]);
    r.answerCall(0, { result: '"1"' });
    await turn();
    expect(Buffer.from((await waiting)!).toString()).toBe('"1"');
  });

  it('does not cancel a call that already answered', async () => {
    const r = attempt();
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', input: Buffer.from('"x"') });
    await turn();
    const command = r.sent()[0]!.fields;
    r.attempt.notifyInput(
      frame(TYPE.callInvocationIdCompletion, [...uint(1, command.get(10)![0] as number), ...bytesField(16, 'inv_a')]),
    );
    r.attempt.notifyInput(
      frame(TYPE.callCompletion, [...uint(1, command.get(11)![0] as number), ...field(5, 2, value('"done"'))]),
    );
    await turn();
    await call.result;
    r.written.length = 0;
    // It is over: cancelling it would cancel an invocation that already ended.
    expect(await r.attempt.cancelPreviousCalls()).toEqual([]);
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([]);
  });

  it('cancels a call whose invocation id arrives only after the cancellation', async () => {
    const r = attempt();
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', input: Buffer.from('"x"') });
    call.result.catch(() => {});
    await turn();
    const command = r.sent()[0]!.fields;
    // The cancellation lands while the id is still outstanding.
    r.attempt.notifyInput(frame(TYPE.signal, [...uint(2, 1), ...bytesField(4, '')]));
    await turn();
    r.written.length = 0;
    r.attempt.notifyInput(
      frame(TYPE.callInvocationIdCompletion, [
        ...uint(1, command.get(10)![0] as number),
        ...bytesField(16, 'inv_late'),
      ]),
    );
    await turn();
    await r.attempt.cancellingCalls;
    await turn();
    expect(types(Buffer.concat(r.written))).toContain(0x0410); // the cancellation went out
  });

  it('the request names its target, and its signal aborts when the attempt ends', async () => {
    const r = attempt();
    const request = r.attempt.request(new Map([['content-type', 'application/vnd.restate.invocation.v8']]));
    expect(request.target.service).toBe('Probe');
    expect(String(request.target)).toBe('Probe/thekey/run');
    expect(request.id).toBe('inv_test');
    expect(request.attemptHeaders.get('content-type')).toContain('invocation.v8');
    expect(request.attemptCompletedSignal.aborted).toBe(false);
    r.attempt.notifyInputClosed();
    await turn();
    expect(request.attemptCompletedSignal.aborted).toBe(true);
  });

  it('heartbeats only inside working, whatever the attempt waits for', async () => {
    const r = attempt();
    const beats = () => types(Buffer.concat(r.written)).filter((t) => t === TYPE.awaitingOn).length;
    // Outside working the attempt is silent, waiting or not: Restate may shut it down.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats()).toBe(0);
    // Inside, it heartbeats on the interval, with a call outstanding too; at
    // once if it has been silent for an interval already.
    const waiting = r.makeCall('one').result;
    await turn();
    r.written.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const release = Promise.withResolvers<void>();
    const working = r.attempt.working(() => release.promise.then(() => 'done'), 5);
    await turn();
    expect(beats()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats()).toBeGreaterThan(1);
    // Two scopes open: the attempt is kept alive until the last closes.
    const inner = Promise.withResolvers<void>();
    const nested = r.attempt.working(() => inner.promise, 5);
    release.resolve();
    expect(await working).toBe('done');
    const during = beats();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats()).toBeGreaterThan(during);
    inner.resolve();
    await nested;
    await turn();
    const after = beats();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats()).toBe(after);
    r.answerCall(0, { result: '"1"' });
    await waiting;
  });

  it('opens a working scope right after writing without a heartbeat of its own', async () => {
    const r = attempt();
    // Something written just now restarted Restate's timer: the scope's
    // first heartbeat waits for the interval (the database opens one per call).
    void r.makeCall('one').result;
    await turn();
    r.written.length = 0;
    await r.attempt.working(async () => {
      await turn();
    }, 1_000);
    await turn();
    expect(types(Buffer.concat(r.written))).not.toContain(TYPE.awaitingOn);
  });

  it('closes a working scope whose work throws', async () => {
    const r = attempt();
    await expect(
      r.attempt.working(() => {
        throw new Error('boom');
      }, 5),
    ).rejects.toThrow('boom');
    await turn();
    r.written.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(types(Buffer.concat(r.written))).not.toContain(TYPE.awaitingOn);
  });

  it('ends the handler with its output, and writes it', async () => {
    const r = attempt();
    r.attempt.endSuccess(Buffer.from('"done"'));
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.output, TYPE.end]);
  });

  it('a failed attempt writes an error and ends no invocation', async () => {
    const r = attempt();
    r.attempt.fail('the model is down', 'at model.ts:1');
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.error]);
    // Taking notifications now raises the error that closed the attempt.
    expect(r.attempt.over?.name).toBe('AttemptFailed');
  });
});

/** A bytes field, for the completions that carry a plain string. */
function bytesField(number: number, text: string): number[] {
  return field(number, 2, [...new TextEncoder().encode(text)]);
}
