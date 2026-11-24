// The adapter's barriers before the harness's effects (../src/deepseek/barriers.ts), and what happens without them:
// the harness's flushes then stay writes. `pnpm --filter @restatedev/agents test deepseek-barriers`.
import { Context } from '@deepseek-ai/cordis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as barriers from '../src/deepseek/barriers.ts';
import type { SqlSessionPersistence } from '../src/deepseek/persistence.ts';
import { turn } from './deepseek-turn.ts';
import { reply as tellerReply, teller } from './fakes/deepseek.ts';

vi.mock('@deepseek-ai/dsh-llm-deepseek-api-key', () => import('./fakes/deepseek.ts'));

// The barrier itself, not the one the turns below run with.
const { guardModelRequests } = await vi.importActual<typeof barriers>('../src/deepseek/barriers.ts');

// Whether the barrier of a model request is installed: the next test turns it off.
const installed = vi.hoisted(() => ({ value: true }));
vi.mock('../src/deepseek/barriers.ts', async (original) => {
  const actual = await original<typeof barriers>();
  return {
    ...actual,
    guardModelRequests: (...args: Parameters<typeof actual.guardModelRequests>) => (
      actual.guardModelRequests(...args),
      installed.value
    ),
  };
});

/** A listener of `llm/stream` that says it ran. */
const listener = (order: string[], name: string) =>
  ((_options: unknown, next: () => AsyncIterable<number>) => (order.push(name), next())) as never;

/** A harness with `before` listeners of `llm/stream`, the barrier, and a persistence that says what it stores; the order things run in. */
function harnessWith(before: string[], { writes = [] as string[], failing = false } = {}) {
  const order: string[] = [];
  const harness = new Context();
  for (const name of before) harness.on('llm/stream', listener(order, name));
  const persistence = {
    writeNow: async (id: string) => {
      order.push(`write ${id}`);
      writes.push(id);
      if (failing) throw new Error('not stored');
    },
  } as unknown as SqlSessionPersistence;
  const installedHere = guardModelRequests(harness, persistence);
  const stream = (options: { sessionId?: string }) =>
    harness.waterfall('llm/stream', options as never, () =>
      (async function* () {
        order.push('adapter');
        yield 1;
      })(),
    ) as AsyncIterable<number>;
  return { harness, order, installedHere, stream };
}

const drain = async (chunks: AsyncIterable<number>) => {
  for await (const chunk of chunks) void chunk;
};

describe("the barrier of a model request's stream", () => {
  it('is the innermost listener: it runs after every other, right before the adapter', async () => {
    const { order, installedHere, stream } = harnessWith(['keptAlive', 'policy', 'compaction']);
    expect(installedHere).toBe(true);
    await drain(stream({ sessionId: 's' }));
    expect(order).toEqual(['keptAlive', 'policy', 'compaction', 'write s', 'adapter']);
  });

  it('does not start the adapter when the write fails', async () => {
    const { order, stream } = harnessWith(['policy'], { failing: true });
    await expect(drain(stream({ sessionId: 's' }))).rejects.toThrow('not stored');
    expect(order).toEqual(['policy', 'write s']);
  });

  it('does not start the adapter when a listener was registered after it', async () => {
    const { harness, order, installedHere, stream } = harnessWith(['policy']);
    expect(installedHere).toBe(true);
    harness.on('llm/stream', listener(order, 'late'));
    await expect(drain(stream({ sessionId: 's' }))).rejects.toThrow('runs after the barrier');
    expect(order).not.toContain('adapter');
    expect(order).not.toContain('write s');
  });

  it('is removed when it cannot be told to be innermost: the stream still reaches the adapter, and the flushes stay writes', async () => {
    const order: string[] = [];
    const harness = new Context();
    // A harness that does not keep the mark of the listener, as one whose listeners are kept otherwise.
    const unmarked = new Proxy(harness, {
      get: (target, key) =>
        key === 'on' ? (name: string, fn: never) => target.on(name as 'llm/stream', fn) : Reflect.get(target, key),
    });
    const writes: string[] = [];
    const persistence = { writeNow: async (id: string) => void writes.push(id) } as unknown as SqlSessionPersistence;
    expect(guardModelRequests(unmarked, persistence)).toBe(false);
    harness.on('llm/stream', listener(order, 'plugin'));
    const stream = harness.waterfall('llm/stream', { sessionId: 's' } as never, () =>
      (async function* () {
        order.push('adapter');
        yield 1;
      })(),
    ) as AsyncIterable<number>;
    await drain(stream);
    expect(order).toEqual(['plugin', 'adapter']);
    expect(writes).toEqual([]);
  });

  it('is not installed where the harness keeps no listeners as it does: the flushes stay writes', () => {
    const harness = { on: () => () => {}, events: {} } as unknown as Context;
    expect(guardModelRequests(harness, {} as SqlSessionPersistence)).toBe(false);
  });

  it('lets a request without a session through', async () => {
    const { order, stream } = harnessWith([]);
    await drain(stream({}));
    expect(order).toEqual(['adapter']);
  });
});

describe('a DeepSeek turn without its barriers', () => {
  afterAll(() => {
    installed.value = true;
    teller.reply = tellerReply;
  });

  it('writes at every flush of the harness, as before: 14 commits on the reference turn, an effect after each write', async () => {
    installed.value = false;
    const { log, effects, result } = await turn(3);
    expect(result).toBe('Done');
    expect(log).toHaveLength(14);
    // Each effect follows a write.
    const before = effects.flatMap((e, i) => (e === 'M' || e === 'T' ? [effects[i - 1]] : []));
    expect(before.every((e) => e?.startsWith('C(events'))).toBe(true);
  });
});
