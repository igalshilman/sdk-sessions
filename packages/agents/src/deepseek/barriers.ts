// The adapter's own barriers before the harness's effects. The session
// checkpoint policy flushes before each model request and each tool body, but
// those flushes are soft (persistence.ts): what the adapter stores, it stores
// itself, right before the effect starts, so that nothing the harness or a
// plugin does can come between the write and the effect.
//
// A tool's body is wrapped where the adapter registers the tool (`tracked` of
// index.ts: its `execute` is the last thing before the body, for a nested call
// too). The model's request has no such place, as the model adapter is a
// plugin's: the barrier is the innermost `llm/stream` listener, run right
// before the adapter's stream starts. Listeners run outermost first, and the
// one registered last is the innermost: so each request checks that the
// barrier is still the last registered, and fails the request if a listener
// was added after it.
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SqlSessionPersistence } from './persistence.ts';

/** What the event service keeps of a listener (cordis's `Hook`): the barrier's is marked. */
interface Hook {
  barrier?: symbol;
}

/** The mark of the barrier's listener. */
const BARRIER = Symbol('the adapter barrier before a model request');

/** The `llm/stream` listeners, in the order they run: outermost first, `undefined` if the harness does not keep them so. */
const listeners = (harness: Context): Hook[] | undefined => {
  const hooks = Reflect.get(harness.events, '_hooks') as Record<string, unknown> | undefined;
  const found = hooks?.['llm/stream'];
  return Array.isArray(found) ? (found as Hook[]) : undefined;
};

/** Whether the barrier is the innermost `llm/stream` listener. */
const innermost = (harness: Context) => listeners(harness)?.at(-1)?.barrier === BARRIER;

/**
 * Store the events of each model request's session right before its stream
 * starts, as the innermost `llm/stream` listener; a request is not made if
 * they are not stored, nor if a listener came after the barrier. Returns
 * whether the barrier is installed, and innermost: if not (the hooks are not
 * where they were), it is removed and the harness's flushes must stay writes.
 */
export function guardModelRequests(harness: Context, persistence: SqlSessionPersistence): boolean {
  const dispose = harness.on(
    'llm/stream',
    (options: { sessionId?: SessionId }, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
      const { sessionId } = options;
      if (sessionId === undefined) return next();
      return (async function* () {
        if (!innermost(harness)) throw new Error('deepseek: a listener of llm/stream runs after the barrier');
        await persistence.writeNow(sessionId);
        yield* next();
      })();
    },
    { barrier: BARRIER } as never,
  );
  if (innermost(harness)) return true;
  // Not where it must be: left in, it would fail every request, not leave the flushes writes.
  dispose();
  return false;
}
