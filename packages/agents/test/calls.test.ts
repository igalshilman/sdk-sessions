// The call records (calls.ts): a tool call's Restate calls made once, a
// framework's own waits (`waitFor`), and what a stopped turn reports of its
// calls (`outcomes`). As the Python SDK's tests of `_calls.py`.
import { type AttemptContext, contextOf } from '@restatedev/sessions/internal';
import { memoryDatabase } from '@restatedev/sessions/test/support';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { call, signal } from '@restatedev/agents';
import * as restate from '@restatedev/sessions';
import { callOf, outcomes } from '../src/calls.ts';
import { waitFor } from '../src/tools.ts';

const lookups = restate.service({ name: 'lookups', handlers: { lookup: async (_ctx, _about: unknown) => 'found' } });

/** An attempt of invocation `id`, keyed `alice`, over the object's database `state`: what it calls, and its context. */
function attempt(state: Map<string, Uint8Array>, id = 'inv1', answer: (method: string) => unknown = () => 'approved') {
  const made: { service: string; method: string; parameter: unknown; idempotencyKey?: string }[] = [];
  const sdk = {
    key: 'alice',
    request: () => ({ id, target: { service: 'waiter', handler: 'chat', key: 'alice' } }),
    genericCall: async (c: { service: string; method: string; parameter: unknown; idempotencyKey?: string }) => {
      made.push({ service: c.service, method: c.method, parameter: c.parameter, idempotencyKey: c.idempotencyKey });
      return answer(c.method);
    },
    genericSend: () => {},
  };
  const ctx = contextOf(sdk as unknown as AttemptContext, memoryDatabase(state));
  return { ctx, made };
}

/** The records stored, as the next attempt of `id` reads them. */
async function records(state: Map<string, Uint8Array>, id = 'inv1') {
  const { ctx } = attempt(state, id);
  const row = await ctx.db.get<{ invocation: string; calls: string }>(
    'SELECT invocation, calls FROM restate_agent_calls',
  );
  return row?.invocation === id ? (JSON.parse(row.calls) as { tool: string; ids: string[]; approval?: true }[]) : [];
}

describe('call records', () => {
  it("are found by the call's id and its tool: an approval and its tool call's Restate call keep one each", async () => {
    const state = new Map<string, Uint8Array>();
    const { ctx, made } = attempt(state);
    expect(await waitFor(ctx, 'c1', 'approval', { refund: 5 }, { approval: true })).toBe('approved');
    // Once approved, the tool makes its own Restate call, under the same tool call id.
    const lookup = call(lookups, 'lookup', { description: 'Look it up', input: z.object({ about: z.string() }) });
    await lookup.run({ about: 'x' }, { ctx, callId: 'c1' });
    expect(made.map((m) => [m.service, m.method, m.idempotencyKey])).toEqual([
      ['signals', 'wait', 'inv1:c1'],
      ['lookups', 'lookup', 'inv1:c1'],
    ]);
    expect((await records(state)).map((c) => [c.tool, c.ids, c.approval])).toEqual([
      ['signal/approval', ['c1'], true],
      ['lookups/lookup', ['c1'], undefined],
    ]);
    // The tool call's own call returned: that is its outcome, whatever the approval's.
    expect(await outcomes(ctx, ['c1'])).toEqual(new Map([['c1', undefined]]));
  });

  it('rejoin, for a Restate tool, the call another attempt made with the same input, under a new id', async () => {
    const state = new Map<string, Uint8Array>();
    const lookup = call(lookups, 'lookup', { description: 'Look it up', input: z.object({ about: z.string() }) });
    await lookup.run({ about: 'x' }, { ctx: attempt(state).ctx, callId: 't1' });
    const next = attempt(state);
    await lookup.run({ about: 'x' }, { ctx: next.ctx, callId: 't2' });
    expect(next.made.map((m) => m.idempotencyKey)).toEqual(['inv1:t1']);
  });

  it('match an input whatever the order of its keys', async () => {
    const state = new Map<string, Uint8Array>();
    await callOf(attempt(state).ctx, 'pay', { to: 'bob', amount: 5 }, 't1');
    const again = await callOf(attempt(state).ctx, 'pay', { amount: 5, to: 'bob' }, 't2');
    expect(again.id).toBe('t1');
  });
});

describe('waitFor', () => {
  it('waits for a signal for its own tool call once: run again, it joins its wait; a new call waits anew', async () => {
    const state = new Map<string, Uint8Array>();
    const first = attempt(state);
    expect(await waitFor(first.ctx, 'call-1', 'approval', { refund: 5 })).toBe('approved');
    expect(first.made).toEqual([
      {
        service: 'signals',
        method: 'wait',
        parameter: { id: 'inv1:call-1', name: 'approval', input: { refund: 5 } },
        idempotencyKey: 'inv1:call-1',
      },
    ]);
    // The tool call runs again (after a crash, say): it joins the same wait.
    const again = attempt(state);
    await waitFor(again.ctx, 'call-1', 'approval', { refund: 5 });
    expect(again.made.map((m) => m.idempotencyKey)).toEqual(['inv1:call-1']);
    // A new call with the same input, in a later attempt (the model asks
    // again, after the first's answer): its own wait.
    const later = attempt(state);
    await waitFor(later.ctx, 'call-2', 'approval', { refund: 5 });
    expect(later.made.map((m) => m.idempotencyKey)).toEqual(['inv1:call-2']);
  });

  it('keeps a record of each of the waits opened at once', async () => {
    const state = new Map<string, Uint8Array>();
    const { ctx } = attempt(state, 'inv1', () => true);
    await Promise.all(['c1', 'c2', 'c3'].map((id) => waitFor(ctx, id, 'approval')));
    expect((await records(state)).map((c) => c.ids[0]).toSorted((a, b) => a!.localeCompare(b!))).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });

  it('shows no input when given none', async () => {
    const { ctx, made } = attempt(new Map(), 'inv1', () => true);
    expect(await waitFor(ctx, 'call-1', 'approval')).toBe(true);
    expect(made[0]?.parameter).toEqual({ id: 'inv1:call-1', name: 'approval' });
  });

  it('is not what a `signal` tool is: that one rejoins an earlier attempt’s wait by its input', async () => {
    const state = new Map<string, Uint8Array>();
    const approval = signal('approval', { description: 'Wait', input: z.object({ refund: z.number() }) });
    await approval.run({ refund: 5 }, { ctx: attempt(state).ctx, callId: 'call-1' });
    const next = attempt(state);
    await approval.run({ refund: 5 }, { ctx: next.ctx, callId: 'call-2' });
    expect(next.made.map((m) => m.idempotencyKey)).toEqual(['inv1:call-1']);
  });
});

describe('outcomes', () => {
  it('reports each call that returned, with its error if it failed; not one made and not returned', async () => {
    const { ctx } = attempt(new Map());
    await (await callOf(ctx, 'refund', { order: 'o1' }, 'call-refund')).answered();
    await callOf(ctx, 'status', { order: 'o1' }, 'call-status'); // made, but not returned
    await (await callOf(ctx, 'charge', { order: 'o1' }, 'call-charge')).answered('Error: card declined');
    expect(await outcomes(ctx, ['call-refund', 'call-status', 'call-charge', 'call-none'])).toEqual(
      new Map([
        ['call-refund', undefined],
        ['call-charge', 'Error: card declined'],
      ]),
    );
  });

  it("never reports an approval that returned as its call's outcome", async () => {
    const { ctx } = attempt(new Map(), 'inv1', () => 'no');
    expect(await waitFor(ctx, 'c1', 'approval', { refund: 5 }, { approval: true })).toBe('no');
    expect(await outcomes(ctx, ['c1'])).toEqual(new Map());
  });

  it('reports a wait that returned, which is not an approval, as done', async () => {
    const { ctx } = attempt(new Map(), 'inv1', () => 'no');
    await waitFor(ctx, 'c1', 'lookup', { about: 'x' });
    expect(await outcomes(ctx, ['c1'])).toEqual(new Map([['c1', undefined]]));
  });

  it("reads an earlier invocation's records while they are stored, and changes nothing", async () => {
    const state = new Map<string, Uint8Array>();
    await (await callOf(attempt(state, 'inv1').ctx, 'refund', {}, 'c1')).answered();
    const later = attempt(state, 'inv2');
    expect(await outcomes(later.ctx, ['c1'], 'inv1')).toEqual(new Map([['c1', undefined]]));
    expect(await outcomes(later.ctx, ['c1'])).toEqual(new Map());
    expect(await records(state, 'inv1')).toHaveLength(1);
    // Once the later invocation makes calls of its own, the earlier's are gone.
    await callOf(later.ctx, 'refund', {}, 'c9');
    expect(await outcomes(attempt(state, 'inv2').ctx, ['c1'], 'inv1')).toEqual(new Map());
  });
});
