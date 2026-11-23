// One attempt of a session object's handler, on the explicit recovery VM
// (`vm.ts`, `native/src/vm.rs`).
//
// The VM never replays a journal: every attempt runs the handler from the
// start, and recovers from the state the earlier attempts stored. An action
// returns a handle, and its result comes back as a notification of that
// handle, which settles the action's promise here. Two things move the attempt
// along:
//
//   - the input pump, the only reader of the request body: it hands the VM
//     each chunk, and the end of the body;
//   - the tick, scheduled after every call into the VM, at most one per turn
//     of the event loop: it writes the VM's output, settles the promises of
//     the actions that completed, and notices the end of the attempt.
//
// Scheduling a tick after every call batches the output of the actions issued
// in the same turn, and flushes it before the event loop can wait on anything.
//
// Restate shuts an attempt down by closing the request body, after its
// inactivity timeout. From then on the attempt is over: every action throws,
// the promises still pending reject, and a new attempt runs the handler from
// the start, unless work in `working` keeps the attempt alive.
import * as restate from '@restatedev/restate-sdk';
import { isShutDown, type Vm, type VmFailure, type VmInput, type VmNotification } from './vm.ts';

/**
 * How often an attempt in `working` tells Restate it makes progress, in
 * milliseconds: RESTATE_SESSIONS_HEARTBEAT, or 20 seconds.
 *
 * Restate shuts down an attempt it has heard nothing from for its inactivity
 * timeout, a minute by default, and 20 seconds is well inside that. A
 * deployment that shortens the timeout
 * (`RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT`) must shorten this with it.
 */
function heartbeatMs(): number {
  const set = Number(process.env.RESTATE_SESSIONS_HEARTBEAT);
  return Number.isFinite(set) && set > 0 ? set : 20_000;
}

/**
 * Restate shut the attempt down: it is over, and a new attempt runs the
 * handler from the start.
 */
export class AttemptShutDown extends Error {
  constructor() {
    super('Restate shut the attempt down; a new attempt will run the handler from the start');
    this.name = 'AttemptShutDown';
  }
}

/** The attempt failed, and Restate retries it. */
export class AttemptFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptFailed';
  }
}

/** A failed action's terminal error, as the SDK's own, so that user code catches it. */
function terminal(failure: VmFailure): restate.TerminalError {
  return new restate.TerminalError(failure.message, {
    errorCode: failure.code,
    metadata: Object.fromEntries(failure.metadata.map(({ key, value }) => [key, value])),
  });
}

/**
 * Keep an unawaited rejection from reaching the process: the attempt's end
 * rejects every promise still waiting, and a handler that stopped awaiting one
 * — a race it lost, say — would otherwise bring the process down. Attaching a
 * handler marks the promise handled; the caller still sees the rejection.
 */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/** What a notification settles its promise with. */
function settled(notification: VmNotification): { value: unknown } | { error: Error } {
  switch (notification.kind) {
    case 'void':
      return { value: undefined };
    case 'success':
      return { value: notification.bytes };
    case 'failure':
      return { error: terminal(notification.failure) };
    case 'stateKeys':
      return { value: notification.keys };
    case 'invocationId':
      return { value: notification.id };
    default:
      // A kind this version does not know: no value, rather than an action
      // whose promise stays pending forever.
      return { value: undefined };
  }
}

/** A call this attempt made: its invocation id, and whether it is over. */
interface Call {
  id: Promise<string>;
  done: boolean;
  cancelled: boolean;
}

/** A promise waiting for the notification of a handle. */
interface Waiting {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** What it is waiting for, which decides what a cancellation does to it. */
  waits: Waits;
}

/**
 * What a handle's promise is, which decides two things a cancellation does.
 *
 * - `result`: what the handler awaits for an answer. A cancellation nothing
 *   was waiting for is carried to the next of these, and never to the others:
 *   an id is what a handler is least likely to await, so carrying to one
 *   would let the action it belongs to run to completion unnoticed.
 * - `callId`: a call's invocation id, which has to settle even through a
 *   cancellation, because cancelling the call needs it.
 * - `sendId`: a send's invocation id. Nothing needs it once the invocation is
 *   cancelled, so a cancellation rejects it like any other wait — but it is
 *   usually voided, so it must not take the carry.
 */
type Waits = 'result' | 'callId' | 'sendId';

/** What the attempt is of: the target it was invoked on, and how it handles cancellation. */
export interface AttemptOptions {
  service: string;
  handler: string;
  /** A view: it reads beside the handlers, and writes nothing. */
  shared?: boolean;
  /**
   * The handler stops its own work at a cancellation (`cancelled(ctx)`), so
   * the attempt does not fail its awaits or cancel its calls for it.
   */
  explicitCancellation?: boolean;
}

/**
 * Drives one attempt over its VM: the input pump, the tick, and the promises
 * of the actions it issued.
 */
export class AttemptDriver {
  private readonly vm: Vm;
  private readonly write: (chunk: Uint8Array) => void;
  private readonly options: AttemptOptions;

  /** Set once the attempt is over, to what ended it. */
  private ended: Error | undefined;
  private readonly waiting = new Map<number, Waiting>();
  private readonly onEnd = new Set<() => void>();
  private queued = false;
  /** The calls this attempt made, by the handle of their result. */
  private readonly calls = new Map<number, Call>();
  /** Issuing the cancellations of the calls, which the handler's end waits for. */
  private cancelling: Promise<void> | undefined;
  private cancelledResolve: (() => void) | undefined;
  /**
   * A cancellation that failed nothing the handler awaits, carried to the
   * next thing it does await: a result of Restate's ({@link promise}), or a
   * call of its database ({@link takeCarriedCancellation}). A retry of a
   * cancelled invocation knows it was cancelled before the handler starts,
   * and its first call has to fail all the same, rather than run to
   * completion.
   *
   * There is one, and it is here. The addon once carried a second for the
   * database's waits, and the two could not agree on who had delivered: a
   * handler saw one cancellation twice.
   */
  private carriedCancellation = false;
  private readonly cancelledPromise: Promise<void>;
  /**
   * The one timer of the heartbeats, armed for `beatDue`. It outlives a run of
   * scopes, so the database's scopes (one a statement) do not start and clear
   * a timer each: it fires, finds no scope open, and is not armed again.
   */
  private heartbeats: ReturnType<typeof setTimeout> | undefined;
  private beatDue = 0;
  /** The `working` scopes open: the attempt heartbeats while there is one. */
  private scopes = 0;
  /** The run of scopes now open: when the first opened, and its interval. */
  private runEvery = 0;
  /** When the run's next heartbeat is due. */
  private nextBeat = 0;
  /** The heartbeat interval, read from the environment on first use. */
  private beatEvery: number | undefined;
  /** When the attempt last wrote to Restate, which restarts Restate's inactivity timer. */
  private wroteAt = Date.now();
  private readonly aborter = new AbortController();
  /**
   * The invocation's input. Taking it from the VM copies the body across the
   * addon, and the key, the body and the request each want it.
   */
  private theInput: VmInput | undefined;

  constructor(vm: Vm, write: (chunk: Uint8Array) => void, options: AttemptOptions) {
    this.vm = vm;
    this.write = write;
    this.options = options;
    this.cancelledPromise = new Promise<void>((resolve) => {
      this.cancelledResolve = resolve;
    });
  }

  // --- Input and output

  /** A chunk of the request body. */
  notifyInput(chunk: Uint8Array): void {
    this.vm.notifyInput(chunk);
    this.schedule();
  }

  /** The end of the request body: while the handler runs, Restate shut the attempt down. */
  notifyInputClosed(): void {
    this.vm.notifyInputClosed();
    this.schedule();
  }

  isReadyToExecute(): boolean {
    return this.vm.isReadyToExecute();
  }

  /**
   * Schedule a tick from outside: what the VM calls after the database's store
   * acts on it from the runtime's thread, so that what it wrote is written and
   * what it waits for is routed to it.
   */
  scheduleTick(): void {
    this.schedule();
  }

  /** Schedule a tick, once per turn of the event loop. */
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => (this.ended === undefined ? this.tick() : this.flush()));
  }

  /** Write what the VM has buffered. A closed attempt still flushes its last words. */
  private flush(): void {
    this.queued = false;
    const output = this.vm.takeOutput();
    if (output.length === 0) return;
    this.write(output);
    this.wroteAt = Date.now();
  }

  /**
   * Write the VM's output, settle the promises of the actions that completed,
   * and notice the end of the attempt.
   */
  private tick(): void {
    this.queued = false;
    this.flush();
    if (this.ended !== undefined) return;
    let notification: VmNotification | null;
    try {
      while ((notification = this.vm.takeNotification()) !== null) {
        // A call is over once its result arrives, whatever it is.
        const call = this.calls.get(notification.handle);
        if (call !== undefined) call.done = true;
        const waiting = this.waiting.get(notification.handle);
        // A handle this attempt did not issue, or settled already: nothing waits for it.
        if (waiting === undefined) continue;
        this.waiting.delete(notification.handle);
        const result = settled(notification);
        if ('error' in result) waiting.reject(result.error);
        else waiting.resolve(result.value);
      }
    } catch (error) {
      this.end(isShutDown(error) ? new AttemptShutDown() : new AttemptFailed(String(error)));
      return;
    }
    // The VM says whether a cancellation arrived, in this attempt or an
    // earlier one; it has no notification of its own.
    if (this.vm.isCancelled()) this.cancelled();
    if (this.vm.state() === 'closed') this.end(new AttemptShutDown());
  }

  /** The attempt ended: fail what still waits, and tell the listeners. */
  private end(reason: Error): void {
    if (this.ended !== undefined) return;
    this.ended = reason;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const one of waiting) one.reject(reason);
    this.stopHeartbeats();
    // Nothing will answer the database's outstanding reads now, and the
    // scheduler holds this driver and the VM alive through the addon.
    this.vm.endStateWaits();
    this.vm.clearScheduler();
    this.aborter.abort(reason);
    const listeners = [...this.onEnd];
    this.onEnd.clear();
    for (const listener of listeners) listener();
  }

  /** Whether the attempt is over, and with what. */
  get over(): Error | undefined {
    return this.ended;
  }

  /** Call `listener` when the attempt ends; the returned function unregisters it. */
  whenEnded(listener: () => void): () => void {
    if (this.ended !== undefined) {
      listener();
      return () => {};
    }
    this.onEnd.add(listener);
    return () => this.onEnd.delete(listener);
  }

  // --- Cancellation

  /**
   * Restate cancelled the invocation. A handler with `explicitCancellation`
   * stops its own work and nothing else happens; otherwise the calls in flight
   * are cancelled and every await of Restate fails, as a cancelled
   * invocation's do.
   */
  private cancelled(): void {
    const first = this.cancelledResolve !== undefined;
    this.cancelledResolve?.();
    this.cancelledResolve = undefined;
    if (!first || this.options.explicitCancellation) return;
    // What the database waits for in the addon — a state read, the ack of a
    // commit's head write — is left to finish. Restate answers those
    // promptly, and failing the ack of a head that is already out would
    // report a commit as cancelled that landed. A call of the database that
    // is in flight completes, and the cancellation goes to what the handler
    // awaits next.
    // The calls in flight are cancelled, which waits for the ids that have not
    // arrived yet: `serveSession` holds the handler's end for it.
    this.cancelling = quiet(this.cancelPreviousCalls().then(() => undefined));
    const failure = new restate.CancelledError();
    // Deleting the entry the loop is on is defined, and a rejection runs its
    // handlers in a later microtask, so nothing is added under the iteration.
    let failedAResult = false;
    for (const [handle, waiting] of this.waiting) {
      // A call's invocation id still settles: cancelling the call needs it.
      if (waiting.waits === 'callId') continue;
      if (waiting.waits === 'result') failedAResult = true;
      this.waiting.delete(handle);
      waiting.reject(failure);
    }
    // Carried only if nothing the handler awaits was failed. A send's id is
    // in `waiting` and is rejected here, but `genericSend` voided it, so the
    // handler saw no cancellation and is still owed its one.
    this.carriedCancellation = !failedAResult;
  }

  /**
   * Whether a cancellation is owed to the handler's next await, which the
   * caller then delivers: the handler's call of its database, before it
   * issues anything, so that a call that fails with the cancellation did
   * nothing.
   */
  takeCarriedCancellation(): boolean {
    // The attempt is over: what the handler does then fails with that, as
    // its awaits of Restate do, and the attempt that follows gets the
    // cancellation.
    if (this.ended !== undefined) return false;
    const carried = this.carriedCancellation;
    this.carriedCancellation = false;
    return carried;
  }

  /** Issuing the cancellations of the calls, if a cancellation started them. */
  get cancellingCalls(): Promise<void> | undefined {
    return this.cancelling;
  }

  /** Resolves once a cancellation arrived, in this attempt or an earlier one. */
  cancellation(): Promise<void> {
    if (this.vm.isCancelled()) this.cancelled();
    return this.cancelledPromise;
  }

  isCancelled(): boolean {
    return this.vm.isCancelled();
  }

  /**
   * Cancel the calls this attempt made that have not answered; returns their
   * ids. A call whose invocation id has not arrived yet is waited for: it was
   * made, so Restate will answer with its id, and leaving it uncancelled would
   * leave an invocation running that nothing waits for any more.
   */
  async cancelPreviousCalls(): Promise<string[]> {
    const cancelled: string[] = [];
    // A snapshot: the loop awaits, and a call made meanwhile is the handler's
    // own business, not one this cancellation set out to stop.
    for (const call of Array.from(this.calls.values())) {
      if (call.done || call.cancelled) continue;
      let id: string;
      try {
        id = await call.id;
      } catch {
        continue; // its id never came: the attempt is over, or the call failed
      }
      if (call.done || call.cancelled) continue;
      call.cancelled = true;
      this.cancel(id);
      cancelled.push(id);
    }
    return cancelled;
  }

  // --- Actions

  /** Call the VM with `act`, then schedule a tick. The attempt's end throws. */
  private act<T>(act: (vm: Vm) => T): T {
    if (this.ended !== undefined) throw this.ended;
    try {
      return act(this.vm);
    } catch (error) {
      if (isShutDown(error)) {
        this.end(new AttemptShutDown());
        throw this.ended;
      }
      throw error;
    } finally {
      this.schedule();
    }
  }

  /** The promise the notification of `handle` settles. */
  private promise(handle: number, waits: Waits = 'result'): Promise<unknown> {
    if (this.ended !== undefined) return quiet(Promise.reject(this.ended));
    // Only a result takes it: see {@link Waits}.
    if (this.carriedCancellation && waits === 'result') {
      this.carriedCancellation = false;
      return quiet(Promise.reject(new restate.CancelledError()));
    }
    return quiet(
      new Promise<unknown>((resolve, reject) => {
        this.waiting.set(handle, { resolve, reject, waits });
      }),
    );
  }

  /**
   * A fire-and-forget action, which an attempt that ended simply drops. The
   * database's store calls these from the addon, where a throw would reach no
   * `catch` of ours and bring the process down; and a write of an attempt that
   * is over cannot be sent anyway, since a new attempt writes it again.
   */
  private tell(act: (vm: Vm) => unknown): void {
    if (this.ended !== undefined) return;
    try {
      this.act(act);
    } catch {
      // The attempt ended under us.
    }
  }

  /** An action and the promise of its result, in one. */
  private issue(act: (vm: Vm) => number): Promise<unknown> {
    let handle: number;
    try {
      handle = this.act(act);
    } catch (error) {
      return quiet(Promise.reject(error instanceof Error ? error : new Error(String(error))));
    }
    return this.promise(handle);
  }

  // --- Calls

  /** A call: the promise of its result, and of its invocation id. */
  call(target: {
    service: string;
    handler: string;
    key?: string;
    input: Uint8Array;
    idempotencyKey?: string;
    headers?: { key: string; value: string }[];
    name?: string;
  }): { result: Promise<Uint8Array | null>; invocationId: Promise<string> } {
    let handles: { invocationId: number; result: number };
    try {
      handles = this.act((vm) =>
        vm.call(
          target.service,
          target.handler,
          target.input,
          target.key,
          target.idempotencyKey,
          target.headers,
          target.name,
        ),
      );
    } catch (error) {
      const rejected = quiet(Promise.reject(error instanceof Error ? error : new Error(String(error))));
      return { result: rejected, invocationId: rejected };
    }
    const invocationId = quiet(this.promise(handles.invocationId, 'callId').then((id) => String(id)));
    const result = quiet(
      this.promise(handles.result).then((value) => (value === undefined ? null : (value as Uint8Array))),
    );
    // Keyed by the result's handle, which is what says the call is over.
    this.calls.set(handles.result, { id: invocationId, done: false, cancelled: false });
    return { result, invocationId };
  }

  /** A send: the promise of the invocation id it was given. */
  send(target: {
    service: string;
    handler: string;
    key?: string;
    input: Uint8Array;
    delay?: number;
    idempotencyKey?: string;
    headers?: { key: string; value: string }[];
    name?: string;
  }): Promise<string> {
    if (this.ended !== undefined) return quiet(Promise.reject(this.ended));
    let handle: number;
    try {
      handle = this.act((vm) =>
        vm.send(
          target.service,
          target.handler,
          target.input,
          target.key,
          target.delay,
          target.idempotencyKey,
          target.headers,
          target.name,
        ),
      );
    } catch (error) {
      // An attempt that ended drops it, as it drops a write: a new attempt
      // sends it again. Anything else is the caller's — a delay that is not a
      // number of milliseconds, say — and throws, as it does on the SDK's
      // context, rather than vanishing into a promise nobody holds.
      if (this.ended !== undefined) return quiet(Promise.reject(this.ended));
      throw error;
    }
    return quiet(this.promise(handle, 'sendId').then((id) => String(id)));
  }

  /** The result of an invocation, once it ends. */
  attach(invocationId: string, name?: string): Promise<Uint8Array | null> {
    return quiet(
      this.issue((vm) => vm.attachInvocation(invocationId, name)).then((value) =>
        value === undefined ? null : (value as Uint8Array),
      ),
    );
  }

  cancel(invocationId: string, name?: string): void {
    this.tell((vm) => vm.cancelInvocation(invocationId, name, false));
  }

  // --- Traces, shown in Restate's UI as runs

  startTrace(name: string, parent?: number): number {
    return this.act((vm) => vm.startTrace(name, parent));
  }

  endTrace(trace: number, output: Uint8Array): void {
    this.act((vm) => vm.endTraceSuccess(trace, output));
  }

  // --- Keeping an attempt at work alive
  //
  // Restate shuts an attempt down once its inactivity timeout passes with
  // nothing heard. That is the default: the attempt suspends on what it waits
  // for (or, waiting for nothing, starts again at once), and a wait of days
  // holds no process. Work that must not be cut off says so with `working`:
  // while any of it runs, the attempt heartbeats, whatever else it waits for.

  /**
   * Run `fn`, keeping the attempt alive meanwhile: one heartbeat every
   * `everyMs` from the first scope opening to the last closing. The first
   * comes at once if the attempt has been silent for `everyMs` already (most
   * of the timeout may be gone), so the silence never reaches twice that;
   * otherwise the scopes the database opens for each of its calls would each
   * send one.
   */
  async working<T>(fn: () => T | Promise<T>, everyMs = (this.beatEvery ??= heartbeatMs())): Promise<T> {
    if (this.scopes++ === 0) this.startHeartbeats(everyMs);
    try {
      return await fn();
    } finally {
      this.scopes--;
    }
  }

  /**
   * A run of scopes opens. Its beats are `everyMs` after it opened, and every
   * `everyMs` while a scope stays open: the timer is armed for the first, and
   * on firing it beats if the run it finds is that old, waits out the rest if
   * a run that opened later is younger, and is let go if no scope is open.
   */
  private startHeartbeats(everyMs: number): void {
    if (this.ended !== undefined) return;
    const now = Date.now();
    if (now - this.wroteAt >= everyMs) this.heartbeat();
    this.runEvery = everyMs;
    this.nextBeat = now + everyMs;
    this.arm(this.nextBeat);
  }

  /** Arm the timer for `due`, unless it is armed for that or earlier. */
  private arm(due: number): void {
    if (this.heartbeats !== undefined) {
      if (this.beatDue <= due) return;
      clearTimeout(this.heartbeats);
    }
    this.beatDue = due;
    this.heartbeats = setTimeout(() => this.beat(), Math.max(0, due - Date.now()));
    this.heartbeats.unref?.();
  }

  /** The timer fired. */
  private beat(): void {
    this.heartbeats = undefined;
    if (this.ended !== undefined || this.scopes === 0) return;
    const now = Date.now();
    if (now >= this.nextBeat) {
      this.heartbeat();
      this.nextBeat = now + this.runEvery;
    }
    this.arm(this.nextBeat);
  }

  private heartbeat(): void {
    if (this.ended !== undefined) return;
    try {
      this.act((vm) => vm.heartbeat());
    } catch {
      // The attempt ended: the tick notices.
    }
  }

  private stopHeartbeats(): void {
    if (this.heartbeats === undefined) return;
    clearTimeout(this.heartbeats);
    this.heartbeats = undefined;
  }

  // --- The input, and the end

  /** The invocation's input, read from the VM once. */
  private input(): VmInput {
    this.theInput ??= this.vm.input();
    return this.theInput;
  }

  /** The invocation's key, once the VM is ready to execute. */
  get key(): string {
    return this.input().key;
  }

  /** The handler's input. */
  get body(): Uint8Array {
    return this.input().input;
  }

  /** The invocation's request, as a handler's `ctx.request` has it. */
  request(attemptHeaders: ReadonlyMap<string, string | string[] | undefined> = new Map()): restate.Request {
    const input = this.input();
    const target = {
      service: this.options.service,
      handler: this.options.handler,
      key: input.key || undefined,
      toString(): string {
        return this.key === undefined
          ? `${this.service}/${this.handler}`
          : `${this.service}/${this.key}/${this.handler}`;
      },
    };
    return {
      target,
      id: input.invocationId,
      headers: new Map(input.headers.map(({ key, value }) => [key, value])),
      attemptHeaders,
      body: input.input,
      extraArgs: [],
      idempotencyKey: input.idempotencyKey,
      scope: input.scope,
      limitKey: input.limitKey,
      attemptCompletedSignal: this.aborter.signal,
    } as unknown as restate.Request;
  }

  /** The handler ended with its output. */
  endSuccess(output: Uint8Array): void {
    this.last((vm) => vm.endSuccess(output));
  }

  /** The handler ended with a terminal failure. */
  endFailure(error: restate.TerminalError): void {
    this.last((vm) =>
      vm.endFailure({
        code: (error as { code?: number }).code ?? 500,
        message: error.message,
        metadata: Object.entries(error.metadata ?? {}).map(([key, value]) => ({ key, value })),
      }),
    );
  }

  /** The attempt failed, and Restate retries it. */
  fail(message: string, stacktrace?: string, retryAfterMs?: number): void {
    if (this.ended !== undefined) return;
    this.vm.notifyError(message, stacktrace, retryAfterMs);
    this.schedule();
  }

  /** End the attempt with `act`, unless it ended already. */
  private last(act: (vm: Vm) => void): void {
    if (this.ended !== undefined) return;
    try {
      act(this.vm);
    } catch {
      // The attempt ended under us: the VM wrote why.
    }
    this.schedule();
  }
}
