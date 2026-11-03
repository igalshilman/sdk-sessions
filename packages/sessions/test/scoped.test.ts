// What this package and the libraries over it keep per object (scoped.ts):
// on the object, so that nothing outlives it, and a module holds only keys.
import * as restate from '@restatedev/sessions';
import { definitionOf, Scoped } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { sqlAttempt } from './support.ts';

describe('scoped state', () => {
  it('is kept per object, and per key', () => {
    const count = new Scoped<number>('count');
    const other = new Scoped<number>('other');
    const [a, b] = [{}, {}];
    count.set(a, 1);
    other.set(a, 2);
    expect([count.get(a), other.get(a), count.get(b)]).toEqual([1, 2, undefined]);
    expect(count.of(b, () => 3)).toBe(3);
    expect(count.of(b, () => 4)).toBe(3);
    count.delete(a);
    expect(count.get(a)).toBeUndefined();
  });

  it("is kept on a handler's context and its ctx.db, frozen as they are", () => {
    const turn = new Scoped<string>('turn');
    const { ctx, view } = sqlAttempt({ map: new Map() });
    expect(Object.isFrozen(ctx) && Object.isFrozen(view.db)).toBe(true);
    turn.set(ctx, 'mine');
    turn.set(view.db, 'the view’s');
    expect([turn.get(ctx), turn.get(view.db)]).toEqual(['mine', 'the view’s']);
    // Another attempt's context holds none of it.
    expect(turn.get(sqlAttempt({ map: new Map() }).ctx)).toBeUndefined();
  });

  it('reads nothing of a frozen object of no one’s, and refuses to keep anything on it', () => {
    const turn = new Scoped<string>('turn');
    const frozen = Object.freeze({});
    expect(turn.get(frozen)).toBeUndefined();
    expect(() => turn.set(frozen, 'x')).toThrow(/turn: not an object of @restatedev\/sessions/);
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
