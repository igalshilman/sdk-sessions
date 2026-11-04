// An attempt's scope (scope.ts): what an attempt's code keeps for it, held by
// its context, so that it ends with the attempt; a module holds only keys.
import * as restate from '@restatedev/sessions';
import { definitionOf, ScopeKey } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { sqlAttempt } from './support.ts';

describe("an attempt's scope", () => {
  it('keeps a value per key, on the frozen context', () => {
    const count = new ScopeKey<number>('count');
    const other = new ScopeKey<number>('other');
    const { ctx } = sqlAttempt({ map: new Map() });
    expect(Object.isFrozen(ctx)).toBe(true);
    count.set(ctx, 1);
    other.set(ctx, 2);
    expect([count.get(ctx), other.get(ctx)]).toEqual([1, 2]);
    expect(other.of(ctx, () => 3)).toBe(2);
    count.delete(ctx);
    expect(count.of(ctx, () => 4)).toBe(4);
    // Not one of the context's fields.
    expect(Object.keys(ctx)).not.toContain('scope');
  });

  it('is an attempt’s own: another attempt starts with none of it', () => {
    const turn = new ScopeKey<string>('turn');
    const first = sqlAttempt({ map: new Map() });
    turn.set(first.ctx, 'first');
    expect(turn.get(sqlAttempt({ map: new Map() }).ctx)).toBeUndefined();
  });

  it('is only a context’s', () => {
    const turn = new ScopeKey<string>('turn');
    expect(() => turn.get({} as restate.SessionContext)).toThrow(
      /turn takes the context of a session object's handler or view/,
    );
  });
});

describe('definitionOf', () => {
  it("gives a handler's context the definition of its object, where a library keeps what is the object's", () => {
    const notes = restate.sessionObject({ name: 'notes', handlers: {}, views: {} });
    const { ctx, view } = sqlAttempt({ map: new Map(), object: notes });
    expect(definitionOf(ctx)).toBe(notes);
    expect(definitionOf(view)).toBe(notes);
    expect(definitionOf(sqlAttempt({ map: new Map() }).ctx)).toBeUndefined();
  });
});
