// One process's session of a database whose Restate state is a file, for
// object-store-l0.test.ts: the variables the addon reads once a process
// (RESTATE_SQL_OBJECT_STORE, RESTATE_SQL_L0_BYTES, RESTATE_SQL_CACHE) are
// this process's own. It opens the database, checks every row it reads, adds
// `add` rows (1 KiB each that does not compress, a commit each), stores the
// state back, and prints as JSON the rows it read, or the open's error.
// Usage: node object-store-process.ts <state file> <namespace> <add>
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from '@restatedev/sessions/internal';

const [file = '', namespace = '', add = '0'] = process.argv.slice(2);

/** Row `id`'s value, the same in every process. */
function row(id: number): Buffer {
  const parts = Array.from({ length: 32 }, (_, n) => createHash('sha256').update(`${id}/${n}`).digest());
  return Buffer.concat(parts);
}

// The state as the last process stored it, every write synced at once.
const saved: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const stored = new Map(Object.entries(saved).map(([key, value]) => [key, Buffer.from(value, 'base64')]));
const store = {
  get: async (key: string) => stored.get(key),
  set: (key: string, value: Uint8Array) => void stored.set(key, Buffer.from(value)),
  clear: (key: string) => void stored.delete(key),
  sync: async () => {},
  keys: async () => [...stored.keys()],
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const db = await open(namespace, store).catch(async (error: unknown) => {
  // And what the open after it does.
  const again = await open(namespace, store).then(() => 'opened', message);
  console.log(JSON.stringify({ error: message(error), again }));
  return process.exit(0);
});

await db.execute('CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, data BLOB NOT NULL)');
const rows = await db.values('SELECT id, data FROM rows ORDER BY id');
rows.forEach(([id, data], n) => {
  if (id !== n || !row(n).equals(data as Uint8Array)) throw new Error(`row ${n} does not read back as written`);
});
for (let id = rows.length; id < rows.length + Number(add); id++) {
  await db.execute('INSERT INTO rows VALUES (?, ?)', [id, row(id)]);
}
await db.save();

writeFileSync(
  file,
  JSON.stringify(Object.fromEntries([...stored].map(([key, value]) => [key, value.toString('base64')]))),
);
console.log(JSON.stringify({ rows: rows.length }));
