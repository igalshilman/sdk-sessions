// DeepSeek Harness agents in Restate virtual objects: the session (the
// harness's event log) is in the object's database (persistence.ts), and
// each of its flushes copies the turn's new messages into the conversation of
// turns (../conversation.ts) in the same transaction: the harness keeps its
// own history, and the conversation is what clients read, and how turns end.
//
//   const assistant = deepseek.agent({ name: 'assistant', tools: [weather] });
//
// or a handler of an object of your own: `handlers: { chat: deepseek.chat() }`,
// with options for each invocation: `deepseek.chat(async (ctx) => ({ system }))`,
// or a prompt of your own handler: `deepseek.prompt(ctx, text, options)`
//
// The model is `model`, or else MODEL, or else deepseek/deepseek-flash:
// DeepSeek's (@deepseek-ai/dsh-llm-deepseek-api-key), with DEEPSEEK_API_KEY,
// or any model pi-ai knows (@deepseek-ai/dsh-llm-pi-ai), with its provider's
// key: `openai/gpt-6-sol` with OPENAI_API_KEY, say.
//
// The handler is not replayed: a retried attempt (a crash, a lost connection)
// boots the harness again and resumes the session from the stored log.
// - The harness's session checkpoint policy stores the log before each model
//   request and before each tool body: a tool runs only once its call is
//   stored.
// - A crash leaves the turn open. Resuming closes it, and gives each tool
//   call that was stored without a result an error result saying its outcome
//   is unknown; the handler then asks the agent to continue. The model sees
//   the unknown outcome: a tool that must not run twice needs a way for the
//   model to name the call it retries (such as a `retryOf` argument).
// - A tool's error fails the attempt, which Restate retries (the harness
//   would hand it to the model as the tool's result).
// - A message is answered once per invocation: its message carries the
//   invocation id, and a retried attempt returns the answer of the turn that
//   finished it.
import * as restate from '@restatedev/sessions';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import * as deepseek from '@deepseek-ai/dsh-llm-deepseek-api-key';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import { LlmRuntime, MessageId, ToolCallId, freezeMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session';
import * as checkpoints from '@deepseek-ai/dsh-session-checkpoint-policy';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  defineTool,
  type InferArgs,
  type ParameterSchemaSpec,
  type ValueSchemaSpec,
  type ToolDefinition,
  type ToolRunContext,
  ToolRuntime,
} from '@deepseek-ai/dsh-tools';
import {
  aborted,
  chatHandler,
  checkModelName,
  type Configure,
  configured,
  fromTool,
  ModelError,
  modelOf,
  providerOf,
  RETURNED_UNRECORDED,
  stopSignalOf,
  toolCallEnded,
  toolCallStarted,
} from '../common.ts';
import { answerOnce, type Items, type Parsed, type Run, type Turn } from '../conversation.ts';
import { conversationView } from '../messages.ts';
import { type Answer, withChecked } from '../output.ts';
import { type Definition, sessionObject } from '../object.ts';
import { isTool, jsonSchemaOf, type Tool as AnyTool } from '../tools.ts';
import type { z } from 'zod';
import { SqlSessionPersistence } from './persistence.ts';

export { SqlSessionPersistence };

/**
 * A tool whose result is text: `defineTool` of @deepseek-ai/dsh-tools, with
 * the output that takes.
 */
const textTool = <const S extends ParameterSchemaSpec>(options: {
  name: string;
  description: string;
  parameters: S;
  execute: (args: InferArgs<S>, exec: ToolRunContext) => Promise<string>;
}): ToolDefinition =>
  defineTool<S, { type: 'string' }>({
    ...options,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  });

/** The default model. */
const DEEPSEEK_MODEL = 'deepseek/deepseek-flash';

/** A model as the harness names it: its provider route, and its id there. */
interface Route {
  provider: string;
  model: string;
}

/**
 * `model` (`provider/model-id`) as the harness's route: DeepSeek's own
 * provider, or else pi-ai's provider of that name, if it has the model.
 */
function routeOf(model: string): Route {
  const [provider, id] = providerOf(model);
  if (provider === 'deepseek') return { provider: 'deepseek-official', model: id };
  const from = process.env.MODEL === model ? ' (from MODEL)' : '';
  const known = builtinProviders().find((p) => p.id === provider);
  if (!known) {
    throw new ModelError(`deepseek: the model "${model}"${from} is not provider/model-id of a provider pi-ai knows`);
  }
  if (!known.getModels().some((m) => m.id === id)) {
    throw new ModelError(`deepseek: pi-ai knows no model "${id}" of ${provider} (the model "${model}"${from})`);
  }
  return { provider, model: id };
}

/**
 * The harness, its session in `db`: the services
 * an agent loop needs, the persistence and its checkpoints, and the provider
 * of `route`.
 */
async function boot(db: restate.Database, route: Route, system?: string): Promise<Context> {
  const harness = new Context();
  await harness.plugin(LlmRuntime);
  await harness.plugin(SessionStore);
  await harness.plugin(SystemPrompt, system ? { personaPrefix: system } : {});
  await harness.plugin(ToolRuntime, {});
  await harness.plugin(AgentRegistry);
  await harness.plugin(SessionProjectionRegistry);
  await harness.plugin(SqlSessionPersistence, { db });
  await harness.plugin(checkpoints);
  // DeepSeek's with DEEPSEEK_API_KEY; another's with the key pi-ai finds for it (OPENAI_API_KEY...).
  if (route.provider === 'deepseek-official') await harness.plugin(deepseek, {});
  else await harness.plugin(piAi, { providers: { [route.provider]: {} } });
  await harness.plugin(AgentLoop, { agents: [] });
  return harness;
}

/** The text that asks the agent to finish an interrupted prompt. */
const CONTINUE = 'Continue: your last turn was interrupted. Finish the request.';

const promptId = (id: string) => MessageId(`prompt:${id}`);
const textOf = (message: Message) => message.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');

/**
 * How the harness's turn of prompt `id` ended in the session log: the last
 * reply of its first harness turn that completed (`answer`), or a failure
 * (`error`); none while it is absent (`asked: false`) or was interrupted (a
 * crash), when it is continued.
 */
function endOf(events: readonly SessionEvent[], id: MessageId) {
  const at = events.findIndex((e) => e.type === 'user/message' && e.data.id === id);
  if (at < 0) return { asked: false as const };
  let answer: string | undefined;
  let error: unknown;
  for (const e of events.slice(at)) {
    if (e.type === 'assistant/message') answer = textOf(e.data.message);
    if (e.type !== 'turn/end') continue;
    const { reason } = e.data;
    if (reason.kind === 'completed') return { asked: true as const, answer: answer ?? '' };
    // A failed harness turn, continued after (by a retry), or the last.
    error = reason.kind === 'error' ? reason.error : undefined;
  }
  return { asked: true as const, error };
}

/** The error a harness turn failed with: terminal for an overflow of the model's context, which a retry meets again. */
const turnError = (error: unknown) => {
  const message = `the agent's turn failed: ${JSON.stringify(error)}`;
  return /context.?length|context_length_exceeded|context window|maximum context/i.test(message)
    ? new restate.TerminalError(message)
    : new Error(message);
};

const message = (id: string, text: string): UserMessage =>
  freezeMessage({ id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

/** A JSON schema node as the harness's value schema: what it cannot say, it takes as any JSON. */
function valueSpec(node: Record<string, unknown>): ValueSchemaSpec {
  const annotations = typeof node.description === 'string' ? { description: node.description } : {};
  const variants = (node.anyOf ?? node.oneOf) as Record<string, unknown>[] | undefined;
  if (variants && variants.length >= 2) {
    const [first, second, ...rest] = variants.map(valueSpec) as [
      ValueSchemaSpec,
      ValueSchemaSpec,
      ...ValueSchemaSpec[],
    ];
    return { ...annotations, oneOf: [first, second, ...rest] };
  }
  switch (node.type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return {
        ...annotations,
        type: node.type,
        ...(Array.isArray(node.enum) ? { enum: node.enum } : {}),
      };
    case 'array':
      return {
        ...annotations,
        type: 'array',
        ...(node.items ? { items: valueSpec(node.items as Record<string, unknown>) } : {}),
      };
    case 'object':
      return {
        ...annotations,
        type: 'object',
        properties: parameterSpec(node),
        additionalProperties: node.additionalProperties !== false,
      };
    default:
      return { ...annotations, type: 'json' };
  }
}

/** The properties of a JSON schema object as the harness's parameters. */
function parameterSpec(node: Record<string, unknown>): ParameterSchemaSpec {
  const required = new Set((node.required as string[] | undefined) ?? []);
  const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      { ...valueSpec(property), ...(required.has(name) ? { required: true as const } : {}) },
    ]),
  );
}

/** `t` as a harness tool. */
const native = (t: AnyTool, ctx: restate.SessionContext): ToolDefinition =>
  textTool({
    name: t.name,
    description: t.description,
    parameters: parameterSpec(jsonSchemaOf(t)),
    // Aborted (the agent's turn, on a cancellation), it waits no more.
    execute: (args, exec) => {
      const run = t.run(args, { ctx, callId: exec.callId });
      if (!exec.signal) return run;
      const stopped = aborted(exec.signal).catch(() => {
        throw new restate.CancelledError();
      });
      return Promise.race([run, stopped]);
    },
  });

/** An agent's options: `chat` and `prompt` take them. */
export interface Options<O extends z.ZodObject | undefined = z.ZodObject | undefined> {
  /**
   * The model, as `provider/model-id`: MODEL, or else deepseek/deepseek-flash.
   * DeepSeek's, or any pi-ai knows, such as `openai/gpt-6-sol`.
   */
  model?: string;
  /** The system prompt: who the agent is, and how it answers. */
  system?: string;
  /** The agent's tools: `tool()`s, Restate's (`call`, `signal`...), or the harness's (`defineTool`). */
  tools?: (AnyTool | ToolDefinition)[];
  /**
   * The answer as data: a zod object, whose JSON the agent replies with
   * (checked), and `chat` and `prompt` answer with (see output.ts).
   */
  output?: O;
}

/**
 * DeepSeek's items, as the conversation of turns keeps them: the harness's
 * messages. A user's text is said by the user; an assistant's by the
 * assistant, with its tool calls; a tool message is a result.
 */
export const items: Items<Message> = {
  dump: (m) => JSON.stringify(m),
  load: (stored) => freezeMessage(JSON.parse(stored) as Message),
  prompt: (text) => message('prompt', text),
  reply: (text) =>
    freezeMessage({
      id: MessageId('reply'),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'restate', model: 'note' },
    }),
  results: (results) =>
    results.map(([call, output]) =>
      freezeMessage({
        id: MessageId(`result:${call.id}`),
        role: 'tool',
        toolCallId: ToolCallId(call.id),
        content: [{ type: 'text', text: output }],
        source: { kind: 'tool', callId: ToolCallId(call.id) },
        isError: output !== RETURNED_UNRECORDED,
      }),
    ),
  read: (m): Parsed => {
    if (m.role === 'user') return { said: ['user', textOf(m)] };
    if (m.role === 'assistant') {
      const calls = m.content.flatMap((c) =>
        c.type === 'tool-call' ? [{ id: c.id, name: c.name, input: parsedJson(c.arguments) }] : [],
      );
      // Each reply is a message of its own, its tool calls' too.
      return { said: ['assistant', textOf(m)], calls };
    }
    if (m.role === 'tool') return { results: [{ id: m.toolCallId, output: textOf(m), error: m.isError === true }] };
    return {};
  },
};

/** An agent of the harness, on a session. */
type Agent = Awaited<ReturnType<Context['agents']['create']>>['agent'];

/**
 * The harness's message of `turn`'s prompt: its text, after how the turn
 * before it ended if its run did not answer it (stopped, refused, failed,
 * or ended once its invocation was gone), which the harness's log does not
 * say.
 */
function promptOf(turn: Turn<Message>, before: { status?: string; answer?: string } | undefined) {
  const text = textOf(turn.prompt.item);
  const note = before && before.status !== 'answered' && before.answer ? `(${before.answer})\n\n` : '';
  return message(promptId(turn.id), note + text);
}

/**
 * Copy the events of `batch` that are `turn`'s (after its latest ask, at seq
 * `from()` of the log) into it, in `tx`: the model's replies, and the
 * tools' results. Not the requests to continue (a step of the run's own),
 * nor anything once the run stopped or `failed()` (the harness's result of a
 * tool that failed the attempt, or was cancelled, is not the call's): the
 * turn's close, or the retry, says how it ended.
 */
const copying =
  (ctx: restate.SessionContext, turn: Turn<Message>, from: () => number | undefined, failed: () => boolean) =>
  async (tx: Parameters<NonNullable<SqlSessionPersistence['copy']>>[0], batch: readonly SessionEvent[]) => {
    const start = from();
    if (start === undefined || failed() || stopSignalOf(ctx)?.aborted || !turn.writable) return;
    const copied = batch.flatMap((e): { item: Message; reply?: boolean }[] => {
      if (e.seq <= start) return [];
      if (e.type === 'assistant/message') return [{ item: e.data.message, reply: true }];
      if (e.type === 'tool/result') return [{ item: e.data.message }];
      return [];
    });
    if (copied.length > 0) await turn.copyIn(tx, copied);
  };

/**
 * The run of the harness of `options`, on the conversation: its turn's
 * latest ask (its prompt, or the message that asked again) asked once, and
 * continued after a crash.
 */
const runOf =
  (ctx: restate.SessionContext, { model: named, system, tools = [] }: Options): Run<Message> =>
  async (conversation) => {
    const turn = conversation.turn;
    const route = routeOf(modelOf(named, DEEPSEEK_MODEL));
    const harness = await boot(ctx.db, route, system);
    const persistence = harness.sessionPersistence as SqlSessionPersistence;
    // A tool's error fails the attempt, which Restate retries: the harness
    // stores nothing more, so the retry finds the tool's call without a result.
    // The turn's stop fails it too: a cancellation, or an attempt that ended first.
    const { promise: failed, reject } = Promise.withResolvers<never>();
    failed.catch(() => {});
    let broken = false;
    const fail = (error: unknown) => {
      broken = true;
      reject(error);
    };
    const stop = stopSignalOf(ctx);
    const onStop = () => fail(stop!.reason);
    stop?.addEventListener('abort', onStop, { once: true });
    let agent: Agent | undefined;
    // The turn asked again (its output's check, say): the harness is asked that, and answers it.
    const asked = turn.latestAsk();
    const again = asked !== turn.prompt;
    const id = again ? MessageId(`prompt:${turn.id}:again`) : promptId(turn.id);
    // Where the turn's latest ask is in the log, once it is.
    let from: number | undefined;
    try {
      const sessionId = SessionId(ctx.key);
      const options = {
        agentOptions: route,
        setup: (agentCtx: Context) => {
          for (const t of tools) agentCtx.tools.register(tracked(isTool(t) ? native(t, ctx) : t, ctx, fail));
        },
      };
      // Resuming closes a harness turn a crash, or a killed invocation, left open.
      const started = (await persistence.stat(sessionId))
        ? await harness.agents.resume({ resumeSessionId: sessionId, ...options })
        : await harness.agents.create({ sessionId, ...options });
      agent = started.agent;
      const found = agent.session.snapshotEvents().length;
      from = agent.session.snapshotEvents().find((e) => e.type === 'user/message' && e.data.id === id)?.seq;
      persistence.copy = async (tx, batch) => {
        from ??= batch.find((e) => e.type === 'user/message' && e.data.id === id)?.seq;
        await copying(
          ctx,
          turn,
          () => from,
          () => broken,
        )(tx, batch);
      };
      // The turn before this one, as the conversation has it.
      const before = conversation.transcript.at(-2);
      for (;;) {
        const events = agent.session.snapshotEvents();
        const end = endOf(events, id);
        // A turn of this attempt's that failed fails it (a refusal ends the turn); the retry asks the model again.
        if ('error' in end && end.error !== undefined) {
          const failedHere = events.slice(found).some((e) => e.type === 'turn/end' && e.data.reason.kind === 'error');
          if (failedHere) throw turnError(end.error);
        }
        if ('answer' in end && end.answer !== undefined) return end.answer;
        const ask = again ? message(id, textOf(asked.item)) : promptOf(turn, before);
        agent.followup(end.asked ? message(`continue:${events.length}`, CONTINUE) : ask);
        await Promise.race([agent.whenIdle(), failed]);
        await harness.sessions.flush(agent.session);
      }
    } catch (e) {
      // A cancelled invocation cancels the agent's turn, which the log keeps.
      if (e instanceof restate.CancelledError && agent) await cancelTurn(harness, agent);
      else persistence.abandon();
      throw e;
    } finally {
      stop?.removeEventListener('abort', onStop);
      await harness.fiber.dispose();
    }
  };

/** Cancel `agent`'s turn, and store it cancelled. */
async function cancelTurn(harness: Context, agent: Agent) {
  agent.cancel({ kind: 'user' });
  await agent.whenIdle();
  await harness.sessions.flush(agent.session);
}

/**
 * `definition`, its calls published as they start and end (for the clients
 * that follow the conversation), and its error failing the attempt.
 */
const tracked = (
  definition: ToolDefinition,
  ctx: restate.SessionContext,
  fail: (error: unknown) => void,
): ToolDefinition => ({
  ...definition,
  execute: async (args, exec) => {
    try {
      await toolCallStarted(ctx);
      const result = await definition.execute(args, exec);
      await toolCallEnded(ctx);
      return result;
    } catch (error) {
      fromTool(ctx, error);
      fail(error);
      throw error;
    }
  },
});

/**
 * Answer `text`, once: a retried attempt resumes the same prompt. Each prompt
 * of an invocation is a prompt of its own. The session is the object's key.
 * With `output`, it answers with the value the agent replies with (see
 * output.ts), not its text.
 */
export const prompt = <O extends z.ZodObject | undefined = undefined>(
  ctx: restate.SessionContext,
  text: string,
  options: Options<O> = {},
): Promise<Answer<O>> =>
  withChecked(text, options, (t, o, check) => answerOnce(ctx, t, items, runOf(ctx, o), { check })) as Promise<
    Answer<O>
  >;

/**
 * A chat handler: each message an invocation, the session in the object's
 * database, with `options`, or the options a function of the invocation's
 * context gives. It takes the message as plain text (`curl -d 'Hi'`) or as
 * a JSON string (`curl --json '"Hi"'`).
 */
export const chat = <O extends z.ZodObject | undefined = undefined>(options: Configure<Options<O>> = {}) => {
  if (typeof options === 'object') {
    checkModelName('deepseek', options.model);
    routeOf(modelOf(options.model, DEEPSEEK_MODEL));
  }
  return chatHandler(async (ctx, text) => prompt(ctx, text, await configured(options, ctx)));
};

/** `json` parsed, or as it is if it is not JSON. */
const parsedJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
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
