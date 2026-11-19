// pi-durable makes a model's request in this process, through the model
// registry (`runtime.models`): `streamSimple` for a turn's request, `fetchDeferred`
// for one a provider answers later, `completeSimple` for a compaction's. A
// request keeps the attempt alive (`ctx.working`) from its call to its end.
// `Harness.open({ models })` takes the registry, so each of its requests is
// covered by wrapping it, with nothing of pi-durable's own patched.
import type { Models } from '@earendil-works/pi-ai';
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import type * as restate from '@restatedev/sessions';
import { keepAlive } from '../common.ts';

/** `Models`' methods that return an event stream: the request is out as it is called, and ends with the stream. */
const STREAMS = new Set<PropertyKey>(['stream', 'streamSimple', 'streamDeferred']);

/** `Models`' methods that return a promise of the request's result: the request is out until it settles. */
const REQUESTS = new Set<PropertyKey>([
  'complete',
  'completeSimple',
  'fetchDeferred',
  'cancelDeferred',
  'generateImages',
  'classify',
]);

/**
 * `stream`, kept alive until its response is over: it ends or fails (its
 * `result()` settles: pi-ai ends a stream that is aborted with an error
 * event), its consumer leaves it early, or `signal` aborts.
 */
function keptStream(
  ctx: restate.SessionContext,
  stream: AssistantMessageEventStream,
  signal: AbortSignal | undefined,
): AssistantMessageEventStream {
  const release = keepAlive(ctx);
  stream.result().then(release, release);
  signal?.addEventListener('abort', release, { once: true });
  if (signal?.aborted) release();
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  // A consumer that stops iterating (a `break`, a throw) abandons the stream: the response is not waited for.
  stream[Symbol.asyncIterator] = () => {
    const iterator = iterate();
    return {
      next: (...args) => iterator.next(...args),
      return: (value) => {
        release();
        return iterator.return?.(value) ?? Promise.resolve({ done: true as const, value });
      },
      throw: async (error) => {
        release();
        if (iterator.throw) return iterator.throw(error);
        throw error;
      },
    };
  };
  return stream;
}

/** `models`, each request of whose methods keeps the attempt of `ctx` alive as long as it is out. */
export function keptModels<M extends Models>(ctx: restate.SessionContext, models: M): M {
  return new Proxy(models, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      const method = member.bind(target) as (...args: unknown[]) => unknown;
      if (STREAMS.has(property)) {
        return (...args: unknown[]) => {
          const options = args.at(-1) as { signal?: AbortSignal } | undefined;
          return keptStream(ctx, method(...args) as AssistantMessageEventStream, options?.signal);
        };
      }
      if (REQUESTS.has(property)) return (...args: unknown[]) => ctx.working(() => method(...args) as Promise<unknown>);
      return method;
    },
  });
}
