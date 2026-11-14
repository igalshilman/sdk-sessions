// What `restate.connect` hands the Restate SDK: the services given, each with
// what it needs beside it. The SDK's own `connect` binds exactly what it is
// given, which left every agent without its companion.
import type * as sdk from '@restatedev/restate-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connected } = vi.hoisted(() => ({ connected: vi.fn<(options: unknown) => unknown>() }));

vi.mock('@restatedev/restate-sdk', async (original) => ({
  ...(await original<typeof sdk>()),
  connect: connected,
}));

const restate = await import('@restatedev/sessions');
const { needing } = await import('@restatedev/sessions/internal');

const companion = restate.object({ name: 'notes.prebuilt.restate', handlers: {} });
const agent = needing(restate.sessionObject({ name: 'notes', handlers: { add: async () => {} } }), () => [companion]);
const lists = restate.sessionObject({ name: 'lists', handlers: { add: async () => {} } });

/** The options the SDK's `connect` was called with. */
const options = () => connected.mock.calls[0]![0] as { services: { name: string }[]; name?: string };

describe('restate.connect', () => {
  beforeEach(() => {
    connected.mockClear();
    delete process.env.RESTATE_SERVE_ONLY;
  });

  it('binds the companion the SDK would have left out, and passes the rest through', () => {
    restate.connect({ services: [agent], name: 'notes-v1' });
    expect(options().services.map((s) => s.name)).toEqual(['notes', 'notes.prebuilt.restate']);
    expect(options().name).toBe('notes-v1');
  });

  it('honours RESTATE_SERVE_ONLY, each named service with what it needs', () => {
    process.env.RESTATE_SERVE_ONLY = 'notes';
    restate.connect({ services: [agent, lists], name: 'notes-v1' });
    expect(options().services.map((s) => s.name)).toEqual(['notes', 'notes.prebuilt.restate']);
  });

  it('refuses a remote handle, as serving one does', () => {
    const workspace = restate.remote.object<sdk.VirtualObjectDefinition<'workspace', unknown>>('workspace');
    expect(() => restate.connect({ services: [workspace], name: 'x' })).toThrow(/workspace: a remote handle/);
    expect(connected).not.toHaveBeenCalled();
  });
});
