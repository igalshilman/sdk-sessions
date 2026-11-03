// An object's schema (schema.ts of @restatedev/sessions), without a Restate server: its
// steps, applied once per key by the handlers that open its database.
import { randomUUID } from 'node:crypto';
import * as restate from '@restatedev/sessions';
import { open, Schema } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { memoryStore, sqlAttempt } from './support.ts';

/** An object of its own, its schema `steps`; with `name`, a version of that object. */
const objectWith = (steps: restate.Step[], name = `schema-${randomUUID()}`) =>
  restate.sessionObject({ name, schema: steps, handlers: {}, views: {} });

const NOTES = 'CREATE TABLE notes (text TEXT NOT NULL)';

/** How many steps of the schema `name` the database in `map` has, as stored: its record. */
async function stepsOf(map: Map<string, Uint8Array>, name: string) {
  const db = await open(`schema-${randomUUID()}`, memoryStore(map));
  const record = await db.record('schema');
  await db.close();
  const applied = record.length === 0 ? {} : (JSON.parse(new TextDecoder().decode(record)) as Record<string, number>);
  return applied[name] === undefined ? '' : String(applied[name]);
}

const TABLES = "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name";

/** A step of data: the notes so far are done. */
const done = (tx: restate.DatabaseWriter) => tx.execute('UPDATE notes SET done = 1');

describe("an object's schema", () => {
  it('is applied once, where a key is first opened', async () => {
    const object = objectWith([NOTES]);
    const service = object.name;
    const map = new Map<string, Uint8Array>();
    const first = sqlAttempt({ map, object });
    await first.end(() => first.db.execute("INSERT INTO notes VALUES ('milk')"));
    const later = sqlAttempt({ map, object, id: 'later' });
    // The database holds the object's tables, and only them: how far the
    // schema got is a record beside them.
    expect(await later.end(() => later.db.values(TABLES))).toEqual([['notes']]);
    expect(await stepsOf(map, service)).toBe('1');
  });

  it('runs a step added later on each existing database, once', async () => {
    const object = objectWith([NOTES]);
    const service = object.name;
    const map = new Map<string, Uint8Array>();
    const first = sqlAttempt({ map, object });
    await first.end(() => first.db.execute("INSERT INTO notes VALUES ('milk')"));
    const v2 = objectWith([NOTES, 'ALTER TABLE notes ADD COLUMN done INT', done], service);
    const later = sqlAttempt({ map, object: v2, id: 'later' });
    expect(await later.end(() => later.db.values('SELECT text, done FROM notes'))).toEqual([['milk', 1]]);
  });

  it('reads a key never written as empty tables, in a shared handler, storing nothing', async () => {
    const object = objectWith([NOTES]);
    const map = new Map<string, Uint8Array>();
    const reader = sqlAttempt({ map, object, shared: true });
    expect(await reader.end(() => reader.db.values('SELECT text FROM notes'))).toEqual([]);
    expect(map.size).toBe(0);
  });

  it('is applied by a writer after a shared handler read a key never written', async () => {
    const object = objectWith([NOTES]);
    const map = new Map<string, Uint8Array>();
    const reader = sqlAttempt({ map, object, shared: true, id: 'reader' });
    await reader.end(() => reader.db.values('SELECT text FROM notes'));
    const writer = sqlAttempt({ map, object, id: 'writer' });
    await writer.end(() => writer.db.execute("INSERT INTO notes VALUES ('milk')"));
    const later = sqlAttempt({ map, object, id: 'later' });
    expect(await later.end(() => later.db.values('SELECT text FROM notes'))).toEqual([['milk']]);
  });
});

describe('a schema step that fails', () => {
  it('fails the invocation for good, leaves the database as it was, and a fixed step runs once', async () => {
    const object = objectWith([NOTES]);
    const service = object.name;
    const map = new Map<string, Uint8Array>();
    const first = sqlAttempt({ map, object });
    await first.end(() => first.db.execute("INSERT INTO notes VALUES ('milk')"));
    // v2: a column, then a step that fails. The steps a database lacks run in
    // one transaction, so the column goes with the failure.
    const v2 = objectWith([NOTES, 'ALTER TABLE notes ADD COLUMN done INT', 'INSERT INTO missing VALUES (1)'], service);
    const failing = sqlAttempt({ map, object: v2, id: 'failing' });
    // An SQL error, so terminal: every invocation of the key fails until a fix is deployed.
    await expect(failing.end(() => failing.db.values('SELECT text FROM notes'))).rejects.toThrow(
      expect.objectContaining({ name: 'TerminalError', message: expect.stringMatching(/no such table: missing/) }),
    );
    expect(await stepsOf(map, service)).toBe('1');
    // Rolled back to v1: its code finds its database as it left it.
    const v1 = sqlAttempt({ map, object, id: 'v1' });
    expect(await v1.end(() => v1.db.values("SELECT name FROM pragma_table_info('notes')"))).toEqual([['text']]);
    // v3 fixes the step: it runs once, with the column.
    const v3 = objectWith([NOTES, 'ALTER TABLE notes ADD COLUMN done INT', done], service);
    const fixed = sqlAttempt({ map, object: v3, id: 'fixed' });
    expect(await fixed.end(() => fixed.db.values('SELECT text, done FROM notes'))).toEqual([['milk', 1]]);
    expect(await stepsOf(map, service)).toBe('3');
  });
});

describe("a library's schema", () => {
  const LIBRARY = new Schema('library', ['CREATE TABLE library_items (item TEXT)']);

  it('is ensured where it is used, beside the object’s own', async () => {
    const object = objectWith([NOTES]);
    const service = object.name;
    const map = new Map<string, Uint8Array>();
    const attempt = sqlAttempt({ map, object });
    const tables = await attempt.end(async () => {
      await LIBRARY.ensure(attempt.db);
      await attempt.db.execute("INSERT INTO library_items VALUES ('a')");
      return attempt.db.values(TABLES);
    });
    expect(tables).toEqual([['library_items'], ['notes']]);
    expect([await stepsOf(map, 'library'), await stepsOf(map, service)]).toEqual(['1', '1']);
  });

  it('is applied once when ensured twice at once', async () => {
    const map = new Map<string, Uint8Array>();
    const attempt = sqlAttempt({ map });
    await attempt.end(() => Promise.all([LIBRARY.ensure(attempt.db), LIBRARY.ensure(attempt.db)]));
    expect(await stepsOf(map, 'library')).toBe('1');
  });

  it('is a shared handler’s own: empty, and stored nowhere', async () => {
    const map = new Map<string, Uint8Array>();
    const reader = sqlAttempt({ map, shared: true });
    const rows = await reader.end(async () => {
      await LIBRARY.ensure(reader.db);
      return reader.db.values('SELECT item FROM library_items');
    });
    expect(rows).toEqual([]);
    expect(map.size).toBe(0);
  });
});
