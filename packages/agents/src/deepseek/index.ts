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
// - A tool call that needs a person's approval (`approval`) waits for the
//   signal `approval` before it runs: the harness asks its approval service
//   (@deepseek-ai/dsh-user-approval), which this answers with a wait
//   (`waitFor` of ../tools.ts). The wait is opened once: a crash, or a
//   suspension, has the model make the call again, which joins it.
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
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { BasicCompactionEngine, type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import { ApprovalService, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
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
  inboxOf,
  ModelError,
  modelOf,
  providerOf,
  RETURNED_UNRECORDED,
  stopSignalOf,
  toolCallEnded,
  toolCallStarted,
} from '../common.ts';
import { answerOnce, type Items, type Parsed, type Run, type Turn } from '../conversation.ts';
import { tookSteers } from '../steering.ts';
import { conversationView } from '../messages.ts';
import { type Answer, withChecked } from '../output.ts';
import { type Definition, sessionObject } from '../object.ts';
import { isTool, jsonSchemaOf, type Tool as AnyTool, waitFor } from '../tools.ts';
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
 * an agent loop needs, the persistence and its checkpoints, compaction (with
 * `compaction`'s settings), the provider of `route`, and with `approvals`
 * the approval service, which asks before a tool call that needs a person's
 * approval runs (see {@link approving}).
 */
async function boot(
  db: restate.Database,
  route: Route,
  system?: string,
  compaction: BasicCompactionConfig = {},
  approvals = false,
): Promise<Context> {
  const harness = new Context();
  await harness.plugin(LlmRuntime);
  await harness.plugin(SessionStore);
  await harness.plugin(SystemPrompt, system ? { personaPrefix: system } : {});
  await harness.plugin(ToolRuntime, {});
  // Without it, the harness denies a call that asks for an approval. With it,
  // the model is also told that some calls may ask for one.
  if (approvals) await harness.plugin(ApprovalService, {});
  await harness.plugin(AgentRegistry);
  await harness.plugin(SessionProjectionRegistry);
  await harness.plugin(SqlSessionPersistence, { db });
  await harness.plugin(checkpoints);
  // The model's input stays within its context window: as it nears the
  // window (or overflows it), the oldest history is condensed into a summary,
  // one more model request, after oversized tool results are trimmed. The
  // log keeps every event, and the conversation of turns every message.
  await harness.plugin(TokenMeter);
  await harness.plugin(ToolResultPruner);
  await harness.plugin(BasicCompactionEngine, compaction);
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

/** The signal that a tool call waits for, to the agent, when it needs a person's approval (`approval`). */
export const APPROVAL = 'approval';

/** Which tool calls wait for a person's approval: the names of their tools, or a function of a call that says whether it does. */
export type Approval = readonly string[] | ((call: { name: string; args: unknown }) => boolean);

/** The texts that approve a tool call, whatever their case. */
const APPROVED: ReadonlySet<string> = new Set(['approved', 'approve', 'yes', 'ok', 'allow', 'allowed']);

/**
 * What the value of an {@link APPROVAL} signal decides about its tool call:
 * `true`, `{ "approved": true }`, or a text such as "approved" or "yes"
 * approves it once; anything else rejects it, so a value that does not say
 * "approved" never runs the tool.
 */
const decided = (value: unknown): ApprovalOutcome =>
  value === true ||
  (typeof value === 'string' && APPROVED.has(value.trim().toLowerCase())) ||
  (typeof value === 'object' && value !== null && (value as { approved?: unknown }).approved === true)
    ? 'allowed-once'
    : 'rejected';

/**
 * Have the harness of the agent of `agentCtx` ask for an approval before
 * each tool call that `approval` names (`tools/pre-execute`, once the call
 * is allowed otherwise), and answer each ask (`approval/request`) with a
 * person's decision: a wait for the signal {@link APPROVAL} (`waitFor`),
 * which `pending` shows with the call's tool and arguments, without holding
 * a process.
 *
 * A crash, or a suspension, ends the attempt before the harness stored the
 * call: the retry asks the model again, which makes the call again under a
 * new id. Made with the same arguments, it joins the wait (`rejoin`): the
 * person is asked once. The wait is an approval (`approval`): a stopped
 * turn does not report its call as done because it was approved. An error
 * of the wait fails the attempt (`fail`), and its ask never ends: the
 * harness does not go on without a decision.
 */
function approving(agentCtx: Context, ctx: restate.SessionContext, approval: Approval, fail: (error: unknown) => void) {
  const needs = typeof approval === 'function' ? approval : ({ name }: { name: string }) => approval.includes(name);
  // The calls asked about, by id: what `pending` shows of each.
  const asked = new Map<string, { tool: string; args: unknown }>();
  agentCtx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow' || !needs({ name: exec.name, args: exec.arguments })) return decision;
    asked.set(exec.callId, { tool: exec.name, args: exec.arguments });
    return { kind: 'ask' };
  });
  agentCtx.on('approval/request', async ({ callId }, next) => {
    const call = callId === undefined ? undefined : asked.get(callId);
    // Asked by another (none is mounted): no one answers, and the harness denies it.
    if (callId === undefined || call === undefined) return next();
    asked.delete(callId);
    try {
      // The calls whose results are stored are forgotten first: an earlier
      // attempt's call with the same arguments, approved and done, is not this one.
      await toolCallStarted(ctx);
      return decided(await waitFor(ctx, callId, APPROVAL, call, { approval: true, rejoin: true }));
    } catch (error) {
      fromTool(ctx, error);
      fail(error);
      return new Promise<never>(() => {});
    }
  });
}

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
   * The tool calls that wait for a person's approval before they run: the
   * names of their tools, or a function of a call (its tool's name, and its
   * arguments) that says whether it does. Each waits for the signal
   * {@link APPROVAL} to the agent, which `pending` shows with the call's
   * tool and arguments; `true`, or a text such as "approved" or "yes",
   * approves it, anything else denies it.
   */
  approval?: Approval;
  /**
   * When the model's input is condensed: the settings of the harness's
   * compaction (@deepseek-ai/dsh-compaction-basic), such as `thresholdRatio`
   * (by default 0.8 of the model's context window) and `retainRatio` (the
   * newest 0.16 kept as it is).
   */
  compaction?: BasicCompactionConfig;
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
  load: (stored) => {
    // Only a harness's message (an id, a role, a list of content parts): another framework's row is not one.
    const m = JSON.parse(stored) as Message;
    if (typeof m.id !== 'string' || typeof m.role !== 'string' || !Array.isArray(m.content))
      throw new Error("not a DeepSeek harness's message (an id, a role and a list of content parts)");
    return freezeMessage(m);
  },
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
  // The harness keeps the prompt as it is given, the turn's reminder too; the conversation as it was asked.
  return message(promptId(turn.id), note + text + (turn.reminder ?? ''));
}

/** The id of the harness's message of the message `id` steered to a turn. */
const steerMessageId = (id: string) => `steer:${id}`;

/** The id of the steered message whose harness message has the id `messageId`, if it is one. */
const steeredId = (messageId: string) => (messageId.startsWith('steer:') ? messageId.slice(6) : undefined);

/**
 * Copy the events of `batch` that are `turn`'s (after its latest ask, at seq
 * `from()` of the log) into it, in `tx`: the model's replies, the tools'
 * results, and the messages steered to the turn that the harness placed at
 * a step (whose companion is told they are taken, in `tx`). Not the requests
 * to continue (a step of the run's own), nor anything once the run stopped
 * or `failed()` (the harness's result of a tool that failed the attempt, or
 * was cancelled, is not the call's): the turn's close, or the retry, says
 * how it ended. `resulted` gets the calls whose results it copied.
 */
const copying =
  (
    ctx: restate.SessionContext,
    turn: Turn<Message>,
    from: () => number | undefined,
    failed: () => boolean,
    resulted: (calls: string[]) => void,
  ) =>
  async (tx: Parameters<NonNullable<SqlSessionPersistence['copy']>>[0], batch: readonly SessionEvent[]) => {
    const start = from();
    if (start === undefined || failed() || stopSignalOf(ctx)?.aborted || !turn.writable) return;
    const held = new Set(turn.steered().map((e) => e.steer));
    const copied = batch.flatMap((e): { item: Message; reply?: boolean; steer?: string }[] => {
      if (e.seq <= start) return [];
      if (e.type === 'assistant/message') return [{ item: e.data.message, reply: true }];
      if (e.type === 'tool/result') return [{ item: e.data.message }];
      if (e.type !== 'user/message') return [];
      const steer = steeredId(e.data.id);
      return steer === undefined || held.has(steer) ? [] : [{ item: e.data, steer }];
    });
    if (copied.length === 0) return;
    await turn.copyIn(tx, copied);
    tookSteers(
      ctx,
      tx,
      copied.flatMap(({ steer }) => (steer === undefined ? [] : [steer])),
    );
    resulted(batch.flatMap((e) => (e.seq > start && e.type === 'tool/result' ? [e.data.message.toolCallId] : [])));
  };

/**
 * The run of the harness of `options`, on the conversation: its turn's
 * latest ask (its prompt, or the message that asked again) asked once, and
 * continued after a crash.
 */
const runOf =
  (ctx: restate.SessionContext, { model: named, system, tools = [], compaction, approval }: Options): Run<Message> =>
  async (conversation) => {
    const turn = conversation.turn;
    const route = routeOf(modelOf(named, DEEPSEEK_MODEL));
    const harness = await boot(ctx.db, route, system, compaction, approval !== undefined);
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
    let unlisten: (() => void) | undefined;
    // The turn asked again (its output's check, say): the harness is asked that, and answers it.
    const asked = turn.latestAsk();
    const again = asked !== turn.prompt;
    const id = again ? MessageId(`prompt:${turn.id}:again`) : promptId(turn.id);
    // Where the turn's latest ask is in the log, once it is.
    let from: number | undefined;
    // The tool calls that returned, whose ends are published once a flush stored their results.
    const returned = new Set<string>();
    try {
      const sessionId = SessionId(ctx.key);
      const options = {
        agentOptions: route,
        setup: (agentCtx: Context) => {
          for (const t of tools) agentCtx.tools.register(tracked(isTool(t) ? native(t, ctx) : t, ctx, fail, returned));
          if (approval !== undefined) approving(agentCtx, ctx, approval, fail);
        },
      };
      // Resuming closes a harness turn a crash, or a killed invocation, left open.
      const started = (await persistence.stat(sessionId))
        ? await harness.agents.resume({ resumeSessionId: sessionId, ...options })
        : await harness.agents.create({ sessionId, ...options });
      agent = started.agent;
      const found = agent.session.snapshotEvents().length;
      from = agent.session.snapshotEvents().find((e) => e.type === 'user/message' && e.data.id === id)?.seq;
      // A tool call's end is published once a flush stored its result, for followers to read it there.
      let ended = false;
      // The harness messages of the steered messages in the log: those before this attempt, and each flush's.
      const placed = new Set(
        agent.session
          .snapshotEvents()
          .flatMap((e) => (e.type === 'user/message' && steeredId(e.data.id) !== undefined ? [String(e.data.id)] : [])),
      );
      persistence.copy = async (tx, batch) => {
        for (const e of batch)
          if (e.type === 'user/message' && steeredId(e.data.id) !== undefined) placed.add(e.data.id);
        from ??= batch.find((e) => e.type === 'user/message' && e.data.id === id)?.seq;
        await copying(
          ctx,
          turn,
          () => from,
          () => broken,
          (calls) => {
            for (const call of calls) if (returned.delete(call)) ended = true;
          },
        )(tx, batch);
      };
      persistence.flushed = async () => {
        if (!ended) return;
        ended = false;
        // Failing, it fails the attempt, as a tool's error does: never the flush, which is done.
        await toolCallEnded(ctx).catch(fail);
      };
      // The messages steered to the turn, handed to the harness's step inbox as a publish lists them: only
      // while a tool call runs or its result is stored, so that a step after them places them, in this turn.
      const harnessAgent = agent;
      const given = new Set<string>();
      unlisten = inboxOf(ctx)?.listen(() => {
        if (stop?.aborted || broken) return;
        const pending = new Set(harnessAgent.inbox.nextStep.map((m) => String(m.id)));
        for (const { id: steerId, text } of inboxOf(ctx)!.messages) {
          const messageId = steerMessageId(steerId);
          if (given.has(steerId) || pending.has(messageId) || placed.has(messageId)) continue;
          given.add(steerId);
          harnessAgent.steer(message(messageId, text));
        }
      });
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
      unlisten?.();
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
 * `definition`, its calls published as they start, and as they end once
 * their results are stored (each call that returned is put in `returned`),
 * for the clients that follow the conversation; its error failing the
 * attempt.
 */
const tracked = (
  definition: ToolDefinition,
  ctx: restate.SessionContext,
  fail: (error: unknown) => void,
  returned: Set<string>,
): ToolDefinition => ({
  ...definition,
  execute: async (args, exec) => {
    try {
      await toolCallStarted(ctx);
      const result = await definition.execute(args, exec);
      // Its end is published once the harness stored its result (`runOf`).
      returned.add(exec.callId);
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
  withChecked(text, options, (t, o, check, reminder) =>
    // The harness keeps the model's history: the conversation reads only its latest turns.
    answerOnce(ctx, t, items, runOf(ctx, o), { check, reminder, ownHistory: true }),
  ) as Promise<Answer<O>>;

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
  return chatHandler(async (ctx, text) => prompt(ctx, text, await configured(options, ctx)), { steers: true });
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
