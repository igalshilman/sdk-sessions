// The conversation as clients read it: the `messages` view's pages, rendered
// from the conversation's rows (conversation.ts), as the Python SDK's
// `_messages.py`.
//
// A message is what a person sees: the user's text, or the assistant's text
// and tool calls, each call with its output once it has one. It is made of
// rows of the conversation: the row that starts it (whose position is the
// message's id), and the rows that add to it (a tool call's result comes
// later, in a row of its own). A message changes when a row is added to it,
// so its `seq` is the latest of its rows', and a client that follows the
// conversation from a cursor gets each message again whenever it changes.
//
// A turn's prompt always starts a message, and the rows of its trajectory
// only add to messages of their own turn. So the messages from any turn on
// are rendered from the rows of both tables from that turn's position on, in
// order, and a page reads only the rows it needs.
//
// The summary view is each turn's message of the user and its answer, from
// the turns' rows, and the messages steered to the turn that it took, under
// the ids they have in the full view.
import type { DatabaseReader, ViewContext } from '@restatedev/sessions';
import { type ChatMessage, ITEMS, type Messages, type MessagesRequest, type Part } from './common.ts';
import { failed, type Items, lastOf, loadItem, SCHEMA, startOf, STEERED, STEPS, TURNS } from './conversation.ts';

/** A message as rendered, with when it last changed. */
interface Rendered {
  id: number;
  role: ChatMessage['role'];
  parts: Part[];
  /** The latest `seq` of its rows. */
  seq: number;
}

/** The conversation's `rows` (`n`, `seq`, `item`, in order) as messages, without the empty ones. */
function render<I>(items: Items<I>, rows: unknown[][]): Rendered[] {
  const messages: Rendered[] = [];
  /** Each tool call's message, by the call's id. */
  const at = new Map<string, Rendered>();
  for (const [n, seq, stored] of rows) {
    const position = Number(n);
    const changed = Number(seq);
    const { said, calls = [], results = [] } = items.read(loadItem(items, String(stored)));
    if (said) {
      const [role, text] = said;
      messages.push({ id: position, role: role === 'user' ? 'user' : 'assistant', parts: [], seq: changed });
      if (text.trim()) messages.at(-1)!.parts.push({ type: 'text', text });
    }
    for (const call of calls) {
      if (messages.at(-1)?.role !== 'assistant') {
        messages.push({ id: position, role: 'assistant', parts: [], seq: changed });
      }
      const message = messages.at(-1)!;
      message.parts.push({ type: 'tool', id: call.id, name: call.name, input: call.input });
      message.seq = changed;
      at.set(call.id, message);
    }
    for (const result of results) {
      const answered = at.get(result.id);
      if (!answered) continue;
      const error = failed(result);
      answered.parts = answered.parts.map((part) =>
        part.type === 'tool' && part.id === result.id
          ? { ...part, output: result.output, ...(error ? { error: true as const } : {}) }
          : part,
      );
      answered.seq = changed;
    }
  }
  return messages.filter((message) => message.parts.length > 0);
}

const chat = ({ id, role, parts }: Rendered): ChatMessage => ({ id, role, parts });

/** The latest `limit` of `messages`: none for a limit of 0 (`slice(-0)` would be all of them). */
const latestOf = (messages: Rendered[], limit: number) => (limit > 0 ? messages.slice(-limit) : []);

/**
 * A page of the conversation in `db`, whose items are `items`'. With a
 * `cursor`: the messages that changed since it, in the order they changed,
 * and the cursor to read on from. Without: the latest `limit` messages (or
 * the latest before id `before`), oldest first, and the cursor to follow the
 * conversation from. `view: 'summary'` gives each turn's message and answer.
 */
export async function page<I>(db: DatabaseReader, items: Items<I>, request: MessagesRequest = {}): Promise<Messages> {
  const { limit = 50, before, cursor, view } = request;
  await SCHEMA.ensure(db);
  const start = await startOf(db);
  const summary = view === 'summary';
  const result =
    cursor === undefined
      ? await (summary ? summaryLatest : latest)(db, items, before, limit)
      : await (summary ? summarySince : since)(db, items, cursor, limit);
  return start.n ? { ...result, first: start.n } : result;
}

/**
 * The rows (`n`, `seq`, `item`) of the transcript and the trajectories from
 * position `first` on, before position `until` if given, in order.
 */
async function rowsFrom(db: DatabaseReader, first: number, until = Number.MAX_SAFE_INTEGER) {
  const range = 'WHERE n >= ? AND n < ? ORDER BY n';
  const turns = await db.values(`SELECT n, seq, item FROM ${TURNS} ${range}`, [first, until]);
  const steps = await db.values(`SELECT n, seq, item FROM ${STEPS} ${range}`, [first, until]);
  return [...turns, ...steps].toSorted((a, b) => Number(a[0]) - Number(b[0]));
}

/** Whether the conversation has a turn before a position: a page that starts there has more before it. */
const EARLIER = `SELECT EXISTS (SELECT 1 FROM ${TURNS} WHERE n < ?)`;

/** The first value of the first row of `sql`. */
const one = async (db: DatabaseReader, sql: string, params: unknown[]) =>
  (await db.values(sql, params as never))[0]?.[0];

/** The cursor of the conversation as it is now. */
async function now(db: DatabaseReader) {
  const start = await startOf(db);
  const [, seq] = await lastOf(db);
  return Math.max(start.seq, seq);
}

/** The messages that changed since `cursor`, rendered from the turn of the earliest change on. */
async function since<I>(db: DatabaseReader, items: Items<I>, cursor: number, limit: number): Promise<Messages> {
  const prompt = await one(db, `SELECT MIN(n) FROM ${TURNS} WHERE seq > ?`, [cursor]);
  const step = await one(db, `SELECT MIN(turn) FROM ${STEPS} WHERE seq > ?`, [cursor]);
  const changed = [prompt, step].filter((n) => n !== null && n !== undefined).map(Number);
  if (changed.length === 0) return { messages: [], more: false, cursor };
  const messages = render(items, await rowsFrom(db, Math.min(...changed)))
    .filter((m) => m.seq > cursor)
    .toSorted((a, b) => a.seq - b.seq);
  const shown = messages.slice(0, limit);
  return { messages: shown.map(chat), more: messages.length > limit, cursor: shown.at(-1)?.seq ?? cursor };
}

/**
 * The latest `limit` messages before id `before`, rendered from enough turns
 * back to hold them: each turn starts with a message, so the rows from the
 * `limit + 1`-th latest turn before `before` on hold more than `limit`. And
 * to no later than the turn `before` is in: a turn's rows add only to its
 * own messages, so the turns from `before` on change none before it.
 */
async function latest<I>(
  db: DatabaseReader,
  items: Items<I>,
  before: number | undefined,
  limit: number,
): Promise<Messages> {
  const end = before ?? Number.MAX_SAFE_INTEGER;
  const first = await one(
    db,
    `SELECT COALESCE((SELECT n FROM ${TURNS} WHERE n < ? ORDER BY n DESC LIMIT 1 OFFSET ?), (SELECT MIN(n) FROM ${TURNS}))`,
    [end, limit],
  );
  const cursor = await now(db);
  if (first === null || first === undefined) return { messages: [], more: false, cursor };
  const until = before === undefined ? undefined : await one(db, `SELECT MIN(n) FROM ${TURNS} WHERE n >= ?`, [end]);
  const rows = await rowsFrom(db, Number(first), until === null || until === undefined ? undefined : Number(until));
  const messages = render(items, rows).filter((m) => m.id < end);
  const earlier = await one(db, EARLIER, [first]);
  return {
    messages: latestOf(messages, limit).map(chat),
    more: messages.length > limit || Boolean(Number(earlier)),
    cursor,
  };
}

/** The columns of a turn the summary view reads. */
const TURN = `SELECT n, seq, item, answer, answered_at, answered_seq FROM ${TURNS}`;

/** The messages steered to turns that took them (`n`, `seq`, `item`): messages of the user, which the summary shows too. */
const STEERS = `SELECT st.n, s.seq, s.item FROM ${STEERED} st JOIN ${STEPS} s ON s.n = st.n`;

/**
 * Turns' rows ({@link TURN}'s columns) as their user's messages and answers,
 * with the messages steered to them (`steered`, {@link STEERS}'s columns),
 * in order: the answer's message has the id it has in the full view (the
 * turn's last message of the assistant), and the `seq` it was stored with;
 * so does a steered message.
 */
function summarized<I>(items: Items<I>, rows: unknown[][], steered: unknown[][] = []): Rendered[] {
  const messages: Rendered[] = [];
  const user = (n: unknown, seq: unknown, stored: unknown): Rendered => {
    const text = items.read(loadItem(items, String(stored))).said?.[1] ?? '';
    return { id: Number(n), role: 'user', parts: text.trim() ? [{ type: 'text', text }] : [], seq: Number(seq) };
  };
  for (const [n, seq, stored, answer, answeredAt, answeredSeq] of rows) {
    messages.push(user(n, seq, stored));
    if (answer !== null && answer !== undefined && answeredAt !== null && answeredAt !== undefined) {
      const answered = typeof answer === 'string' ? answer : JSON.stringify(answer);
      messages.push({
        id: Number(answeredAt),
        role: 'assistant',
        parts: answered.trim() ? [{ type: 'text', text: answered }] : [],
        seq: Number(answeredSeq),
      });
    }
  }
  for (const [n, seq, stored] of steered) messages.push(user(n, seq, stored));
  return messages.filter((message) => message.parts.length > 0).toSorted((a, b) => a.id - b.id);
}

/** The user's messages and answers stored since `cursor`, in the order they were. */
async function summarySince<I>(db: DatabaseReader, items: Items<I>, cursor: number, limit: number): Promise<Messages> {
  const asked = await db.values(`${TURN} WHERE seq > ?`, [cursor]);
  const answered = await db.values(`${TURN} WHERE answered_seq > ?`, [cursor]);
  const steered = await db.values(`${STEERS} WHERE s.seq > ?`, [cursor]);
  const rows = new Map([...asked, ...answered].map((row) => [Number(row[0]), row]));
  const messages = summarized(items, [...rows.values()], steered)
    .filter((m) => m.seq > cursor)
    .toSorted((a, b) => a.seq - b.seq);
  const shown = messages.slice(0, limit);
  return { messages: shown.map(chat), more: messages.length > limit, cursor: shown.at(-1)?.seq ?? cursor };
}

/** The latest `limit` user's messages and answers before id `before`: from as many turns, at most. */
async function summaryLatest<I>(
  db: DatabaseReader,
  items: Items<I>,
  before: number | undefined,
  limit: number,
): Promise<Messages> {
  const end = before ?? Number.MAX_SAFE_INTEGER;
  const rows = await db.values(`${TURN} WHERE n < ? ORDER BY n DESC LIMIT ?`, [end, limit]);
  const cursor = await now(db);
  const first = rows.length > 0 ? Number(rows.at(-1)![0]) : end;
  const steered = await db.values(`${STEERS} WHERE st.n >= ? AND st.n < ? ORDER BY st.n`, [first, end]);
  const messages = summarized(items, rows.toReversed(), steered).filter((m) => m.id < end);
  const earlier = await one(db, EARLIER, [first]);
  return {
    messages: latestOf(messages, limit).map(chat),
    more: messages.length > limit || Boolean(Number(earlier)),
    cursor,
  };
}

/**
 * The `messages` view of an agent whose framework keeps the conversation of
 * turns, with its `items`: `sessionObject` finds them on it, and gives the
 * agent `settle` and `compact`, and `clear` that keeps the ids going.
 */
export const conversationView = <I>(items: Items<I>) =>
  ITEMS.on(
    async (ctx: ViewContext, request?: MessagesRequest): Promise<Messages> => page(ctx.db, items, request ?? {}),
    items,
  );
