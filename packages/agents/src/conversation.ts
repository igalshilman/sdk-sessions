// The conversation of an agent's key, which every framework stores the same
// way: one endless sequence of turns. A turn is one prompt (the user's
// message) and what answers it. Its id is the prompt's (`nextPromptId`: the
// invocation's, then `<id>:2`... for a handler that prompts more than once),
// so each attempt of the invocation goes on with the same turn, and a retried
// attempt finds its answer. As the Python SDK's `_conversation.py`: the same
// tables, the same rules (see docs/turns.md and docs/conversation.md).
//
// The agent's `chat` handler is exclusive on the key, and keeps the key while
// it waits, so turns never overlap: at most one turn has no answer, the
// latest, and if a newer turn finds one, the invocation that ran it is gone
// (killed, say). The newer turn closes it (`ENDED`), as does the companion if
// it notices first (`settle`), rather than finishing it.
//
// A turn is stored in two parts, in the key's database:
//
// - The transcript, `restate_agent_turns`: one row per turn, with the
//   prompt (the framework's item for it), the turn's answer once it has one,
//   and what a framework carries from turn to turn that is no message (the
//   agent the conversation is with, its own state: `Turn.carry`).
// - The trajectories, `restate_agent_items`: every other item (the model's
//   replies, tool calls and their results), each with its turn.
//
// Both share one sequence of positions, which are the ids of the messages
// the `messages` view renders (messages.ts); and each row has a `seq`, which
// grows with every row written, for a client that reads from a cursor. Rows
// are only appended, in one transaction per step, but for a reply at the end
// that is dropped (to ask the model again), one range delete; and a turn's
// answer is one update of its row.
//
// The model gets the transcript, and the whole trajectories of the latest
// `window` turns and of any turn after them that another invocation ended
// (`Walk`), in `Conversation.history`. Earlier turns are the user's message
// and the answer, as many as a budget of tokens holds; those summarized are
// one summary (`compact`). A turn loads only what it needs: the transcript
// the budget holds, and the window; a retried attempt of an answered turn
// reads only its answer.
//
// On top of it, `answerOnce` runs a prompt the same way for every framework:
// each prompt is answered once per invocation, and a stopped, refused or
// failed run is closed so that the next prompt starts afresh. A framework
// gives its `Items` (how its items say what they are) and a `Run` (its own
// loop, from the conversation to the answer, storing each step as it goes).
import * as restate from '@restatedev/sessions';
import type { Database, DatabaseReader, DatabaseWriter } from '@restatedev/sessions';
import { definitionOf, Schema } from '@restatedev/sessions/internal';
import { forPrompt, outcomes } from './calls.ts';
import {
  answering,
  AttemptEnded,
  aborted,
  BUDGET,
  CANCELLED,
  type Check,
  checkWindow,
  cutOffResult,
  ENDED,
  nextPromptId,
  refusalOf,
  REFUSED,
  settingsOf,
  stopSignalOf,
  storedAnswer,
  SUMMARIZE,
  UNANSWERED,
  type Window,
} from './common.ts';

/** The transcript: one row per turn. */
export const TURNS = 'restate_agent_turns';
/** The trajectories: the items of each turn but its prompt. */
export const STEPS = 'restate_agent_items';
/** Where the conversation starts: its first position, the last `seq` given, and the summary of the earliest turns. */
export const START = 'restate_agent_conversation_start';
/** The Python SDK's snapshots, which this package does not take (docs/plan.md, D3): created, never written. */
export const SNAPSHOTS = 'restate_agent_snapshots';

/** The conversation's tables: the Python SDK's, step for step, so that both SDKs read each other's. */
export const SCHEMA = new Schema('restate_agents.turns', [
  `CREATE TABLE ${TURNS} (
    n INTEGER PRIMARY KEY,
    seq INTEGER NOT NULL,
    prompt TEXT NOT NULL UNIQUE,
    item TEXT NOT NULL,
    status TEXT,
    answer TEXT,
    agent TEXT,
    carried TEXT,
    answered_at INTEGER,
    answered_seq INTEGER,
    asked_at INTEGER
  )`,
  `CREATE INDEX ${TURNS}_seq ON ${TURNS} (seq)`,
  `CREATE INDEX ${TURNS}_answered_seq ON ${TURNS} (answered_seq)`,
  `CREATE TABLE ${STEPS} (
    n INTEGER PRIMARY KEY,
    turn INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    item TEXT NOT NULL,
    reply INTEGER,
    agent TEXT
  )`,
  `CREATE INDEX ${STEPS}_seq ON ${STEPS} (seq)`,
  `CREATE TABLE ${START} (
    row INTEGER PRIMARY KEY CHECK (row = 0),
    n INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    summary TEXT,
    summarized INTEGER
  )`,
  `CREATE TABLE ${SNAPSHOTS} (
    id INTEGER PRIMARY KEY,
    covers INTEGER NOT NULL,
    turn INTEGER,
    items TEXT NOT NULL
  )`,
]);

/**
 * How a turn ended: answered by its run, or closed: stopped, failed for
 * good, refused by the model's provider, or ended by another invocation once
 * its own was gone ({@link ENDED}).
 */
export type Status = 'answered' | 'cancelled' | 'failed' | 'refused' | 'ended';

/** A tool call an item makes. */
export interface Call {
  id: string;
  name: string;
  input: unknown;
}

/** A tool call's result an item holds: an error if `error`, or if its output starts with `Error: `. */
export interface Result {
  id: string;
  output: string;
  error?: boolean;
}

/** Whether `result` is an error: marked as one, or `Error: <message>`. */
export const failed = (result: Result) => result.error === true || result.output.startsWith('Error: ');

/** What an item is, as {@link Items.read} reads it. */
export interface Parsed {
  /** The role and text of a message; none for any other item. */
  said?: ['user' | 'assistant', string];
  calls?: Call[];
  results?: Result[];
}

/** A framework's items: how the core stores, reads and makes them. */
export interface Items<I> {
  /** `item` as it is stored: its JSON, most often. */
  dump(item: I): string;
  /** The item `dump` stored as `stored`. */
  load(stored: string): I;
  /** The item of a prompt (the user's message). */
  prompt(text: string): I;
  /** The item of an assistant's message of `text`, from `agent` if known: it closes a run, and is an earlier turn's answer as the model sees it. */
  reply(text: string, agent?: string): I;
  /** The items that give each call its result, as text: they close a run's cut-off calls. */
  results(results: [Call, string][]): I[];
  /** What `item` says, and the tool calls and results it holds. */
  read(item: I): Parsed;
  /** The summary of the earliest turns in the framework's own form; by default a user's message and "Understood." */
  summary?(text: string): I[];
}

/** What the user's message with the summary of the earliest turns starts with. */
export const SUMMARY = 'A summary of our conversation so far:\n\n';

/** The items that give the model `summary`, of the earliest turns: `items.summary`'s, if it has one. */
export const summaryItems = <I>(items: Items<I>, summary: string): I[] =>
  items.summary ? items.summary(summary) : [items.prompt(SUMMARY + summary), items.reply('Understood.')];

/** An item of the conversation, with what it is part of. */
export interface Entry<I> {
  /** Its position: the conversation is ordered by it. */
  n: number;
  item: I;
  /** The id of the prompt it is, if it is one: it starts a turn. */
  prompt?: string;
  /** On a prompt: its turn's answer, once it has one. */
  answer?: string;
  /** The id of the model's reply it is part of: the position of the reply's first item. */
  reply?: number;
  /** The agent that gave the reply; on a prompt, the agent the conversation is with after its turn. */
  agent?: string;
  /** What `item` is, read once (`Items.read`), as the conversation loads or appends it. */
  parsed?: Parsed;
  /** The position of its turn's prompt. */
  turn?: number;
  /** On a prompt: the framework's state as of its turn's end, if it carries one. */
  carried?: string;
  /** On a prompt: how its turn ended, once it did. */
  status?: Status;
  /** On a prompt: the position of its turn's answer, its last message of the assistant. */
  answeredAt?: number;
  /** On a prompt: the `seq` given as its turn was answered. */
  answeredSeq?: number;
  /** On a prompt: when its turn's row was stored, in Unix milliseconds. */
  askedAt?: number;
}

/** What `entry` says, read once. */
const parsedOf = <I>(items: Items<I>, entry: Entry<I>) => (entry.parsed ??= items.read(entry.item));

/** Where a conversation starts: its first position, the last `seq` given, and the summary of the earliest turns. */
export interface Start {
  n: number;
  seq: number;
  summary?: string;
  /** The position of the first turn after the summary: those before it are the summary, as the model sees them. */
  summarized?: number;
}

const int = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));
const str = (value: unknown) =>
  value === null || value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value);

/** Where the conversation in `db` starts, as `clear`, drops and summaries left it. */
export async function startOf(db: DatabaseReader): Promise<Start> {
  const row = await db.get(`SELECT n, seq, summary, summarized FROM ${START}`);
  if (!row) return { n: 0, seq: 0 };
  return { n: int(row.n) ?? 0, seq: int(row.seq) ?? 0, summary: str(row.summary), summarized: int(row.summarized) };
}

/** The last position of `db`'s rows (none if it has none), and the last `seq` they have (or 0). */
export async function lastOf(db: DatabaseReader): Promise<[last: number | undefined, seq: number]> {
  const [[turn, turnSeq, answeredSeq]] = (await db.values(
    `SELECT MAX(n), MAX(seq), MAX(answered_seq) FROM ${TURNS}`,
  )) as unknown[][] as [[unknown, unknown, unknown]];
  const [[step, stepSeq]] = (await db.values(`SELECT MAX(n), MAX(seq) FROM ${STEPS}`)) as unknown[][] as [
    [unknown, unknown],
  ];
  const positions = [turn, step].filter((n) => n !== null && n !== undefined).map(Number);
  const seqs = [turnSeq, answeredSeq, stepSeq].filter((s) => s !== null && s !== undefined).map(Number);
  return [positions.length > 0 ? Math.max(...positions) : undefined, seqs.length > 0 ? Math.max(...seqs) : 0];
}

/** Where the next conversation starts, past the positions and `seq` of the one in `db`. */
export async function nextStart(db: DatabaseReader): Promise<Start> {
  const start = await startOf(db);
  const [last, seq] = await lastOf(db);
  return { n: last === undefined ? start.n : last + 1, seq: Math.max(start.seq, seq) };
}

/** Store `start` as where the conversation starts: in the transaction of `clear` that emptied it, say. */
export async function restart(tx: DatabaseWriter, start: Start) {
  await tx.execute(`INSERT OR REPLACE INTO ${START} (row, n, seq, summary, summarized) VALUES (0, ?, ?, ?, ?)`, [
    start.n,
    start.seq,
    start.summary ?? null,
    start.summarized ?? null,
  ]);
}

/** The stored answer of prompt `promptId`, and how its turn ended, if it has one: one read, of the turn's row. */
export async function answerIn(
  db: DatabaseReader,
  promptId: string,
): Promise<{ answer: string; status: Status } | undefined> {
  const row = await db.get(`SELECT answer, status FROM ${TURNS} WHERE prompt = ?`, [promptId]);
  const answer = row ? str(row.answer) : undefined;
  return answer === undefined ? undefined : { answer, status: (str(row!.status) ?? 'answered') as Status };
}

/**
 * Of the turns from the latest back, which are in a window of `size` turns:
 * the `size` latest turns their framework answered, and the turns after them
 * it did not: the one being answered (only the latest can have no answer),
 * and those another invocation ended (`ended`), whose framework never
 * finished them, so that what they carried is a guess and their own rows say
 * what happened.
 */
class Walk {
  #seen = 0;
  #done = false;
  readonly size: number;
  constructor(size: number) {
    this.size = size;
  }

  /** Whether the next turn back, which ended as `status` (or not yet), is in the window. */
  holds(status: Status | undefined) {
    if (this.#done) return false;
    if (status === undefined || status === 'ended') return true;
    if (this.#seen === this.size) {
      this.#done = true;
      return false;
    }
    this.#seen += 1;
    this.#done = this.#seen === this.size;
    return true;
  }
}

/** The index in `turns` (prompts, in order) of the first turn in `window` (see {@link Walk}). */
export function windowStart<I>(turns: readonly Entry<I>[], window: Window) {
  if (window === 'all') return 0;
  const walk = new Walk(window);
  let first = turns.length;
  while (first > 0 && walk.holds(turns[first - 1]!.status)) first -= 1;
  return first;
}

/** Runs its bodies one after another: writes that come at once (parallel tool calls') each get positions of their own. */
class Lock {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(body: () => Promise<T>): Promise<T> {
    const done = this.#tail.then(body);
    this.#tail = done.catch(() => {});
    return done;
  }
}

/** What a conversation and its turns share: the database, the next position and `seq`, and the writes' lock. */
class Ledger<I> {
  /** The latest turn, if loaded whole: the only one that may be written. */
  latest: Turn<I> | undefined;
  /** Whether {@link Conversation.seal} closed the conversation to writes. */
  closed = false;
  readonly lock = new Lock();
  /** The ids of the tool calls made in the loaded turns. */
  readonly ids = new Set<string>();
  /** Whether a call's id an earlier call has was logged: once is enough. */
  warned = false;

  readonly db: Database;
  readonly items: Items<I>;
  start: Start;
  /** The turns' prompts, in order: the latest is the latest turn's. */
  readonly transcript: Entry<I>[];
  /** The next position to give. */
  next: number;
  /** The last `seq` given. */
  seq: number;

  constructor(db: Database, items: Items<I>, start: Start, transcript: Entry<I>[], next: number, seq: number) {
    this.db = db;
    this.items = items;
    this.start = start;
    this.transcript = transcript;
    this.next = next;
    this.seq = seq;
  }

  /** Note a tool call's id, and log one that an earlier call has (once). */
  called(callId: string) {
    if (this.ids.has(callId) && !this.warned) {
      this.warned = true;
      console.warn(
        `Tool call id ${JSON.stringify(callId)} is used by more than one call: the conversation matches results to calls by id, so a call may be taken as answered by another's result`,
      );
    }
    this.ids.add(callId);
  }

  checkOpen() {
    if (this.closed) throw new Error('the run was stopped: it stores nothing more');
  }

  /** The agent and the framework's state that the latest answered turn left. */
  carried(): [agent: string | undefined, carried: string | undefined] {
    const latest = this.transcript.findLast((turn) => turn.answer !== undefined);
    return latest ? [latest.agent, latest.carried] : [undefined, undefined];
  }
}

/** The index of the first of `entries` (by position) at `n` or after. */
const bisect = <I>(entries: readonly Entry<I>[], n: number) => {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (entries[mid]!.n < n) low = mid + 1;
    else high = mid;
  }
  return low;
};

/**
 * One turn of the conversation: its prompt, and what its run stored to
 * answer it. A turn's rows are read and written here, and only here: its
 * open tool calls, its replies and its final reply are this turn's, never
 * another's. Only the latest turn, while it has no answer, can be written:
 * by its own run, or by whoever closes it ({@link Turn.close}), once its run
 * is gone.
 */
export class Turn<I> {
  #ledger: Ledger<I>;
  #entries: Entry<I>[] = [];
  /** The tool calls' results, by their calls' ids. */
  #results = new Map<string, Result>();
  /** The tool calls without a result, in the order they were made: each, even if ids repeat. */
  #open: Call[] = [];
  /** What the turn carries to the turns after it, stored with its answer. */
  #carried: { agent?: string; carried?: string } = {};
  /**
   * Whether the turn is being closed: its run (left running once stopped,
   * as a promise cannot be cancelled) stores nothing more.
   */
  #fenced = false;

  /** The turn's row: its prompt, and once it has them, its status, answer and what it carried. */
  readonly prompt: Entry<I>;

  constructor(ledger: Ledger<I>, prompt: Entry<I>, items: Entry<I>[] = []) {
    this.#ledger = ledger;
    this.prompt = prompt;
    this.#add([prompt, ...items]);
  }

  /** The turn's id: its prompt's. */
  get id() {
    return this.prompt.prompt!;
  }

  /** The turn's position: its prompt's, the id of its user's message. */
  get n() {
    return this.prompt.n;
  }

  /** How the turn ended, or none while it is being answered. */
  get status() {
    return this.prompt.status;
  }

  /** The turn's answer, once it has one: the run's, or the note that closed it. */
  get answer() {
    return this.prompt.answer;
  }

  /** The turn's entries, in order: its prompt, then its items. */
  get entries(): readonly Entry<I>[] {
    return this.#entries;
  }

  /** The turn's items, in order: the model's replies, the tool calls' results... */
  get items(): readonly Entry<I>[] {
    return this.#entries.slice(1);
  }

  #add(entries: Entry<I>[]) {
    for (const entry of entries) {
      entry.parsed = this.#ledger.items.read(entry.item);
      entry.turn = this.n;
      this.#index(entry);
    }
    // In position order, also when a framework's copy into the turn committed between this write and its return.
    this.#entries.splice(bisect(this.#entries, entries[0]?.n ?? Number.MAX_SAFE_INTEGER), 0, ...entries);
  }

  #index(entry: Entry<I>, note = true) {
    for (const call of entry.parsed?.calls ?? []) {
      if (note) this.#ledger.called(call.id);
      if (!this.#results.has(call.id)) this.#open.push(call);
    }
    for (const result of entry.parsed?.results ?? []) {
      this.#results.set(result.id, result);
      if (this.#open.some((call) => call.id === result.id)) {
        this.#open = this.#open.filter((call) => call.id !== result.id);
      }
    }
  }

  // Reading.

  /** The ids of the model's replies in the turn, in order. */
  replies(): number[] {
    return [...new Set(this.#entries.flatMap((e) => (e.reply === undefined ? [] : [e.reply])))].toSorted(
      (a, b) => a - b,
    );
  }

  /** The id of the model's reply the turn ends with, if it ends with one. */
  lastReply(): number | undefined {
    return this.#entries.at(-1)!.reply;
  }

  /** The entries of the model's reply `reply`, in order: they follow one another, from position `reply`. */
  replyEntries(reply: number): readonly Entry<I>[] {
    const first = bisect(this.#entries, reply);
    let end = first;
    while (end < this.#entries.length && this.#entries[end]!.reply === reply) end += 1;
    return this.#entries.slice(first, end);
  }

  /** The agent that gave the model's reply `reply`. */
  agentOf(reply: number) {
    return this.replyEntries(reply)[0]?.agent;
  }

  /** The text of the model's reply the turn ends with, if it ends the run: text, and no tool calls. */
  finalReply(): string | undefined {
    const reply = this.lastReply();
    if (reply === undefined) return undefined;
    const entries = this.replyEntries(reply);
    if (entries.some((e) => (e.parsed?.calls ?? []).length > 0)) return undefined;
    return entries.findLast((e) => e.parsed?.said !== undefined)?.parsed?.said?.[1];
  }

  /** The turn's tool calls without a result, in the order they were made. */
  openCalls(): Call[] {
    return [...this.#open];
  }

  /**
   * The turn's latest message of the user: its prompt, or the message that
   * asked again ({@link askAgain}). A framework that runs from a message of
   * its own runs from this one.
   */
  latestAsk(): Entry<I> {
    return this.items.findLast((e) => e.parsed?.said?.[0] === 'user') ?? this.prompt;
  }

  /** Whether the turn's tool call `callId` has a result. */
  hasResult(callId: string) {
    return this.#results.has(callId);
  }

  /** Whether tool call `callId` has its result: not an error, unless it is `failed`, its own. */
  stored(callId: string, failedWith?: string) {
    const result = this.#results.get(callId);
    return result !== undefined && (!failed(result) || result.output === failedWith);
  }

  // Writing: only the latest turn, while it has no answer.

  /** Append `items` (a tool's results, say) to the turn, in one transaction; appends at once are each stored after the ones before. */
  async append(...items: I[]): Promise<void> {
    await this.#insert((n) => items.map((item, i) => ({ n: n + i, item })));
  }

  /** Append the model's reply, of `items` (given by `agent`), to the turn, and return its id. */
  appendReply(items: I[], agent?: string): Promise<number> {
    return this.#insert((n) => items.map((item, i) => ({ n: n + i, item, reply: n, agent })));
  }

  /**
   * Ask the model again within the turn, with `text`: a message of the user
   * that is a step of the turn, not a turn of its own (the transcript, and
   * the summary view, have the turn's prompt and its answer).
   */
  async askAgain(text: string) {
    await this.append(this.#ledger.items.prompt(text));
  }

  /**
   * Keep what the turn carries to the turns after it, stored with its
   * answer: `agent`, the agent the conversation is with (by default, its
   * latest reply's, else the previous turn's); `state`, the framework's own,
   * as text (by default, the previous turn's).
   */
  carry({ agent, state }: { agent?: string; state?: string }) {
    if (agent !== undefined) this.#carried.agent = agent;
    if (state !== undefined) this.#carried.carried = state;
  }

  /**
   * Drop the turn's reply `reply`, and what came after it, to ask the model
   * again: one range delete. The positions are given again, so the new
   * reply's messages take the dropped ones' ids; the `seq` is kept, so that
   * a client's cursor still sees them.
   */
  async drop(reply: number) {
    this.#checkWritable();
    if (!this.replies().includes(reply)) throw new Error(`turn ${this.id} has no reply ${reply}`);
    const ledger = this.#ledger;
    await ledger.lock.run(async () => {
      this.#checkWritable();
      const start = { ...ledger.start, seq: ledger.seq };
      await ledger.db.transaction(async (tx) => {
        await tx.execute(`DELETE FROM ${STEPS} WHERE n >= ?`, [reply]);
        await restart(tx, start);
      });
      ledger.start = start;
      ledger.next = Math.min(ledger.next, reply);
      const cut = bisect(this.#entries, reply);
      const kept = this.#entries.slice(0, cut);
      // The dropped calls are not made: their ids may be made again, by the reply that replaces them.
      for (const entry of this.#entries.slice(cut))
        for (const call of entry.parsed?.calls ?? []) ledger.ids.delete(call.id);
      for (const entry of kept) for (const call of entry.parsed?.calls ?? []) ledger.ids.add(call.id);
      this.#entries = kept;
      this.#results = new Map();
      this.#open = [];
      for (const entry of kept) this.#index(entry, false);
    });
  }

  /**
   * Store the turn's `answer`, how it ended (`status`) and what it carries,
   * in one update of its row. The answer's message is the assistant's
   * message the turn ends with; a turn that ends otherwise gets `answer` as
   * its reply first, and an empty answer gets none.
   */
  async answered(answer: string, status: Status = 'answered') {
    let at = this.#answerMessage();
    if (at === undefined && answer.trim()) {
      const agent = this.#agent();
      at = await this.appendReply([this.#ledger.items.reply(answer, agent)], agent);
    }
    const ledger = this.#ledger;
    await ledger.lock.run(async () => {
      this.#checkWritable();
      const agent = this.#agent();
      const carried = 'carried' in this.#carried ? this.#carried.carried : ledger.carried()[1];
      let seq = ledger.seq + 1;
      // Its seq taken as the write runs, as `#insert` takes its own.
      await ledger.db.transaction(async (tx) => {
        seq = ledger.seq + 1;
        await tx.execute(
          `UPDATE ${TURNS} SET status = ?, answer = ?, agent = ?, carried = ?, answered_at = ?, answered_seq = ? WHERE n = ?`,
          [status, answer, agent ?? null, carried ?? null, at ?? null, seq, this.n],
        );
        ledger.seq = seq;
      });
      Object.assign(this.prompt, { status, answer, agent, carried, answeredAt: at, answeredSeq: seq });
    });
  }

  /**
   * The position of the assistant's message the turn ends with, if it ends
   * with one: a message without tool calls, with no call nor result after
   * it (items that are neither, a reasoning item say, do not count).
   */
  #answerMessage(): number | undefined {
    for (const entry of this.items.toReversed()) {
      const { said, calls = [], results = [] } = entry.parsed ?? {};
      if (said === undefined && calls.length === 0 && results.length === 0) continue;
      if (said?.[0] === 'assistant' && calls.length === 0) return entry.n;
      return undefined;
    }
    return undefined;
  }

  /** The agent the turn is with: the one it carries, else its latest reply's, else the previous turn's. */
  #agent(): string | undefined {
    const replied = this.#entries.findLast((e) => e.reply !== undefined)?.agent;
    return this.#carried.agent || replied || this.#ledger.carried()[0];
  }

  /**
   * Close the turn (stopped, refused, failed, or ended once its invocation is
   * gone) with `note`. Each tool call without a result gets one: the error
   * its Restate call answered with, a note that it did happen if it
   * answered, or else `note` ({@link cutOffResult}). Then `note` is the
   * turn's last message, and its answer. The calls' outcomes are those of the
   * invocation that made the turn's prompt: this one, or an earlier one whose
   * calls are still stored. A turn with its answer has nothing to close.
   */
  async close(ctx: restate.SessionContext, status: Status, note: string) {
    if (this.status !== undefined) return;
    // The run stores nothing more: a write it makes from here fails. Those
    // under way are stored first, so that the calls they make are open here,
    // and the results they hold are not.
    this.#fenced = true;
    const ledger = this.#ledger;
    await ledger.lock.run(async () => {});
    if (this.status !== undefined) return;
    const { items } = ledger;
    const calls = this.openCalls();
    const returned = await outcomes(
      ctx,
      calls.map((call) => call.id),
      invocationOf(this.id),
      this.id,
    );
    const closing = [
      ...items.results(calls.map((call) => [call, cutOffResult(returned, call.id, note)])),
      items.reply(note),
    ];
    // The results, the note and the answer in one transaction: a crash
    // between them would close the turn again, with a second note.
    await ledger.lock.run(async () => {
      this.#checkWritable(true);
      const n = ledger.next;
      const seq = ledger.seq;
      const added: Entry<I>[] = closing.map((item, i) => ({ n: n + i, item }));
      const at = n + added.length - 1; // the note: the turn's last message, and its answer
      const answeredSeq = seq + added.length + 1;
      const agent = this.#agent();
      const carried = 'carried' in this.#carried ? this.#carried.carried : ledger.carried()[1];
      await ledger.db.transaction(async (tx) => {
        for (const [i, e] of added.entries()) {
          await tx.execute(`INSERT INTO ${STEPS} (n, turn, seq, item, reply, agent) VALUES (?, ?, ?, ?, NULL, NULL)`, [
            e.n,
            this.n,
            seq + i + 1,
            items.dump(e.item),
          ]);
        }
        await tx.execute(
          `UPDATE ${TURNS} SET status = ?, answer = ?, agent = ?, carried = ?, answered_at = ?, answered_seq = ? WHERE n = ?`,
          [status, note, agent ?? null, carried ?? null, at, answeredSeq, this.n],
        );
      });
      ledger.next = n + added.length;
      ledger.seq = answeredSeq;
      this.#add(added);
      Object.assign(this.prompt, { status, answer: note, agent, carried, answeredAt: at, answeredSeq });
    });
  }

  /** Whether the turn's run can write it: the latest, without an answer, not being closed, of a conversation not sealed. */
  get writable() {
    return !this.#ledger.closed && !this.#fenced && this.#ledger.latest === this && this.status === undefined;
  }

  /**
   * Copy a framework's own messages into the turn, in `tx`, a transaction of
   * the framework's own store (its write of these messages): the rows commit
   * with it, so the copy is made once, however often the attempt crashes.
   * Each of `items` is a reply of the model (`reply`, from `agent`) or
   * another item (a tool's result). For a framework that keeps its own
   * history. It cannot wait for the turn's other writes inside `tx`, which
   * holds the database: it takes its positions, and adds its entries, at
   * once, so that a close after it sees them and writes after them. A turn
   * being closed (or closed) takes no copy: its close says how it ended.
   * Whether it copied.
   */
  async copyIn(tx: DatabaseWriter, items: { item: I; reply?: boolean; agent?: string }[]): Promise<boolean> {
    if (!this.writable) return false;
    const ledger = this.#ledger;
    const n = ledger.next;
    const seq = ledger.seq;
    const added: Entry<I>[] = items.map(({ item, reply, agent }, i) => ({
      n: n + i,
      item,
      ...(reply ? { reply: n + i, agent } : {}),
    }));
    // A rolled back transaction fails its attempt, whose state goes with it.
    ledger.next = n + added.length;
    ledger.seq += added.length;
    this.#add(added);
    for (const [i, e] of added.entries()) {
      await tx.execute(`INSERT INTO ${STEPS} (n, turn, seq, item, reply, agent) VALUES (?, ?, ?, ?, ?, ?)`, [
        e.n,
        this.n,
        seq + i + 1,
        ledger.items.dump(e.item),
        e.reply ?? null,
        e.agent ?? null,
      ]);
    }
    return true;
  }

  /**
   * Refuse a write unless this is the latest turn, without an answer: only
   * its run (or its close, `byClose`) writes it, and its run not once the
   * turn is being closed.
   */
  #checkWritable(byClose = false) {
    this.#ledger.checkOpen();
    if (!byClose && this.#fenced) throw new Error('the run was stopped: it stores nothing more');
    if (this.#ledger.latest !== this || this.status !== undefined) {
      throw new Error(`turn ${this.id} is not the turn being answered: only that turn is written`);
    }
  }

  /** Store the entries `made` makes from the next position, and return that position. */
  #insert(made: (n: number) => Entry<I>[]): Promise<number> {
    const ledger = this.#ledger;
    return ledger.lock.run(async () => {
      this.#checkWritable();
      const sql = `INSERT INTO ${STEPS} (n, turn, seq, item, reply, agent) VALUES (?, ?, ?, ?, ?, ?)`;
      let n = ledger.next;
      let added: Entry<I>[] = [];
      // The positions and seqs taken as the write runs: a framework's copy
      // into the turn (`copyIn`, in a transaction of its own, which this one
      // may wait for) takes those after them, so that they go in the order
      // the rows commit in, as a follower's cursor needs.
      await ledger.db.transaction(async (tx) => {
        n = ledger.next;
        added = made(n);
        for (const [i, e] of added.entries()) {
          await tx.execute(sql, [
            e.n,
            this.n,
            ledger.seq + i + 1,
            ledger.items.dump(e.item),
            e.reply ?? null,
            e.agent ?? null,
          ]);
        }
        ledger.seq += added.length;
        ledger.next = n + added.length;
      });
      this.#add(added);
      return n;
    });
  }
}

/** How many turns of the transcript a load reads at a time, from the latest back. */
export const PAGE = 64;

/** The columns of the transcript a load reads. */
const TRANSCRIPT = `SELECT n, prompt, item, status, answer, agent, carried, answered_at, answered_seq, asked_at FROM ${TURNS}`;

/** A row of {@link TRANSCRIPT} as a prompt's entry. */
function promptEntry<I>(items: Items<I>, row: unknown[]): Entry<I> {
  const [n, prompt, item, status, answer, agent, carried, answeredAt, answeredSeq, askedAt] = row;
  const at = Number(n);
  return {
    n: at,
    item: items.load(String(item)),
    prompt: String(prompt),
    answer: str(answer),
    agent: str(agent),
    turn: at,
    carried: str(carried),
    status: str(status) as Status | undefined,
    answeredAt: int(answeredAt),
    answeredSeq: int(answeredSeq),
    askedAt: int(askedAt),
  };
}

/**
 * The turns from position `first` on, in order: all of them, or as many as
 * `bounded` (the window and the budget) needs. Bounded, they are read from
 * the latest back, a page at a time, until they hold the window and more of
 * the turns before it than the budget holds.
 */
async function transcriptOf<I>(
  db: DatabaseReader,
  items: Items<I>,
  first: number,
  bounded: [window: number, budget: number] | undefined,
): Promise<Entry<I>[]> {
  if (bounded === undefined) {
    const rows = await db.values(`${TRANSCRIPT} WHERE n >= ? ORDER BY n`, [first]);
    return rows.map((row) => promptEntry(items, row));
  }
  const read: Entry<I>[] = [];
  let before = Number.MAX_SAFE_INTEGER;
  const walk = new Walk(bounded[0]);
  let left = bounded[1] * 4;
  for (;;) {
    const rows = await db.values(`${TRANSCRIPT} WHERE n >= ? AND n < ? ORDER BY n DESC LIMIT ?`, [first, before, PAGE]);
    for (const row of rows) {
      const entry = promptEntry(items, row);
      read.push(entry);
      if (walk.holds(entry.status)) continue;
      if (entry.answer !== undefined) {
        // A turn before the window: the model sees its message and answer, while the budget holds them.
        left -= (parsedOf(items, entry).said?.[1] ?? '').length + entry.answer.length;
        if (left < 0) return read.toReversed();
      }
    }
    if (rows.length < PAGE) return read.toReversed();
    before = read.at(-1)!.n;
  }
}

/** The rows of the trajectories after position `after`, in order, as entries. */
async function stepsAfter<I>(db: DatabaseReader, items: Items<I>, after: number): Promise<Entry<I>[]> {
  const rows = await db.values(`SELECT n, item, reply, agent FROM ${STEPS} WHERE n > ? ORDER BY n`, [after]);
  return rows.map(([n, item, reply, agent]) => ({
    n: Number(n),
    item: items.load(String(item)),
    reply: int(reply),
    agent: str(agent),
  }));
}

/**
 * The conversation in the key's database, loaded once and kept in step with
 * it: the transcript, every turn's prompt and answer, as far back as a turn
 * needs it; and the window, the latest turns whole ({@link Turn}). Only the
 * latest turn is written; the conversation composes the turns into what the
 * model gets ({@link history}), until {@link seal} closes it.
 *
 * Tool calls and their results are matched by the call's id, within a turn:
 * each call's id must be its own, as model providers make them. A call whose
 * id an earlier call has is logged, as its result may be taken for the
 * other's.
 */
export class Conversation<I> {
  readonly #ledger: Ledger<I>;
  readonly #turns: Turn<I>[];
  readonly items: Items<I>;
  readonly budget: number;
  /** How many of the latest answered turns are loaded whole: the window's size. */
  readonly size: Window;

  readonly db: Database;

  constructor(
    db: Database,
    items: Items<I>,
    entries: Entry<I>[],
    {
      start = { n: 0, seq: 0 },
      transcript = entries.filter((e) => e.prompt !== undefined),
      last,
      seq = 0,
      budget = BUDGET,
      window = 'all',
    }: {
      start?: Start;
      transcript?: Entry<I>[];
      last?: number;
      seq?: number;
      budget?: number;
      window?: Window;
    } = {},
  ) {
    this.db = db;
    this.items = items;
    this.budget = budget;
    this.size = window;
    const positions = [last, entries.at(-1)?.n, transcript.at(-1)?.n].filter((n): n is number => n !== undefined);
    const following = Math.max(start.n, positions.length > 0 ? Math.max(...positions) + 1 : 0);
    this.#ledger = new Ledger(db, items, start, transcript, following, Math.max(start.seq, seq));
    const grouped: [Entry<I>, Entry<I>[]][] = [];
    for (const entry of entries) {
      if (entry.prompt !== undefined) grouped.push([entry, []]);
      else if (grouped.length > 0) grouped.at(-1)![1].push(entry);
      else throw new Error(`entry ${entry.n} comes before any turn's prompt`);
    }
    this.#turns = grouped.map(([prompt, rest]) => new Turn(this.#ledger, prompt, rest));
    if (this.#turns.length > 0 && transcript.length > 0 && this.#turns.at(-1)!.prompt === transcript.at(-1)) {
      this.#ledger.latest = this.#turns.at(-1);
    }
  }

  /**
   * Load the conversation from `db`: the transcript, and the window's turns
   * whole (the latest also while it has no answer). The transcript is read
   * from the latest turn back, in pages, until it holds the window and the
   * turns before it that `budget` holds, or the summary's start; with
   * `complete`, from the summary's start whatever the budget (to summarize
   * it).
   */
  static async load<I>(
    db: Database,
    items: Items<I>,
    window: Window = 'all',
    budget: number = BUDGET,
    { complete = false }: { complete?: boolean } = {},
  ): Promise<Conversation<I>> {
    checkWindow(window);
    await SCHEMA.ensure(db);
    const start = await startOf(db);
    const [last, seq] = await lastOf(db);
    const first = window === 'all' || start.summarized === undefined ? start.n : start.summarized;
    const transcript = await transcriptOf(
      db,
      items,
      first,
      window === 'all' || complete ? undefined : [window, budget],
    );
    const whole = transcript.slice(windowStart(transcript, window));
    const steps = whole.length > 0 ? await stepsAfter(db, items, whole[0]!.n) : [];
    const entries = [...whole, ...steps].toSorted((a, b) => a.n - b.n);
    return new Conversation(db, items, entries, { start, transcript, last, seq, budget, window });
  }

  // Reading: the conversation as a whole.

  /** The turns' prompts, in order, from the first the load read. Each has its turn's status, answer and what it carried. */
  get transcript(): readonly Entry<I>[] {
    return this.#ledger.transcript;
  }

  /** The window's turns, whole, in order: the last of them is the latest turn. */
  get turns(): readonly Turn<I>[] {
    return this.#turns;
  }

  /** The latest turn: the one being answered, during a run. */
  get turn(): Turn<I> {
    if (!this.#ledger.latest) throw new Error('the conversation has no turn loaded whole yet: ask first');
    return this.#ledger.latest;
  }

  /** The latest turn if it is being answered: it has no answer yet. */
  running(): Turn<I> | undefined {
    const latest = this.#ledger.latest;
    return latest && latest.status === undefined ? latest : undefined;
  }

  /** The window's turns, flat, in order: each prompt, then its turn's items. */
  get entries(): Entry<I>[] {
    return this.#turns.flatMap((turn) => turn.entries);
  }

  /** The summary of the turns before the transcript, if they have one (and the transcript is after them). */
  get summary(): string | undefined {
    const { transcript, start } = this.#ledger;
    const first = transcript[0]?.n ?? this.#ledger.next;
    return start.summarized !== undefined && first >= start.summarized ? start.summary : undefined;
  }

  /** Whether {@link seal} closed the conversation to writes. */
  get closed() {
    return this.#ledger.closed;
  }

  /** The answer of the turn of prompt `promptId`, if the transcript has it and it has one. */
  answerOf(promptId: string) {
    return this.#ledger.transcript.find((turn) => turn.prompt === promptId)?.answer;
  }

  /** The agent the conversation is with, and the framework's state, as the latest answered turn left them. */
  carried() {
    return this.#ledger.carried();
  }

  /** Whether a turn of the window holds the result of tool call `callId`: the model was given it. */
  knowsResult(callId: string) {
    return this.#turns.some((turn) => turn.hasResult(callId));
  }

  /** The position of the window's first turn: the turns before it are in the transcript only. */
  window() {
    return this.#turns[0]?.n ?? this.#ledger.next;
  }

  /** The size of `turn` as the transcript has it, in characters: its message and its answer. */
  #size(turn: Entry<I>) {
    return (parsedOf(this.items, turn).said?.[1] ?? '').length + (turn.answer ?? '').length;
  }

  /** The latest of `turns` that `characters` holds, in order. */
  #latest(turns: Entry<I>[], characters: number) {
    let kept = 0;
    for (const turn of turns.toReversed()) {
      characters -= this.#size(turn);
      if (characters < 0) break;
      kept += 1;
    }
    return turns.slice(turns.length - kept);
  }

  /** The turns before the window that {@link history} gives the model: the latest that `budget` holds. */
  earlier(): Entry<I>[] {
    const start = this.window();
    const before = this.#ledger.transcript.filter((turn) => turn.n < start && turn.answer !== undefined);
    return this.#latest(before, this.budget * 4);
  }

  /** The turns before the next turn's window (once the latest is answered), and the position the window starts at. */
  #upcoming(): [Entry<I>[], number] {
    const { transcript } = this.#ledger;
    if (this.size === 'all') return [[], transcript[0]?.n ?? this.#ledger.next];
    const first = windowStart(transcript, this.size);
    const start = first < transcript.length ? transcript[first]!.n : this.#ledger.next;
    return [transcript.slice(0, first).filter((turn) => turn.answer !== undefined), start];
  }

  /** Whether the turns before the next turn's window outgrow `budget`: then they are summarized. */
  overflowing() {
    const [before] = this.#upcoming();
    return before.reduce((sum, turn) => sum + this.#size(turn), 0) > this.budget * 4;
  }

  /**
   * The turns to summarize, and the position of the first turn after them,
   * if any are to be: the turns before the next turn's window but the latest
   * that half the `budget` holds, which stay as they are.
   */
  toSummarize(): [Entry<I>[], number] | undefined {
    const [before, start] = this.#upcoming();
    const kept = this.#latest(before, this.budget * 2);
    const summarized = before.slice(0, before.length - kept.length);
    if (summarized.length === 0) return undefined;
    return [summarized, kept[0]?.n ?? start];
  }

  /**
   * The items the model gets, in order, the one place where turns are made
   * one flat list: the summary of the earliest turns, if they have one; the
   * turns before the window, as their prompts and answers, as many of the
   * latest as `budget` holds; then the window's turns, whole.
   */
  history(): I[] {
    const out: I[] = [];
    const summary = this.summary;
    if (summary !== undefined) out.push(...summaryItems(this.items, summary));
    for (const turn of this.earlier()) out.push(turn.item, this.items.reply(turn.answer ?? '', turn.agent));
    for (const turn of this.#turns) for (const entry of turn.entries) out.push(entry.item);
    return out;
  }

  // Writing.

  /** Start the turn of prompt `promptId`, with `text`, and return it: the latest turn now. */
  ask(promptId: string, text: string): Promise<Turn<I>> {
    const ledger = this.#ledger;
    return ledger.lock.run(async () => {
      ledger.checkOpen();
      const running = this.running();
      if (running) throw new Error(`turn ${running.id} has no answer yet: turns never overlap`);
      const n = ledger.next;
      const entry: Entry<I> = { n, item: this.items.prompt(text), prompt: promptId, askedAt: Date.now() };
      await this.db.execute(`INSERT INTO ${TURNS} (n, seq, prompt, item, asked_at) VALUES (?, ?, ?, ?, ?)`, [
        n,
        ledger.seq + 1,
        promptId,
        this.items.dump(entry.item),
        entry.askedAt!,
      ]);
      ledger.seq += 1;
      ledger.next = n + 1;
      ledger.transcript.push(entry);
      const turn = new Turn(ledger, entry);
      this.#turns.push(turn);
      ledger.latest = turn;
      return turn;
    });
  }

  /**
   * Close the conversation to writes, once those under way are stored: for
   * a stopped run, which (unwinding, or a promise of it left behind) stores
   * nothing more once its turn is closed.
   */
  async seal() {
    await this.#ledger.lock.run(async () => {
      this.#ledger.closed = true;
    });
  }
}

/**
 * A framework's run: from the conversation, whose latest turn
 * (`conversation.turn`) is the one to answer (just asked, or left unfinished
 * by an earlier attempt), to its answer. It reads what the model gets from
 * the conversation (`history()`), and stores each step in the turn as it
 * goes. A tool's error fails the attempt.
 */
export type Run<I> = (conversation: Conversation<I>) => Promise<string>;

/** The id of the invocation that made prompt `promptId` (see `nextPromptId`). */
export const invocationOf = (promptId: string) => promptId.split(':', 1)[0]!;

/**
 * Answer the prompt `text` with a framework's `run`, once. The prompt's id is
 * the invocation's (`nextPromptId`), so a retried attempt returns the stored
 * answer (reading only it), or goes on with the turn. A turn an earlier
 * invocation left without an answer is closed first ({@link ENDED}): that
 * invocation is gone. `items` must be the agent's `messages` view's, if it
 * has one: one framework per agent.
 *
 * `window` and `budget` are the agent's unless given. With `check`, the
 * answer is checked: a message it returns asks the model again with it,
 * once, as a step of the turn ({@link Turn.askAgain}), and the turn's answer
 * is the reply to that.
 */
export async function answerOnce<I>(
  ctx: restate.SessionContext,
  text: string,
  items: Items<I>,
  run: Run<I>,
  options: { window?: Window; budget?: number; check?: Check } = {},
): Promise<string> {
  const settings = settingsOf(ctx);
  // One framework per agent (D7): its conversation holds its `messages` view's items, which another can't read.
  if (settings.items !== undefined && settings.items !== items) {
    throw new restate.TerminalError(
      "this agent's `messages` view is another framework's: an agent's conversation holds one framework's items",
    );
  }
  const window = checkWindow(options.window ?? settings.window);
  const budget = options.budget ?? settings.budget;
  const promptId = nextPromptId(ctx);
  await SCHEMA.ensure(ctx.db);
  const stored = await answerIn(ctx.db, promptId);
  // Answered (or closed) already: a retry answers, or fails, as the turn ended.
  if (stored !== undefined) return storedAnswer(stored.answer, stored.status);
  const conversation = await Conversation.load(ctx.db, items, window, budget);
  const answered = await forPrompt(ctx, promptId, () =>
    answering(
      ctx,
      // The Restate calls of this invocation are its turn's: the latest, answered
      // or not (its end forgets the calls whose results it stored).
      (callId, failedWith) => {
        const turn = conversation.turns.at(-1);
        return turn !== undefined && turn.id === promptId && turn.stored(callId, failedWith);
      },
      () => answerTurn(ctx, conversation, promptId, text, run, options.check),
    ),
  );
  const definition = definitionOf(ctx) as { name: string } | undefined;
  if (settings.summarize && conversation.overflowing() && definition) {
    // Compacted in an invocation of its own, which the key runs before its next message.
    ctx.send({ service: definition.name, handler: 'compact', key: ctx.key, idempotencyKey: `${promptId}:compact` });
  }
  return answered;
}

/** Answer the turn of `promptId` (ending one another invocation left first), as `answerOnce` says. */
async function answerTurn<I>(
  ctx: restate.SessionContext,
  conversation: Conversation<I>,
  promptId: string,
  text: string,
  run: Run<I>,
  check: Check | undefined,
): Promise<string> {
  let running = conversation.running();
  if (running && running.id !== promptId) {
    // Turns never overlap, so the invocation of this one is gone: it ends unanswered.
    await running.close(ctx, 'ended', ENDED);
    running = undefined;
  }
  const turn = running ?? (await conversation.ask(promptId, text));
  const going = (async () => {
    let answered = await run(conversation);
    // Once at most: a turn that asked again (in an earlier attempt, say) answers with the reply to that.
    for (let again = check?.(answered); again !== undefined && turn.latestAsk() === turn.prompt; again = undefined) {
      await turn.askAgain(again);
      answered = await run(conversation);
    }
    return answered;
  })();
  const stop = stopSignalOf(ctx);
  let answered: string;
  try {
    answered = await (stop ? Promise.race([going, aborted(stop)]) : going);
  } catch (error) {
    if (stop) going.catch(() => {}); // a run left behind: it stores nothing more once its turn is closed
    if (error instanceof AttemptEnded) throw error; // the next attempt goes on with the run
    if (error instanceof restate.CancelledError) {
      // Cancelled: close the turn, so that the next prompt starts afresh.
      await turn.close(ctx, 'cancelled', CANCELLED);
      await conversation.seal();
      throw error;
    }
    // Refused for good (a wrong API key, say): closed unanswered, and a
    // terminal error. A framework's own 424 is one (a model it cannot take,
    // its provider's refusal), as is an error a retry would meet again.
    const refused =
      error instanceof restate.TerminalError ? (error.code === REFUSED ? error : undefined) : refusalOf(ctx, error);
    if (refused) {
      await turn.close(ctx, 'refused', UNANSWERED);
      throw refused;
    }
    if (error instanceof restate.TerminalError) {
      // Failed for good: closed with the error, so that the next prompt does not run into it again.
      await turn.close(ctx, 'failed', `Error: ${error.message}`);
      throw error;
    }
    throw error;
  }
  await turn.answered(answered);
  return storedAnswer(answered);
}

/**
 * Close the latest turn (`ended`) if invocation `invocationId` made it and
 * left it without an answer: the companion has this done when it finds the
 * turn's invocation gone. A turn with its answer (closed by a newer turn
 * first, say) is left as it is. Whether it closed the turn.
 */
export async function settle<I>(ctx: restate.SessionContext, items: Items<I>, invocationId: string): Promise<boolean> {
  await SCHEMA.ensure(ctx.db);
  const row = await ctx.db.get(`SELECT prompt, status FROM ${TURNS} ORDER BY n DESC LIMIT 1`);
  if (!row || row.status !== null || invocationOf(String(row.prompt)) !== invocationId) return false;
  const running = (await Conversation.load(ctx.db, items, 0)).running();
  if (!running) return false;
  await running.close(ctx, 'ended', ENDED);
  return true;
}

/** `turns` as text, after the summary of the turns before them, if any: what is summarized. */
function transcribed<I>(conversation: Conversation<I>, turns: Entry<I>[]) {
  const lines = conversation.summary ? [`Summary of the conversation before:\n${conversation.summary}\n`] : [];
  for (const turn of turns) {
    const said = parsedOf(conversation.items, turn).said?.[1] ?? '';
    lines.push(`User: ${said}\nAssistant: ${turn.answer ?? ''}\n`);
  }
  return lines.join('\n');
}

/**
 * Summarize the turns before the window that outgrow the agent's budget,
 * with the agent's `summarize`. The summary, of the earlier summary and those
 * turns, takes their place in what the model sees; the turns stay stored,
 * and `messages` shows them as before. A summary that fails is logged, and
 * tried again after the next turn. Whether it summarized.
 */
export async function compact<I>(ctx: restate.SessionContext, items: Items<I>): Promise<boolean> {
  const settings = settingsOf(ctx);
  if (!settings.summarize) return false;
  const conversation = await Conversation.load(ctx.db, items, settings.window, settings.budget, { complete: true });
  const found = conversation.overflowing() ? conversation.toSummarize() : undefined;
  if (!found) return false;
  const [turns, after] = found;
  let summary: string;
  try {
    summary = await settings.summarize(ctx, SUMMARIZE + transcribed(conversation, turns));
  } catch (error) {
    if (error instanceof restate.CancelledError) throw error;
    console.warn(`Summarizing the earlier turns failed, and is tried again after the next turn: ${String(error)}`);
    return false;
  }
  await restart(ctx.db, { ...(await startOf(ctx.db)), summary, summarized: after });
  return true;
}
