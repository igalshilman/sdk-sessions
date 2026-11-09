// pi agents in Restate virtual objects: a pi-durable Harness for each
// invocation, with its storage in the object's database.
//
//   const assistant = pi.agent({ name: 'assistant', tools: [weather] });
//   const lead = pi.agent({ name: 'lead', tools: [subagent(coder)] });
//
// or a handler of an object of your own: `handlers: { chat: pi.chat() }`,
// with options for each invocation: `pi.chat(async (ctx) => ({ model }))`
//
// or, for more than a prompt:
//
//   compact: (ctx) => withPi(ctx, { tools }, async ({ conversation, context }) => ...),
//
// The model is `model`, MODEL, or else openai/gpt-6-sol, with the
// provider's API key (such as OPENAI_API_KEY).
//
// It runs `work` over `ctx.db`: pi-durable's storage is the object's
// database (storage.ts), and each pi-durable commit is an SQL transaction
// in it, stored in order with everything else the handler does. pi keeps its
// own history (and compacts it); each commit of a prompt's run copies its
// new entries (the model's replies, the tools' results) into the
// conversation of turns (../conversation.ts) in the same transaction: what
// clients read, and how turns end. A run another invocation left (killed)
// is aborted, never finished, and the next prompt tells the model how the
// turn before it ended. The Harness
// is opened with `tools` (made with pi-durable's `defineTool`) and closed at
// the end. A retried attempt (a crash, a lost connection) opens it again and
// carries on: a prompt is submitted once, by its id (pi-durable's requestId),
// an answered prompt returns its answer, and unfinished work resumes: a model
// call is made again, and a tool call declared `replay: 'safe'` runs again
// with the same call id, which a tool passes on to stay idempotent. A tool's
// error fails the attempt, which Restate retries (pi-durable would hand it to
// the model as the tool's result).
//
// With a `workspace` directory, the agent also gets pi-durable's coding
// tools (`read`, `write`, `edit`, `bash`) over it, on the local file system.
// The files are not in the database: they last as long as the disk does,
// and a coding tool cut off by a crash is not run again (the model is told
// it was interrupted).
import * as restate from '@restatedev/sessions';
import type { Context } from '@earendil-works/chord';
import { awaitWithContext, BACKGROUND_CONTEXT, withCancel, withoutAbortSignal } from '@earendil-works/chord/context';
import { mkdir } from 'node:fs/promises';
import { type Message, type MutableModels, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  section,
  type Conversation,
  type ConversationRetryPolicy,
  type ConversationStreamOptions,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { DatabaseWriter } from '@restatedev/sessions';
import {
  AttemptEnded,
  chatHandler,
  CHECK_MODEL,
  type Check,
  checkModelName,
  type Configure,
  configured,
  fromTool,
  ModelError,
  modelOf,
  providerOf,
  refusal,
  REFUSED,
  RETURNED_UNRECORDED,
  stopSignalOf,
  toolCallEnded,
  toolCallStarted,
} from '../common.ts';
import { answerOnce, invocationOf, type Items, type Parsed, type Turn } from '../conversation.ts';
import { conversationView } from '../messages.ts';
import { type Answer, withChecked } from '../output.ts';
import { type Definition, sessionObject } from '../object.ts';
import { isTool, jsonSchemaOf, type Tool as AnyTool } from '../tools.ts';
import type { z } from 'zod';
import { openSqlKvStorage, SqlKvDatabase } from './storage.ts';

/** What `work` gets: `prompt(text)`, the `conversation()`, and the `harness` and chord `context` for anything else. */
export interface Pi {
  harness: Harness;
  context: Context;
  /**
   * Answer `text`, once, with the answer's text: a turn of the object's
   * conversation (each prompt of an invocation has an id of its own, the
   * same on every attempt). With `check`, a reply it returns a message for
   * is asked again within the turn, once. With `reminder`, the model is told
   * it after the prompt, which the conversation keeps as it was asked.
   */
  prompt: (text: string, check?: Check, reminder?: string) => Promise<string>;
  /** The object's conversation, on the model: for `reset`, `compact`, `entries` and the like. */
  conversation: () => Promise<Conversation>;
}

/** The text of a message's content. */
const textOf = (content: Message['content']): string =>
  typeof content === 'string' ? content : content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');

/** A pi message as the conversation of turns keeps it: with the id of the pi entry it was copied from. */
export interface Item {
  entry?: number;
  message: Message;
}

/** No usage: a message the conversation makes, which no model gave. */
const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * pi's items: pi-ai's messages. A user's message is said by the user; an
 * assistant's (but one aborted, failed or deferred) says its text, with its
 * tool calls; a tool's result is a result; a system message says nothing.
 */
export const items: Items<Item> = {
  dump: (item) => JSON.stringify(item),
  load: (stored) => {
    // Only a pi message, with the entry it was copied from: another framework's row is not one.
    const item = JSON.parse(stored) as Item;
    const { message, entry, ...rest } = item;
    if (typeof message !== 'object' || message === null || typeof message.role !== 'string')
      throw new Error("not a pi item (a pi-ai message, with its entry's id)");
    if (Object.keys(rest).length > 0 || (entry !== undefined && typeof entry !== 'number'))
      throw new Error(`not a pi item: ${Object.keys(item).join(', ')}`);
    return item;
  },
  prompt: (text) => ({ message: { role: 'user', content: text, timestamp: 0 } }),
  reply: (text) => ({
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'restate',
      provider: 'restate',
      model: 'note',
      usage: NO_USAGE,
      stopReason: 'stop',
      timestamp: 0,
    },
  }),
  results: (results) =>
    results.map(([call, output]) => ({
      message: {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: output }],
        isError: output !== RETURNED_UNRECORDED,
        timestamp: 0,
      },
    })),
  read: ({ message: m }): Parsed => {
    if (m.role === 'user') return { said: ['user', textOf(m.content)] };
    if (m.role === 'assistant') {
      if (m.stopReason === 'aborted' || m.stopReason === 'error' || m.stopReason === 'deferred') return {};
      const calls = m.content.flatMap((c) =>
        c.type === 'toolCall' ? [{ id: c.id, name: c.name, input: c.arguments }] : [],
      );
      // Each reply is a message of its own, its tool calls' too.
      return { said: ['assistant', textOf(m.content)], calls };
    }
    if (m.role === 'toolResult')
      return { results: [{ id: m.toolCallId, output: textOf(m.content), error: m.isError }] };
    return {};
  },
};

/**
 * What each pi commit copies into `turn`, in its transaction: the entries of
 * the run of the turn's request `requestId` after its user entry (pi's
 * submission names it),
 * its replies and its tools' results; nothing once `stopped()`, or once the
 * turn is closed. Each entry once: after the last one copied. `resulted`
 * gets the calls whose results it copied.
 */
function copying(turn: Turn<Item>, requestId: string, stopped: () => boolean, resulted: (calls: string[]) => void) {
  let from: { conversation: number; last: number } | undefined;
  return async (tx: DatabaseWriter) => {
    if (stopped() || !turn.writable) return;
    if (!from) {
      const submitted = await tx.get<{ entry: number | null; conversation: number }>(
        "SELECT json_extract(record, '$.entry') AS entry, conversation_id AS conversation FROM restate_pi_submissions WHERE request_id = ?",
        [JSON.stringify(requestId)],
      );
      if (submitted?.entry === null || submitted?.entry === undefined) return;
      const copied = turn.items.flatMap((e) => (e.item.entry === undefined ? [] : [e.item.entry]));
      from = { conversation: submitted.conversation, last: Math.max(submitted.entry, ...copied) };
    }
    const rows = await tx.values(
      'SELECT id, record FROM restate_pi_entries WHERE conversation_id = ? AND id > ? ORDER BY id',
      [from.conversation, from.last],
    );
    const copied: { item: Item; reply?: boolean }[] = [];
    for (const [id, record] of rows) {
      const entry = JSON.parse(String(record)) as { kind: string; model?: Message[] };
      from.last = Number(id);
      if (entry.kind !== 'pi.assistant' && entry.kind !== 'pi.tool-result') continue;
      for (const message of entry.model ?? []) {
        copied.push({ item: { entry: Number(id), message }, reply: message.role === 'assistant' });
      }
    }
    if (copied.length === 0) return;
    await turn.copyIn(tx, copied);
    resulted(copied.flatMap(({ item: { message } }) => (message.role === 'toolResult' ? [message.toolCallId] : [])));
  };
}

/** An agent's options: `chat`, `prompt` and `withPi` take them. */
export interface Options<O extends z.ZodObject | undefined = z.ZodObject | undefined> {
  /** The model, as `provider/model-id`: MODEL, or else openai/gpt-6-sol. */
  model?: string;
  /** A pi-ai model registry; by default, one of the model's provider. */
  models?: MutableModels;
  /** The system prompt: who the agent is, and how it answers. */
  system?: string;
  /** The agent's tools: `tool()`s, Restate's (`call`, `signal`...), or pi-durable's `defineTool`s. */
  tools?: (ToolRegistration | AnyTool)[];
  /** A directory for the coding tools, made if missing; without one, the agent has no file system. */
  workspace?: string;
  /** OpenAI's service tier for each request: `fast` for its fast mode (priced higher), `flex`, and so on. */
  serviceTier?: ServiceTier;
  /**
   * How pi asks the model again after a request failed for a reason that
   * passes (an overloaded or unreachable provider, a rate limit): by
   * default without limit, 2 s after the first failure, then twice as long
   * each time, a minute apart at most. With `maxRetries`, a failure after
   * that many retries ends the turn. A request refused for good (a wrong API
   * key, an unknown model) is never asked again.
   */
  retry?: Partial<ConversationRetryPolicy>;
  /**
   * The answer as data: a zod object, whose JSON the agent replies with
   * (checked), and `chat` and `prompt` answer with (see output.ts).
   */
  output?: O;
}

/** OpenAI's service tiers (its Responses API's `service_tier`). */
export type ServiceTier = 'auto' | 'default' | 'fast' | 'flex' | 'priority';

/** A registry of `provider`'s models, such as anthropicProvider() of @earendil-works/pi-ai/providers/anthropic. */
function modelsOf(provider: string): MutableModels {
  // All of pi-ai's providers, imported as they are named: one a bundler sees.
  const known = builtinProviders().find((p) => p.id === provider);
  if (!known) throw new ModelError(`pi knows no model provider "${provider}": ${CHECK_MODEL}`);
  const models = createModels();
  models.setProvider(known);
  return models;
}

/** `t` as a pi-durable tool. */
const native = (t: AnyTool, ctx: restate.SessionContext): ToolRegistration =>
  defineTool({
    name: t.name,
    description: t.description,
    parameters: Type.Unsafe<Record<string, unknown>>(jsonSchemaOf(t)),
    replay: 'safe', // a crash runs it again, with the same call id
    // Aborted (the conversation's work, on a cancellation), it waits no more.
    execute: async (args, { callId }, task) => ({
      output: [{ type: 'text', text: await awaitWithContext(t.run(args, { ctx, callId }), task) }],
    }),
  });

/**
 * The tools of an agent, `system` added to its system prompt, and, with a
 * `workspace`, pi's coding tools working there, with the environment they
 * run in.
 */
async function extensions(tools: ToolRegistration[], system: string | undefined, workspace: string | undefined) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'tools', tools }));
  if (system) registry.install(defineExtension({ name: 'system', sections: [section('system', () => system)] }));
  if (!workspace) return { registry, env: undefined };
  await mkdir(workspace, { recursive: true });
  registry.install(CodingTools);
  // Tell the model where the coding tools work.
  registry.install(defineExtension({ name: 'workspace', sections: [section('cwd', () => workspace)] }));
  return { registry, env: () => new NodeExecutionEnv({ cwd: workspace }) };
}

/**
 * The root conversation of `harness`, on `model`. It keeps the model it was
 * created with: on another one now (`model` or MODEL changed), it moves to
 * this one.
 */
async function rootOn(harness: Harness, context: Context, model: string): Promise<Conversation> {
  const [provider, modelId] = providerOf(model);
  const root = await harness.root(context, { agent: { model: { provider, modelId } } });
  const { model: current } = await root.agent(context);
  if (current?.provider !== provider || current.modelId !== modelId) {
    await root.configure({ model: { provider, modelId } }, context);
  }
  return root;
}

/**
 * The error of prompt `id`, which ended unanswered for `reason` (and
 * `detail`, pi-durable's): {@link REFUSED} if there is no model, or its
 * provider refused it, as for the other frameworks.
 */
function unanswered(id: string, why: string | null | undefined, detail: unknown, model: string) {
  const reason = why ?? 'unknown';
  const text =
    detail === undefined || detail === null ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  const message = `prompt ${id} unanswered: ${reason}${text ? `: ${text}` : ''}`;
  if (reason === 'no_model' || (reason === 'model_error' && refusal(new Error(text)))) {
    return new restate.TerminalError(`${message} (the model ${model}: ${CHECK_MODEL})`, { errorCode: REFUSED });
  }
  return new restate.TerminalError(message);
}

/**
 * Run `work(pi)` with a Harness over the object's database: `model` is the
 * model to use as `provider/model-id`, and `tools` the agent's tools. `pi`
 * has `prompt(text)`, and the `harness` and chord `context` for anything
 * else.
 */
export const withPi = async <T>(
  ctx: restate.SessionContext,
  { model: named, models, system, tools = [], workspace, serviceTier, retry }: Options,
  work: (pi: Pi) => Promise<T>,
): Promise<T> => {
  const model = modelOf(named);
  models ??= modelsOf(providerOf(model)[0]);
  // A tool's error fails the attempt, which Restate retries (pi-durable would
  // hand it to the model): the work is cancelled, so the tool call stores no
  // result, and the retry runs it again with the same call id.
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  const { promise: failure, reject: failed } = Promise.withResolvers<never>();
  failure.catch(() => {});
  // A cancelled invocation, whenever it comes, aborts the conversation's
  // work instead (abortOn): pi-durable ends the turn, and the tool call with
  // it. An attempt that ends first cancels the work, as a tool's error does:
  // the next attempt goes on with it.
  let cancelled: restate.CancelledError | undefined;
  const turn = stopSignalOf(ctx);
  const onStop = () => {
    const reason: unknown = turn!.reason;
    failed(reason);
    if (reason instanceof AttemptEnded) cancel(reason);
    else cancelled = reason as restate.CancelledError;
  };
  turn?.addEventListener('abort', onStop, { once: true });
  // The root conversation, once the Harness is open (below).
  const conversation = () => rootOn(harness, context, model);
  /**
   * Abort the run of a live input of the root conversation that `kept` does
   * not keep: a run a prompt left, whose turn is closed (or the next prompt
   * closes it), is aborted, never finished. pi's own writes (a compaction's)
   * are not runs, and an input without a request id is not a prompt's.
   */
  const abortLeft = async (kept: (requestId: string) => boolean) => {
    const { submissions } = await harness.inspect(context);
    const left = submissions.filter((s) => s.type === 'input' && s.requestId !== undefined && !kept(s.requestId));
    if (left.length === 0) return;
    const root = await conversation();
    if (left.some((s) => s.conversationId === root.id)) await root.abort(context);
  };
  // A tool call's error: the attempt fails, and the call never returns.
  const stopped = (error: unknown, task: Context): Promise<never> => {
    // The turn was cancelled, and the abort ended the call: pi-durable records it.
    if (cancelled) throw error;
    failed(error);
    if (error instanceof restate.CancelledError) {
      cancelled = error;
      return awaitWithContext(new Promise<never>(() => {}), task);
    }
    cancel(error);
    return awaitWithContext(new Promise<never>(() => {}), context);
  };
  // The tool calls that returned, whose ends are published once pi stored their results (`prompt`).
  const returned = new Set<string>();
  const tracked = (t: ToolRegistration): ToolRegistration => ({
    ...t,
    execute: async (args, api, task) => {
      try {
        await toolCallStarted(ctx);
        const result = await t.execute(args, api, task);
        returned.add(api.callId);
        return result;
      } catch (error) {
        // The tool's error: never taken for the model's provider refusing (a tool may call a model API).
        fromTool(ctx, error);
        return stopped(error, task);
      }
    },
  });
  const { registry, env } = await extensions(
    tools.map((t) => tracked(isTool(t) ? native(t, ctx) : t)),
    system,
    workspace,
  );
  const settings = {
    // A task that crashes is run again however often Restate retries the attempt (its retry policy decides):
    // pi-durable would park it after 5 crashes in a row, and the prompt would never be answered.
    restartLimit: Infinity,
    // A provider's outage never ends the turn: pi asks again until it answers (pi-durable would give up after 3
    // retries, ending the turn unanswered for good). Each retry is committed: a retried attempt waits as it would.
    retry: { maxRetries: Infinity, ...retry },
    // pi-durable hands its stream settings to pi-ai's requests as they are: serviceTier is pi-ai's.
    ...(serviceTier ? { stream: { serviceTier } as ConversationStreamOptions } : {}),
  };
  const database = new SqlKvDatabase(ctx.db);
  const harness = await Harness.open(
    await openSqlKvStorage(ctx.db, database),
    { models, registry, env, settings },
    context,
  );

  const prompt = (text: string, check?: Check, reminder?: string) => {
    // 0.3.0's `prompt(text, id)` took a prompt's id: from JavaScript, it would
    // fail as the check is called, again at every retry.
    if (check !== undefined && typeof check !== 'function') {
      throw new restate.TerminalError(
        `pi's prompt(text, check) takes a check of the answer, not ${JSON.stringify(check)}: a prompt has an id of its own`,
      );
    }
    return answerOnce(
      ctx,
      text,
      items,
      async (store) => {
        const current = store.turn;
        const id = current.id;
        const root = await conversation();
        // The turn's own request: its prompt, or the message that asked again within it.
        const again = current.latestAsk() !== current.prompt;
        const requestId = again ? `${id}:again` : id;
        // A run an earlier prompt of this invocation left (its turn failed, say).
        await abortLeft((r) => r === id || r === `${id}:again`);
        // Once stopped, the turn's close says how it ended: not pi's abort of its tools.
        // A tool call's end is published once its result is stored, for followers to read it there.
        let ended = false;
        database.onCommit = copying(
          current,
          requestId,
          () => cancelled !== undefined || stopSignalOf(ctx)?.aborted === true,
          (calls) => {
            for (const call of calls) if (returned.delete(call)) ended = true;
          },
        );
        database.afterCommit = async () => {
          if (!ended) return;
          ended = false;
          // Failing, it fails the attempt, as a tool's error does: never pi's commit, which is done.
          await toolCallEnded(ctx).catch((error: unknown) => {
            failed(error);
            cancel(error);
          });
        };
        // The model is told how the turn before this one ended, if its run did not answer it.
        const before = store.transcript.at(-2);
        const note = !again && before && before.status !== 'answered' && before.answer ? `(${before.answer})\n\n` : '';
        // pi keeps the prompt as it is given, the turn's reminder too; the conversation as it was asked.
        const asked = textOf(current.latestAsk().item.message.content) + (again ? '' : (current.reminder ?? ''));
        const submission = await root.submit({ type: 'input', content: note + asked, requestId }, context);
        const settled = await submission.wait(context);
        // A prompt the cancellation's abort ended fails with the cancellation.
        if (settled.status !== 'done' || settled.answer === undefined)
          throw cancelled ?? unanswered(id, settled.reason, settled.detail, model);
        const { answer } = settled;
        const entry = await root.commit((tx) => tx.entry(AssistantEntry, answer), context);
        const reply = entry?.model?.at(-1);
        if (!reply) throw new restate.TerminalError(`prompt ${id}: no answer entry`);
        return textOf(reply.content);
      },
      // pi keeps the model's history: the conversation reads only its latest turns.
      { check, reminder, ownHistory: true },
    );
  };
  // `failure`, once it comes. A cancellation aborts the conversation's work
  // instead: the work ends with it (a prompt closes its turn, cancelled).
  const abortOn = async (): Promise<never> => {
    try {
      return await failure;
    } catch (error) {
      if (!(error instanceof restate.CancelledError)) throw error;
      await (await conversation()).abort(context);
      return new Promise<never>(() => {});
    }
  };

  // Whatever `work` does (a prompt, a compaction, a wait) has pi schedule
  // what it has: a run another invocation left is aborted first. This
  // invocation's own (a retried attempt's) goes on.
  const working = async () => {
    await abortLeft((r) => invocationOf(r) === ctx.request.id);
    return work({ harness, context, conversation, prompt });
  };
  try {
    const done = await Promise.race([abortOn(), working()]);
    // Work the cancellation's abort ended (a wait for pi, say) fails with it, as a prompt does.
    if (cancelled) throw cancelled;
    return done;
  } finally {
    turn?.removeEventListener('abort', onStop);
    await harness.close(withoutAbortSignal(context));
  }
};

/**
 * Answer `text`, once: a retried attempt resumes the same prompt. Each prompt
 * of an invocation is a prompt of its own.
 * With `output`, it answers with the value the agent replies with (see
 * output.ts), not its text.
 */
export const prompt = <O extends z.ZodObject | undefined = undefined>(
  ctx: restate.SessionContext,
  text: string,
  options: Options<O> = {},
): Promise<Answer<O>> =>
  withChecked(text, options, (t, o, check, reminder) =>
    withPi(ctx, o, (session) => session.prompt(t, check, reminder)),
  ) as Promise<Answer<O>>;

/**
 * A chat handler: each message an invocation, the conversation in the
 * object's database, with `options`, or the options a function of the
 * invocation's context gives (each user's model, say). It takes the message
 * as plain text (`curl -d 'Hi'`) or as a JSON string (`curl --json '"Hi"'`).
 */
export const chat = <O extends z.ZodObject | undefined = undefined>(options: Configure<Options<O>> = {}) => {
  if (typeof options === 'object') checkModelName('pi', options.model);
  return chatHandler(async (ctx, message) => prompt(ctx, message, await configured(options, ctx)));
};

/**
 * A view of the conversation as clients read it: a page at a time, or what
 * is new or changed since a cursor; `view: 'summary'` for each turn's
 * message and answer. It answers while a message is answered.
 */
export const messages = () => conversationView(items);

/** An agent: a virtual object `name`, one per key, whose `chat` handler is {@link chat}, and `messages` {@link messages}. */
export const agent = <P extends string, O extends z.ZodObject | undefined = undefined>({
  name,
  description,
  schema,
  background,
  window,
  budget,
  ...options
}: Options<O> & Definition<P>) =>
  sessionObject({
    name,
    description,
    schema,
    background,
    window,
    budget,
    handlers: { chat: chat(options) },
    views: { messages: messages() },
  });
