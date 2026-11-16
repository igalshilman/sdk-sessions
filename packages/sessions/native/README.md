# The addon: a session's database in its state

The storage of [`@restatedev/sessions`](../README.md): SQLite-compatible SQL over
a key/value store implemented in JavaScript, the object's state. A native
addon ([napi-rs](https://napi.rs)), one Rust crate, over the [state and SQL
on it](#inside-the-layers) of sdk-shared-core. [`src/database.ts`](../src/database.ts)
opens it over a store, and `ctx.db` builds that store on the object's state
([`src/session.ts`](../src/session.ts)):

```ts
const db = await open('Ledger/a', {
  get: (key) => ctx.get(key, serde.binary), // stored value, or this request's own write
  set: (key, value) => ctx.set(key, value, serde.binary),
  clear: (key) => ctx.clear(key),
  sync: () => ctx.run('sync', () => {}), // resolves once every write before it is stored
});
await db.transaction(async (tx) => {
  await tx.execute('INSERT INTO transfers VALUES(?, ?, ?, ?)', [id, from, to, amount]);
});
await db.save(); // ends the session, leaving its engine to the next one
```

## The store

`set` and `clear` return at once, and `sync` resolves once every write before
it is stored. Writes are stored in the order they were made: a crash keeps a
prefix of the writes since the last sync and loses the rest, never a write
without the ones before it (as a Restate object's state does). A `set` or
`clear` that throws fails the next `sync`. A transaction commits as a tail
entry and the head that names it (see the
[format](src/state/docs/FORMAT.md)), written after it, so a commit
is durable once a sync after it resolves. Now and then a commit first
checkpoints the database into a pack, which never changes, and drops the
tail.

## Sessions and the page cache

`open` returns a session of the namespace's database. A statement that commits
resolves once its writes are stored; `transaction` commits a body as a whole.
Calls run one at a time, in call order, and a transaction holds the session
until it commits or rolls back: calls made meanwhile wait, so none runs inside
it. The body uses the handle it gets, which is invalid once the body settles;
a call to the session from inside the body is refused, as it would wait for
the body. A COMMIT that fails rolls back. An SQL error leaves the session
usable (`isUsable()`); a storage error ends it.

A body may set _records_ with its transaction, whole values by name kept
beside the SQL, in no table: `tx.setRecord(name, bytes)` puts one in the same
tail entry, so it is stored exactly when the transaction is, even if it
changes no row, and stays until a later transaction sets it again.
`record(name)` returns it. The SDK keeps a transaction's sends in the record
`outbox`, and makes them once it commits.

A page cache shared by the process's databases is built in: 256 MiB of memory
and 1 GiB of disk in a temporary file, unlinked once open so that it goes away
with the process, or the file `RESTATE_SQL_CACHE_FILE` names.
`RESTATE_SQL_CACHE_MEMORY` and `RESTATE_SQL_CACHE_DISK` set its sizes (bytes,
or with `KiB`, `MiB` or `GiB`; the memory also bounds the database states and
idle engines it keeps), and `RESTATE_SQL_CACHE=off` turns it off: each session
then reads what it needs from Restate. A size that is not one fails every
database open with its message, so check the process's log. It keeps a
database's packs, which never change, and its last head: a session reads the
ranges of packs it has from the cache, and reuses the idle engine when the
head is the one the cache saw last. `save()` (or `close()`) ends a session,
leaving its engine to the next one when it is idle. The cache keys packs by
their random names as well as the namespace: two stores
holding different databases under one namespace (two Restate clusters, say)
may share a process.

## The object store

`RESTATE_SQL_OBJECT_STORE`, a URL (`s3://`, `gs://`, `az://` or
`file:///`), gives every database an L1 there
(shared-core's `state::ObjectStoreL1::from_env`, made once a process): once
L0, its packs in the object's state, holds 4 MiB, a checkpoint uploads them
as one pack, and L0 empties. Credentials come from each provider's variables
(`AWS_*`, `GOOGLE_*`, `AZURE_*`), as `object_store`'s `from_env` reads them.
Its HTTP requests are reqwest's, on napi's tokio runtime: a call's first poll,
on the JavaScript thread, enters that runtime's context (`answer` in
`node.rs`). A namespace's packs go under
`<path>/<namespace escaped to one segment>` (`Ledger/a` is `_4cedger_2fa`), so
one namespace's garbage collection never lists another's packs. Not set,
every pack stays in the state.

`RESTATE_SQL_L0_BYTES` sets L0's 4 MiB (`StateOptions::l0_bytes`, which
`sql::Open::options` gives every open: `state_options` in `node.rs`), as
bytes, or with `KiB`, `MiB` or `GiB`, read at the process's first open; a
value that is not a size fails every open with its message, as a cache size
does. `0` puts every checkpoint's pack in the object store: the state keeps
the head, the tail since the checkpoint before the head's (each checkpoint
then waits for the absolute rule, 128 entries or 1 MiB, so up to about
twice that and the entries that passed it) and the two manifests the head
names (about 1.7 bytes per 16 KiB frame, and the records of up to 1 KiB).
Without an object store it changes nothing. It may differ between
processes, or opens, of a database: it changes no stored format, only the
tier the next checkpoint's pack goes to. Every pack's name records its
tier, which reads and garbage collection go by, so a lower value moves
what L0 holds with the next checkpoint, and a higher one leaves the packs
in L1 there and puts the next checkpoints in L0.

## Values

| SQL     | JavaScript                                                       |
| ------- | ---------------------------------------------------------------- |
| NULL    | `null` (`undefined` as a parameter)                              |
| INTEGER | `number`, or `bigint` beyond 2^53; a boolean parameter is 0 or 1 |
| REAL    | `number` (a non-integral parameter)                              |
| TEXT    | `string`                                                         |
| BLOB    | `Buffer` (any `Uint8Array` as a parameter)                       |

## Inside: the layers

Three layers, each knowing only the one below it. A change stays private to
the database until a call commits it, and the state's flush makes it durable.

```
host       @restatedev/sessions (TypeScript): ctx.db, transaction(), the outbox
               │
               ▼
database   Database: SQL on a private view of one file; each call that
           leaves no SQL transaction open commits: the pages it changed and
           the records set, in one flush of its state
               │
               ▼
store      one Restate object's key/value state: get · put · delete · sync
```

| Layer        | Gives the layer above                                                                                                            | Keeps to itself                                                                                                   | Knows nothing of                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Store**    | `get`, `put`, `delete` and `sync` on one object's keys, writes in issue order; a crash keeps a prefix of the unsynced ones       | Restate's own durability and fencing: one owner per object at a time                                              | What the keys mean                  |
| **Database** | `query`, `execute`, `begin`, `commit(records)`, `rollback`, `record`, `save`, `close`: each commit durable when its call returns | The engine, its private view of the file and its WAL; the state's format (a tail, the head, packs); a warm engine | Restate, and what the records say   |
| **Host**     | The SDK API: `ctx.db` in a session's handler                                                                                     | What goes in a transaction, and the records to commit with it                                                     | How the database lays out its pages |

**When a change is durable.** When the call that commits it returns. A
statement outside a transaction commits on its own; one in a transaction,
with the transaction's `COMMIT` (or `commit(records)`): the pages it changed
and the records go into one mutation of the state, whose flush puts one tail
entry, then the head naming it.

**Failures.** An SQL error (syntax, a constraint) undoes only that statement.
A storage error, a cancelled call or a failed commit ends the session: the
flush's outcome is unknown, so the host settles outstanding requests and
opens a new one, reading whatever head last landed.

**Records.** `commit(records)` stores the records with the rows, in the same
flush: what the host keeps beside the SQL, such as the sends committed with
the rows (the outbox), opaque to the storage.

The storage and the SQL on it live in
[sdk-shared-core](https://github.com/restatedev/sdk-shared-core), as its
modules `state` (`src/state/README.md` there: its architecture, design and
format, under `src/state/docs/`), the storage of one file and its records,
and `sql` (`src/sql/README.md`), the `Database` on it; its feature `sql`
turns them on. This crate is [`src/node.rs`](src/node.rs), the
napi bindings around that `Database`.

## Build and test

From `packages/sessions`; at the repository's root, `pnpm build` builds the
addon, and `pnpm test` runs its tests with the rest:

```sh
pnpm build                          # release build, into this machine's package (npm/<platform>)
pnpm build:debug
pnpm test:rust                      # cargo test (the state's and SQL's own tests run in sdk-shared-core)
pnpm lint:rust                      # rustfmt and clippy
```

`pnpm test` runs [`test/database.test.ts`](../test/database.test.ts) with
the package's other tests: SQL and value round trips, SQL errors and
rollback, a write the store rejects, and lost writes: for every position of
a request that loses its writes (its `sync` failing, or the session closed
first), the owner and a reader with no cached state read exactly the stored
rows. The state's and SQL's own tests, with the simulated stores, run in
sdk-shared-core (`src/state/tests`, `src/sql/tests` there), as do its
benchmarks (`benches/`).
