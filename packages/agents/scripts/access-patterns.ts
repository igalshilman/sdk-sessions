// Measure what a conversation asks of Restate state, turn after turn.
//
// Answers prompts through `answerOnce` with the tests' made-up framework
// (test/fakes/items.ts) over the tests' attempt of a handler
// (test/support.ts's `sqlAttempt`, whose object's state is a map), and meters
// every request the key's database makes to the object's state: the reads
// (`get`, in round trips), the writes (`set`, `clear`) and the syncs,
// classified by the storage's key kinds (head, tail, manifest, pack). It
// meters the SQL too: statements, the rows and bytes they read, and the gets
// made while each ran. After each turn, a client following the conversation
// reads what changed (the `messages` view from its cursor), metered the same
// way. It is the Python SDK's scripts/access_patterns.py, on the same storage
// (sdk-shared-core's).
//
// Each turn runs warm, in one process, as a key answered by the same process
// turn after turn. The turn after each of `--cold-at`'s runs in a new process
// (an empty page cache, the conversation as stored), as a key's first
// invocation in a new process; so does a client reading that turn, the
// latest, from the cursor before it; and `--probe` costs a statement alone,
// the same way. `--tree` measures another checkout (with its node_modules),
// so that two versions can be compared:
//
//   node scripts/access-patterns.ts                                 # from packages/agents: 200 turns, the report
//   node scripts/access-patterns.ts --turns 1000 --cold-at 100,500,1000 --json > after.jsonl
//   node scripts/access-patterns.ts --tree ../before --turns 1000 --cold-at 100,500,1000 --json > before.jsonl
//   node scripts/access-patterns.ts --turns 500 --cold-at 500 --probe "SELECT COUNT(*) FROM restate_agent_turns"
//   node scripts/access-patterns.ts --report before.jsonl after.jsonl
//
// The text of prompts, replies and tool results is random words, about as
// compressible as prose. Round trips are counted as the batches of reads
// issued together: a read issued while none is outstanding starts a new one.
// The fake state answers at once, so they are what Restate would wait for,
// not a timing. RESTATE_SQL_CACHE=off measures without any page cache.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type * as Sessions from '@restatedev/sessions/internal';
import type * as Conversations from '../src/conversation.ts';
import type * as MessagesModule from '../src/messages.ts';
import type * as Fakes from '../test/fakes/items.ts';
import type * as Support from '../test/support.ts';

const SCRIPT = fileURLToPath(import.meta.url);
/** The checkout this script is in. */
const HERE = resolve(SCRIPT, '../../../..');

// --- The text: words of English letter frequencies, picked by Zipf's law ---

/** A generator of numbers in [0, 1), the same for the same `seed`. */
function random(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Of `choices`, the one that `cumulative` weights pick for `at`, a number in [0, 1). */
function pick<T>(choices: readonly T[], cumulative: readonly number[], at: number): T {
  const target = at * cumulative.at(-1)!;
  let [low, high] = [0, cumulative.length - 1];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cumulative[middle]! > target) high = middle;
    else low = middle + 1;
  }
  return choices[low]!;
}

const sums = (weights: number[]) => weights.map((_, i) => weights.slice(0, i + 1).reduce((a, b) => a + b, 0));
const LETTERS = 'etaoinshrdlcumwfgypbvkjxqz'.split('');
const LETTER_WEIGHTS = sums([
  12.7, 9.1, 8.2, 7.5, 7.0, 6.7, 6.3, 6.1, 6.0, 4.3, 4.0, 2.8, 2.8, 2.4, 2.4, 2.2, 2.0, 2.0, 1.9, 1.5, 1.0, 0.8, 0.15,
  0.15, 0.1, 0.07,
]);
const LENGTHS = [1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10];
const WORDS = Array.from({ length: 5000 }, (_, i) => {
  const next = random(`word ${i}`);
  const length = LENGTHS[Math.floor(next() * LENGTHS.length)]!;
  return Array.from({ length }, () => pick(LETTERS, LETTER_WEIGHTS, next())).join('');
});
const WORD_WEIGHTS = sums(WORDS.map((_, rank) => 1 / (rank + 1)));

/**
 * About `chars` characters of words, the same for the same `seed`: a block of
 * 1,500 characters compresses (zlib) about 2.3x, where one of this package's
 * docs' prose does 2.2x.
 */
function text(seed: string, chars: number): string {
  const next = random(seed);
  const words: string[] = [];
  for (let size = 0; size < chars; size += words.at(-1)!.length + 1) words.push(pick(WORDS, WORD_WEIGHTS, next()));
  return words.join(' ');
}

/** Invocation ids as random as Restate's (a prompt's id starts with its invocation's), each process its own. */
function* invocationIds(seed: number): Generator<string, never> {
  const next = random(`ids ${seed}`);
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  for (;;) yield `inv_${Array.from({ length: 26 }, () => alphabet[Math.floor(next() * alphabet.length)]).join('')}`;
}

// --- The meter ---

/** The storage's kind of state key `key`. */
function kindOf(key: string): string {
  for (const kind of ['tail', 'manifest', 'pack']) if (key.includes(`/${kind}/`)) return kind;
  return key.endsWith('/head') ? 'head' : 'other';
}

/** What one invocation asked of the object's state and of its database. */
class Meter {
  gets = 0;
  getBytes = 0;
  rounds = 0;
  sets = 0;
  setBytes = 0;
  clears = 0;
  syncs = 0;
  statements = 0;
  rows = 0;
  rowBytes = 0;
  /** Requests and their bytes by kind of key: `get:pack`, `set:tail`... */
  byKind: Record<string, [number, number]> = {};
  /** Gets and their bytes by the statement that made them (`open` before the first). */
  byStatement: Record<string, [number, number]> = {};
}

/** Count one more request, and its bytes, under `name`. */
function add(table: Record<string, [number, number]>, name: string, size: number) {
  const counts = (table[name] ??= [0, 0]);
  counts[0] += 1;
  counts[1] += size;
}

let meter = new Meter();
/** Whether the state is metered: while an invocation runs. */
let metering = false;
/** The statement in flight: a turn runs one at a time. */
let statement = 'open';
/** Whether the last request was a get, which the store answers in a round trip of its own or with others. */
let issued = false;
/** The gets not answered yet. */
let pending = 0;

/** The object's state, metered. */
class MeteredState extends Map<string, Uint8Array> {
  override get(key: string) {
    const value = super.get(key);
    if (metering) {
      const size = value?.length ?? 0;
      meter.gets += 1;
      meter.getBytes += size;
      add(meter.byKind, `get:${kindOf(key)}`, size);
      add(meter.byStatement, statement, size);
      issued = true;
    }
    return value;
  }

  override set(key: string, value: Uint8Array) {
    if (metering) {
      meter.sets += 1;
      meter.setBytes += value.length;
      add(meter.byKind, `set:${kindOf(key)}`, value.length);
    }
    return super.set(key, value);
  }

  override delete(key: string) {
    if (metering) {
      meter.clears += 1;
      add(meter.byKind, `clear:${kindOf(key)}`, 0);
    }
    return super.delete(key);
  }
}

/** Each request the attempt awaits: a get is answered once the gets issued with it are (a round trip). */
async function answered() {
  if (!issued) return; // a sync's, or the keys'
  issued = false;
  if (pending === 0) meter.rounds += 1;
  pending += 1;
  await new Promise((done) => setImmediate(done));
  pending -= 1;
}

async function synced() {
  if (metering) meter.syncs += 1;
}

const sizeOf = (value: unknown) =>
  typeof value === 'string' || value instanceof Uint8Array ? value.length : value === null ? 0 : 8;

/** What the SQL classes of @restatedev/sessions have, but their types do not show. */
interface Sql {
  serial<T>(call: () => Promise<T>): Promise<T>;
  request<T>(call: () => Promise<T>): Promise<T>;
  native: { queryColumns(sql: string, params?: unknown[]): unknown };
  queryColumns(sql: string, params?: unknown[]): Promise<{ rows: unknown[][] }>;
}

/** Meter each statement of the databases of `sessions` (that package's internal module), in a connection or a transaction. */
async function meterStatements(sessions: string) {
  const { open } = (await import(sessions)) as typeof Sessions;
  const probe = await open(`probe-${process.pid}`, {
    get: async () => undefined,
    set: () => {},
    clear: () => {},
    sync: async () => {},
  });
  let transaction: Sql | undefined;
  await probe.transaction(async (tx) => {
    transaction = Object.getPrototypeOf(tx) as Sql;
  });
  await probe.close();
  for (const prototype of [Object.getPrototypeOf(probe) as Sql, transaction!]) {
    prototype.queryColumns = function (this: Sql, sql: string, params?: unknown[]) {
      return this.serial(() =>
        this.request(async () => {
          statement = sql.split(/\s+/).join(' ').slice(0, 160);
          try {
            const result = (await this.native.queryColumns(sql, params)) as { rows: unknown[][] };
            meter.statements += 1;
            meter.rows += result.rows.length;
            meter.rowBytes += result.rows.flat().reduce((total: number, value) => total + sizeOf(value), 0);
            return result;
          } finally {
            statement = 'between statements';
          }
        }),
      );
    };
  }
}

// --- The conversation ---

interface Options {
  tree: string;
  turns: number;
  calls: number;
  result: number;
  window: number | 'all';
  budget: number | undefined;
}

/** A measurement: one invocation's {@link Meter}, and what it was. */
type Row = Record<string, unknown> & { handler: string; turn: number; cold: boolean };

/** A conversation as stored after a turn: the state, the turn after it, and the cursor before it. */
interface Saved {
  state: [string, string][];
  next: number;
  cursor: number | undefined;
}

const fresh = () => {
  meter = new Meter();
  statement = 'open';
};

const metered = (): Record<string, unknown> => Object.fromEntries(Object.entries(meter));

/**
 * Answer `options.turns` prompts, from the conversation `resumed` stored (a
 * new one if none), and measure each turn and a follower after it; with no
 * turns, a follower of the latest turn and each of `probes`, in a new
 * process. The conversation after each turn of `save`, into `saved/<turn>`.
 */
async function measure(
  options: Options,
  {
    resumed,
    follow = true,
    probes = [],
    save = new Set<number>(),
    saved = '',
  }: {
    resumed?: string;
    follow?: boolean;
    probes?: string[];
    save?: Set<number>;
    saved?: string;
  },
): Promise<Row[]> {
  const agents = join(options.tree, 'packages/agents');
  const from = (path: string) => import(pathToFileURL(join(agents, path)).href);
  const { answerOnce } = (await from('src/conversation.ts')) as typeof Conversations;
  const { page } = (await from('src/messages.ts')) as typeof MessagesModule;
  const { ITEMS } = (await from('test/fakes/items.ts')) as typeof Fakes;
  const { sqlAttempt } = (await from('test/support.ts')) as typeof Support;
  await meterStatements(
    pathToFileURL(createRequire(join(agents, 'package.json')).resolve('@restatedev/sessions/internal')).href,
  );

  const state = new MeteredState();
  let first = 1;
  let cursor: number | undefined;
  if (resumed !== undefined) {
    const stored = JSON.parse(readFileSync(resumed, 'utf8')) as Saved;
    for (const [key, value] of stored.state) state.set(key, Buffer.from(value, 'base64'));
    ({ next: first, cursor } = stored);
  }
  const cold = resumed !== undefined;
  const ids = invocationIds(first);
  const attempt = (id: string, shared = false) =>
    sqlAttempt({ map: state, key: 'k', id, service: 'asker', shared, onAwait: answered, onSync: synced });
  const rows: Row[] = [];
  /** The `messages` view, from the cursor, or the latest page. */
  const followed = async (turn: number) => {
    fresh();
    metering = true;
    const sql = attempt(`follow-${turn}`, true);
    const read = await sql.end(() => page(sql.view.db, ITEMS, cursor === undefined ? { limit: 50 } : { cursor }));
    metering = false;
    rows.push({ handler: 'follow', turn, cold, ...metered() });
    return read.cursor;
  };

  let asked = 0;
  let model: [items: number, chars: number] = [0, 0];
  const run: Conversations.Run<Fakes.Item> = async (conversation) => {
    const seen = conversation.history();
    model = [seen.length, seen.reduce((chars, item) => chars + JSON.stringify(item).length, 0)];
    const turn = conversation.turn;
    const calls = Array.from({ length: options.calls }, (_, i) => ({
      id: `c${asked}.${i}`,
      name: 'lookup',
      input: { q: text(`q${asked}.${i}`, 40) },
    }));
    await turn.appendReply([{ role: 'assistant', text: text(`r${asked}`, 60), calls }]);
    for (const call of calls) await turn.append({ result: call.id, output: text(`o${call.id}`, options.result) });
    const answer = text(`a${asked}`, 600);
    await turn.appendReply([{ role: 'assistant', text: answer }]);
    return answer;
  };

  // Only a client following the conversation, in a new process: it reads the latest turn, from the cursor before it.
  if (options.turns === 0 && follow) await followed(first - 1);
  for (let turn = first; turn < first + options.turns; turn++) {
    asked = turn;
    fresh();
    metering = true;
    const sql = attempt(ids.next().value);
    await sql.end(() =>
      answerOnce(sql.ctx, text(`p${turn}`, 150), ITEMS, run, { window: options.window, budget: options.budget }),
    );
    metering = false;
    const stored = [...state.values()].reduce((bytes, value) => bytes + value.length, 0);
    rows.push({
      handler: 'ask',
      turn,
      cold,
      ...metered(),
      modelItems: model[0],
      modelChars: model[1],
      storedKeys: state.size,
      storedBytes: stored,
    });
    const before = cursor;
    if (follow) cursor = await followed(turn);
    if (save.has(turn)) {
      // The cursor before this turn's: a client that follows from it reads this turn.
      const kept: Saved = {
        state: [...state].map(([key, value]) => [key, Buffer.from(value).toString('base64')]),
        next: turn + 1,
        cursor: before,
      };
      writeFileSync(join(saved, String(turn)), JSON.stringify(kept));
    }
  }
  for (const sql of options.turns === 0 ? probes : []) {
    fresh();
    metering = true;
    const view = attempt('probe', true);
    await view.end(() => view.view.db.values(sql));
    metering = false;
    const opened = meter.byStatement.open ?? [0, 0];
    rows.push({
      handler: 'probe',
      turn: first - 1,
      cold,
      sql,
      ...metered(),
      beyondOpen: [meter.gets - opened[0], meter.getBytes - opened[1]],
    });
  }
  return rows;
}

// --- The report ---

const COLUMNS = ['gets', 'rounds', 'getBytes', 'sets', 'setBytes', 'syncs', 'statements', 'rows', 'rowBytes'] as const;
const SAMPLED = new Set([1, 2, 11, 51, 101, 201, 501, 1001]);
const cell = (value: string | number | undefined, width = 11) => String(value ?? '').padStart(width);

/** The report of `rows`, under `title`: warm turns at a few lengths of the conversation and their sum, the cold ones, the probes. */
function report(title: string, rows: Row[]): string {
  const out: string[] = [];
  for (const handler of ['ask', 'follow']) {
    for (const cold of [false, true]) {
      const mine = rows.filter((row) => row.handler === handler && row.cold === cold);
      if (mine.length === 0) continue;
      out.push('', `${title}: ${handler}, ${cold ? 'cold (a new process)' : 'warm'}`);
      out.push(
        `${cell('turn', 5)}${COLUMNS.map((c) => cell(c)).join('')}${handler === 'ask' ? '  modelItems storedBytes' : ''}`,
      );
      const last = mine.at(-1)!.turn;
      for (const row of cold ? mine : mine.filter((r) => SAMPLED.has(r.turn) || r.turn === last)) {
        const extra = handler === 'ask' ? `  ${cell(Number(row.modelItems))} ${cell(Number(row.storedBytes))}` : '';
        out.push(`${cell(row.turn, 5)}${COLUMNS.map((c) => cell(Number(row[c]))).join('')}${extra}`);
        if (!cold) continue;
        // What made the cold reads: the statements with the most bytes.
        const by = Object.entries(row.byStatement as Record<string, [number, number]>).toSorted(
          ([, a], [, b]) => b[1] - a[1],
        );
        for (const [sql, [gets, bytes]] of by.slice(0, 3))
          out.push(`      ${cell(gets, 4)} gets ${cell(bytes, 9)} bytes  ${sql}`);
      }
      if (!cold) {
        const total = (c: (typeof COLUMNS)[number]) => mine.reduce((sum, row) => sum + Number(row[c]), 0);
        out.push(`${cell('sum', 5)}${COLUMNS.map((c) => cell(total(c))).join('')}`);
      }
    }
  }
  const probes = rows.filter((row) => row.handler === 'probe');
  if (probes.length > 0) out.push('', `${title}: statements, each alone in a new process (reads beyond the open)`);
  for (const row of probes) {
    const [gets, bytes] = row.beyondOpen as [number, number];
    out.push(`  after turn ${cell(row.turn, 5)}: ${cell(gets, 4)} gets ${cell(bytes, 9)} bytes  ${String(row.sql)}`);
  }
  return out.join('\n');
}

const jsonLines = (rows: Row[]) => rows.map((row) => JSON.stringify(row)).join('\n');
const parsed = (lines: string) =>
  lines
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Row);

async function main() {
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tree: { type: 'string', default: HERE },
      turns: { type: 'string', default: '200' },
      calls: { type: 'string', default: '2' },
      result: { type: 'string', default: '1500' },
      window: { type: 'string', default: '1' },
      budget: { type: 'string' },
      'cold-at': { type: 'string' },
      probe: { type: 'string', multiple: true, default: [] },
      json: { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
      // A run of its own, in a new process (see below).
      resume: { type: 'string' },
      'no-follow': { type: 'boolean', default: false },
    },
  });
  if (flags.report) {
    for (const path of positionals) console.log(report(path, parsed(readFileSync(path, 'utf8'))));
    return;
  }
  const options: Options = {
    tree: resolve(flags.tree),
    turns: Number(flags.turns),
    calls: Number(flags.calls),
    result: Number(flags.result),
    window: flags.window === 'all' ? 'all' : Number(flags.window),
    budget: flags.budget === undefined ? undefined : Number(flags.budget),
  };
  if (flags.resume !== undefined) {
    const rows = await measure(options, { resumed: flags.resume, follow: !flags['no-follow'], probes: flags.probe });
    console.log(jsonLines(rows));
    return;
  }
  const milestones = [10, 50, 100, 200, 500, 1000].filter((at) => at < options.turns);
  const cold =
    flags['cold-at'] === undefined ? [...milestones, options.turns] : flags['cold-at'].split(',').map(Number);
  if (cold.some((at) => !(Number.isInteger(at) && at >= 1 && at <= options.turns))) {
    throw new Error(`--cold-at takes turns from 1 to --turns (${options.turns}), not ${flags['cold-at']}`);
  }
  const saved = mkdtempSync(join(tmpdir(), 'access-patterns-'));
  try {
    const rows = await measure(options, { save: new Set(cold), saved });
    const common = ['--tree', options.tree, '--calls', String(options.calls), '--result', String(options.result)];
    common.push(
      '--window',
      String(options.window),
      ...(options.budget === undefined ? [] : ['--budget', String(options.budget)]),
    );
    for (const at of cold) {
      const resumed = ['--resume', join(saved, String(at)), ...common];
      // A new process, its page cache empty: the next turn as a key's first in a new process; then a client
      // reading that turn; then each statement in a process of its own, so that no other read warmed it.
      const runs = [
        ['--turns', '1', '--no-follow'],
        ['--turns', '0'],
        ...flags.probe.map((sql) => ['--turns', '0', '--no-follow', `--probe=${sql}`]),
      ];
      for (const extra of runs) {
        const child = spawnSync(process.execPath, [SCRIPT, ...resumed, ...extra], {
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        });
        if (child.status !== 0) throw new Error(`a run in a new process failed: ${child.stderr}`);
        rows.push(...parsed(child.stdout));
      }
    }
    console.log(flags.json ? jsonLines(rows) : report(`${options.turns} turns`, rows));
  } finally {
    rmSync(saved, { recursive: true, force: true });
  }
}

await main();
