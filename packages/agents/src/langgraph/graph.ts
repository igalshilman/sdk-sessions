// An agent whose `chat` runs a LangGraph graph of your own:
// `langgraph.agent({ name, graph })`, as the Python SDK's
// restate/agents/langgraph/_graph.py.
//
// The graph's state has LangGraph's `messages` (`MessagesAnnotation`), and
// each message to the agent is a run of the graph on the key's thread, with
// the message as a new `HumanMessage`:
//
// - The graph's checkpoints are in the key's database (`SqlCheckpointSaver`),
//   stored before each step runs (`durability: 'sync'`), and the prebuilt
//   nodes (nodes.ts) and the tools of `tools()` get the handler's context
//   there (context.ts). LangGraph's run context is the graph's own (`context`),
//   else the handler's. A retried attempt resumes the run it cut off. A run
//   that finishes prunes the thread to the latest checkpoint of each
//   namespace, and what LangGraph rebuilds its delta channels from.
// - Any error of the run fails the attempt, and Restate retries it: none is
//   taken for a model provider's refusal, as the built-in agent's model's
//   can be, since a graph's models, tools and nodes are all its own. A
//   `TerminalError` ends the turn, and so do LangGraph's own errors that a
//   retry would meet again (errors.ts). A run that an invalid update ended
//   leaves writes that LangGraph cannot apply: the next message starts its
//   run from the checkpoint before them, as a new run discards them.
// - After each step, the AI and tool messages the step added are copied into
//   the agent's conversation, by their ids, so that the `messages` view (and
//   `watch`) shows the run as it goes. They are the messages after the run's
//   prompt; if the graph trimmed the prompt away, those whose ids the
//   conversation does not have. With `durability: 'sync'`, LangGraph streams
//   a step's state only once its checkpoint is stored, so the conversation
//   never gets ahead of the checkpoints; a crash between a checkpoint and its
//   copy is made up by the next step's state, as messages are copied by id.
//   The conversation is a log: a message the graph removes or edits later
//   stays as it was copied.
// - The answer is the text of the run's last AI message. A graph that writes
//   a `structuredResponse` in the run (LangChain's `createAgent` with a
//   `responseFormat`) answers with it instead, as JSON, which `output`
//   validates; one left from an earlier run is not the answer.
// - LangGraph's `interrupt()` waits for a signal: each pending interrupt is
//   a wait named `interrupt`, which the agent's `pending` view lists with the
//   interrupt's value, and which `signal` resolves (by the wait's id, or as
//   the oldest `interrupt`). The run then resumes with `new Command({ resume
//   })`, the signal's value as `interrupt()`'s result. The turn waits without
//   holding a process; a retried attempt joins the same waits. Static
//   breakpoints (`interruptBefore`, `interruptAfter`) have nothing to wait
//   for: a compiled graph with them is refused, and a run that stops at a
//   subgraph's fails.
// - A stopped run is not resumed: the next message starts a run of its own,
//   from the state the graph had stored. What closed the stopped (or
//   refused, or failed) run in the conversation comes first in the new run's
//   input: the results of its cut-off tool calls, and the note that ends it,
//   so that the graph's model knows. So does that run's message, if the graph
//   never stored it.
//
// The graph's state is its own: its models read the state, not the
// conversation, so the agent's `window`, `budget` and `summarize` do not
// reach them. Trimming the state is the graph's job (a node that returns a
// `RemoveMessage` for each message to drop, say).
import * as restate from '@restatedev/sessions';
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { mapStoredMessagesToChatMessages } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, InvalidUpdateError, type Pregel, type StateSnapshot, StateGraph } from '@langchain/langgraph';
import { fromTool, stepped, stopSignalOf } from '../common.ts';
import type { Conversation, Run, Turn } from '../conversation.ts';
import { signals, signalsOf } from '../signals.ts';
import { SqlCheckpointSaver } from './checkpointer.ts';
import { running } from './context.ts';
import { terminalOf } from './errors.ts';

/** A graph of your own: a `StateGraph` (not compiled), or a compiled one such as LangChain's `createAgent` makes. */
export type AnyGraph =
  // oxlint-disable-next-line typescript/no-explicit-any -- any graph's state, update, nodes and context
  | StateGraph<any, any, any, any, any, any, any, any, any, any>
  // oxlint-disable-next-line typescript/no-explicit-any -- any compiled graph's
  | Pregel<any, any, any, any, any, any, any, any, any, any, any>;

/** The graph's thread: there is one per key, as the key's database is its own. */
export const THREAD_ID = 'chat';
const THREAD = { configurable: { thread_id: THREAD_ID } };

/** Why a graph with static breakpoints is refused, and a run stopped at a subgraph's fails. */
export const BREAKPOINTS =
  'static breakpoints (interruptBefore, interruptAfter) stop a run with nothing to wait for, and leave its tool ' +
  'calls without results: pause the graph with interrupt() instead, which waits for a signal';

/**
 * Throw a `TypeError` if `graph` has no `messages` in its state, or is
 * compiled with static breakpoints. A subgraph's static breakpoints are found
 * when one stops a run, which then fails: LangGraph has no public way to find
 * every subgraph (a node may call one it makes).
 */
export function check(graph: AnyGraph) {
  if (!('messages' in (graph.channels as object))) {
    throw new TypeError("the graph's state has no messages: build it on LangGraph's MessagesAnnotation");
  }
  if (!(graph instanceof StateGraph) && (graph.interruptBefore?.length || graph.interruptAfter?.length)) {
    throw new TypeError(BREAKPOINTS);
  }
}

/** A compiled graph, as the run uses it: untyped, as the graph is the user's. */
interface App {
  checkpointer: SqlCheckpointSaver;
  getState(config: RunnableConfig): Promise<StateSnapshot>;
  stream(input: unknown, options: Record<string, unknown>): Promise<AsyncIterable<Record<string, unknown>>>;
}

/** `graph` compiled with its checkpoints in `saver`. */
function compiled(graph: AnyGraph, saver: SqlCheckpointSaver): App {
  if (graph instanceof StateGraph) return graph.compile({ checkpointer: saver }) as unknown as App;
  // A copy, as `withConfig` makes one: the graph is shared by every key's runs.
  const Compiled = graph.constructor as new (fields: object) => App;
  // oxlint-disable-next-line typescript/no-misused-spread -- the graph's fields, as its constructor takes them
  return new Compiled({ ...graph, checkpointer: saver });
}

/** The key, in each checkpoint's metadata, of the prompt whose run made it: the run's input may be trimmed away. */
const PROMPT = 'restate_prompt';
/** The state field of a structured answer, as LangChain's `createAgent` writes it. */
const STRUCTURED = 'structuredResponse';
/** The key, in each checkpoint's metadata, of the version the structured answer's channel had as its run began. */
const STRUCTURED_BEFORE = 'restate_structured_version';
/** The prefixes of the ids of the messages that the conversation gave the graph, rather than the graph made. */
const CARRIED = ['prompt:', 'closed:'];

/** The ids of the graph's messages that the conversation has: those copied from it. */
const knownOf = (conversation: Conversation<BaseMessage>) =>
  new Set(conversation.entries.flatMap((e) => (e.item.id === undefined ? [] : [e.item.id])));

/** The version of the graph's structured answer's channel, which changes each time it is written. */
async function structuredVersion(app: App): Promise<string> {
  const stored = await app.checkpointer.getTuple(THREAD);
  return String(stored?.checkpoint.channel_versions[STRUCTURED] ?? '');
}

/**
 * The run's answer: the JSON of the structured answer it wrote, else its last
 * AI message's text. A structured answer counts only if the run wrote it (its
 * channel's version is not `before`): the state keeps an earlier run's. The
 * text is read from the conversation, a log, as the graph may have trimmed
 * its own history (the run's input and answer included).
 */
async function answerOf(app: App, turn: Turn<BaseMessage>, state: Record<string, unknown>, before: string) {
  const structured = state[STRUCTURED];
  if (structured !== undefined && structured !== null && (await structuredVersion(app)) !== before) {
    return JSON.stringify(structured);
  }
  const replies = turn.items.flatMap((e) => (AIMessage.isInstance(e.item) && e.item.id !== undefined ? [e.item] : []));
  return replies.at(-1)?.text ?? '';
}

/**
 * Copy the AI and tool messages of `messages` (the graph's state) that the
 * conversation does not have yet: those after the run's prompt (whose id is
 * `prompt`), as the state holds the earlier turns too; if the graph trimmed
 * the prompt away, those whose ids are not `known`. `known` is the ids the
 * conversation has, which this adds to; the messages the conversation gave
 * the graph are not copied back. Then publish.
 */
async function copied(
  ctx: restate.SessionContext,
  turn: Turn<BaseMessage>,
  known: Set<string>,
  messages: readonly BaseMessage[],
  prompt: string,
) {
  const at = messages.findIndex((m) => m.id === prompt);
  const fresh = messages
    .slice(at + 1)
    .filter(
      (m) =>
        (AIMessage.isInstance(m) || ToolMessage.isInstance(m)) &&
        m.id !== undefined &&
        !known.has(m.id) &&
        !CARRIED.some((prefix) => m.id!.startsWith(prefix)),
    );
  for (const message of fresh) {
    if (AIMessage.isInstance(message)) await turn.appendReply([message]);
    else await turn.append(message);
    known.add(message.id!);
  }
  if (fresh.length > 0) await stepped(ctx);
}

/** The id of a turn's prompt, as a `HumanMessage` in the graph: the conversation's id of the turn. */
const promptIdOf = (turn: Turn<BaseMessage>) => `prompt:${turn.id}`;

/** `message` with the id `id`. */
const withId = (message: BaseMessage, id: string): BaseMessage => {
  const stored = message.toDict();
  return mapStoredMessagesToChatMessages([{ ...stored, data: { ...stored.data, id } }])[0]!;
};

/**
 * What the conversation has of the previous prompt's run that the graph does
 * not: what closed the run, if it was stopped, refused or failed (the results
 * of its cut-off tool calls and the note that ends it, which only the
 * conversation has: copied messages have the graph's ids, these have none),
 * and the previous prompt itself, if the graph never stored it (its run
 * copied nothing). Each gets an id of its own, so that it is carried once.
 */
function closing(
  conversation: Conversation<BaseMessage>,
  turn: Turn<BaseMessage>,
  messages: readonly BaseMessage[],
): BaseMessage[] {
  const turns = conversation.turns;
  const at = turns.indexOf(turn);
  if (at <= 0) return [];
  const previous = turns[at - 1]!;
  const known = new Set(messages.map((m) => m.id));
  const copiedAny = previous.items.some((e) => e.item.id !== undefined);
  // Only a turn the conversation closed (stopped, refused, failed, ended) has messages the graph lacks.
  const closed = previous.status !== undefined && previous.status !== 'answered';
  const carried: BaseMessage[] = [];
  for (const entry of previous.entries) {
    const item = entry.item;
    if (entry.prompt !== undefined) {
      if (!copiedAny && !known.has(promptIdOf(previous))) {
        carried.push(new HumanMessage({ content: item.text, id: promptIdOf(previous) }));
      }
    } else if (closed && !HumanMessage.isInstance(item) && item.id === undefined && !known.has(`closed:${entry.n}`)) {
      carried.push(withId(item, `closed:${entry.n}`));
    }
  }
  return carried;
}

/** The name of the signal that answers LangGraph's `interrupt()`. */
export const INTERRUPT = 'interrupt';

/**
 * The pending interrupts of the run, each once: LangGraph keeps each on the
 * task whose step raised it, a subgraph's included, and each graph above that
 * task lists it again, under the same id.
 */
function interruptsOf(snapshot: StateSnapshot) {
  const pending = new Map<string, { id: string; value?: unknown }>();
  for (const task of snapshot.tasks) {
    for (const interrupted of task.interrupts ?? []) {
      if (interrupted.id !== undefined && !pending.has(interrupted.id)) {
        pending.set(interrupted.id, { id: interrupted.id, value: interrupted.value });
      }
    }
  }
  return [...pending.values()];
}

/**
 * How many resume values the thread's pending writes hold: one more each
 * time an `interrupt()` is answered, until its step ends. LangGraph gives an
 * interrupt the id of its task's namespace, so a node's second `interrupt()`
 * has its first's id: the count tells them apart.
 */
async function resumesOf(ctx: restate.SessionContext, saver: SqlCheckpointSaver) {
  const rows = await ctx.db.values(
    "SELECT type, value FROM restate_langgraph_writes WHERE thread_id = ? AND channel = '__resume__'",
    [THREAD_ID],
  );
  let count = 0;
  for (const [type, value] of rows) {
    const resumes: unknown = await saver.serde.loadsTyped(String(type), value as Uint8Array);
    count += Array.isArray(resumes) ? resumes.length : 1;
  }
  return count;
}

/**
 * Wait for a signal for each pending interrupt of `snapshot`, and return
 * their values by interrupt id, or `undefined` if none is pending. Each
 * wait's id is the turn's invocation id (the same in each attempt), the
 * interrupt's id, and the count of resume values stored (see
 * {@link resumesOf}): a retried attempt joins the same waits, and a turn that
 * ends without them has them closed, as the companion closes the waits whose
 * ids start with the turn's.
 */
async function resumed(ctx: restate.SessionContext, saver: SqlCheckpointSaver, snapshot: StateSnapshot) {
  const pending = interruptsOf(snapshot);
  if (pending.length === 0) return undefined;
  const resumes = await resumesOf(ctx, saver);
  const values = await Promise.all(
    pending.map(({ id, value }) => {
      const waitId = `${ctx.request.id}:interrupt:${id}:${resumes}`;
      // As JSON, which the companion stores: the state may hold class instances.
      const input = value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
      return ctx
        .rpc(signals, signalsOf(ctx), { idempotencyKey: waitId })
        .wait({ id: waitId, name: INTERRUPT, ...(input === undefined ? {} : { input }) });
    }),
  );
  return Object.fromEntries(pending.map(({ id }, i) => [id, values[i]]));
}

/** Whether a run stopped with steps to go and no interrupt: at a static breakpoint. */
const atBreakpoint = (paused: StateSnapshot) =>
  paused.next.length > 0 && !paused.tasks.some((task) => (task.interrupts ?? []).length > 0);

/**
 * The state of the graph's thread: where it stopped, and why (its tasks'
 * interrupts). If the writes of the last step's tasks do not fit the state
 * (an invalid update), it is the state of the checkpoint itself, which
 * LangGraph shows without them: a run with new input discards them.
 */
async function storedState(app: App): Promise<StateSnapshot> {
  try {
    return await app.getState(THREAD);
  } catch (error) {
    if (!(error instanceof InvalidUpdateError)) throw error;
    const latest = await app.checkpointer.getTuple(THREAD);
    if (!latest) throw error;
    return app.getState(latest.config);
  }
}

/**
 * The run of a prompt: the graph's, on the key's thread, from the prompt to
 * its answer. `context` is the graph's run context, if not the handler's.
 */
export const graphRun =
  (ctx: restate.SessionContext, graph: AnyGraph, context?: unknown): Run<BaseMessage> =>
  (conversation) =>
    running(ctx, () => runGraph(ctx, graph, context ?? ctx, conversation));

async function runGraph(
  ctx: restate.SessionContext,
  graph: AnyGraph,
  context: unknown,
  conversation: Conversation<BaseMessage>,
): Promise<string> {
  const turn = conversation.turn;
  // The run's input: the turn's prompt, or the message that asked again within the turn, under an id of its own.
  const step = turn.latestAsk();
  const promptId = step === turn.prompt ? promptIdOf(turn) : `${promptIdOf(turn)}:again:${step.n}`;
  const app = compiled(graph, new SqlCheckpointSaver(ctx.db));
  const snapshot = await storedState(app);
  let values = snapshot.values as Record<string, unknown>;
  const messages = (values.messages ?? []) as BaseMessage[];
  const known = knownOf(conversation);
  const metadata = (snapshot.metadata ?? {}) as Record<string, unknown>;
  const asked = metadata[PROMPT] === promptId;
  const stamped = metadata[STRUCTURED_BEFORE];
  const before = asked ? (typeof stamped === 'string' ? stamped : '') : await structuredVersion(app);
  // Each checkpoint of the run names its prompt, so that a retried attempt finds the run it cut off, and the
  // version its structured answer had before it.
  const saver = new SqlCheckpointSaver(ctx.db, { metadata: { [PROMPT]: promptId, [STRUCTURED_BEFORE]: before } });
  const run = compiled(graph, saver);
  const options = {
    ...THREAD,
    context,
    durability: 'sync',
    streamMode: 'values',
    signal: stopSignalOf(ctx),
  };
  if (asked && snapshot.next.length === 0) {
    // The run had finished, but its answer was not stored: that is the answer, rather than run again.
    await copied(ctx, turn, known, messages, promptId);
    await saver.prune([THREAD_ID]);
    return answerOf(run, turn, values, before);
  }
  // A run cut off by a crash is resumed: first by the signals its pending interrupts wait for, if any. A new
  // message (or one after a stopped run) starts a run, after what closed the previous run.
  let start: unknown;
  if (asked) {
    const resumes = await resumed(ctx, saver, await storedState(run));
    start = resumes === undefined ? null : new Command({ resume: resumes });
  } else {
    const prompt = new HumanMessage({ content: step.item.text, id: promptId });
    const closed = step === turn.prompt ? closing(conversation, turn, messages) : [];
    start = { messages: [...closed, prompt] };
  }
  for (;;) {
    try {
      for await (const state of await run.stream(start, options)) {
        values = state;
        await copied(ctx, turn, known, (state.messages ?? []) as BaseMessage[], promptId);
      }
    } catch (error) {
      // LangGraph's own error, which a retry would meet again: a run past its recursion limit, say.
      const terminal = terminalOf(error);
      if (terminal) throw terminal;
      // No refusal, whatever its name: a graph's models, tools and nodes are all its own.
      fromTool(ctx, error);
      throw error;
    }
    // The run stops at its interrupts: it goes on with the signals that answer them.
    const paused = await storedState(run);
    const resumes = await resumed(ctx, saver, paused);
    if (resumes === undefined) {
      // At a subgraph's static breakpoint, which check() does not look for: fail, rather than answer half done.
      if (atBreakpoint(paused)) throw new restate.TerminalError(BREAKPOINTS);
      // Only the latest checkpoint of each namespace is read again; a paused or cut-off run keeps it too.
      await saver.prune([THREAD_ID]);
      return answerOf(run, turn, values, before);
    }
    start = new Command({ resume: resumes });
  }
}
