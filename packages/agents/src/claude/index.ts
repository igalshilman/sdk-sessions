// Claude agents in Restate virtual objects, on the tool runner of the
// Anthropic SDK (`client.beta.messages.toolRunner`): the conversation is the
// object's conversation of turns (../conversation.ts), whose items are the
// SDK's messages (`BetaMessageParam`).
//
//   const assistant = claude.agent({ name: 'assistant', system: 'Answer briefly.', tools: [weather] });
//
// or a handler of an object of your own: `handlers: { chat: claude.chat() }`,
// with options for each invocation: `claude.chat(async (ctx) => ({ system }))`,
// or a prompt of your own handler: `claude.prompt(ctx, text, options)`
//
// The model is `model`, or else MODEL, or else anthropic/claude-sonnet-5-5,
// with ANTHROPIC_API_KEY.
//
// The handler is not replayed: a retried attempt (a crash, a lost connection)
// runs again from the start, and starts the runner with what the model sees
// of the conversation (`history()`: the earlier turns as their prompts and
// answers, the latest whole):
// - Each reply of the model is stored before its tools run, and their results
//   before the next request. So a crash during the tools resumes them with the
//   same tool call ids (`callId(context)`), without asking the model again,
//   and a tool passes the id on to stay idempotent. A stored final reply is
//   the answer: the model is not asked for it again.
// - A tool's error fails the attempt, which Restate retries; but the SDK's
//   `ToolError`, which is meant for the model, is the tool's result.
// - A message is answered once per invocation (`answerOnce`).
// - A reply cut off at `maxTokens`, declined, or past the model's context
//   window ends the turn: its tool calls do not run, and the handler fails
//   with a terminal error.
// - With `output`, a model with structured outputs is asked for it natively:
//   each request of the run has its JSON schema (`output_config.format`),
//   which holds the final reply to it, and tool calls go on as before. The
//   reply is checked all the same (output.ts).
import * as restate from '@restatedev/sessions';
import { ScopeKey } from '@restatedev/sessions/internal';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool, BetaToolRunContext } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import {
  chatHandler,
  CLAUDE_MODEL,
  type Configure,
  configured,
  fromTool,
  modelIdOf,
  modelOf,
  RETURNED_UNRECORDED,
  stopSignalOf,
  type Summarize,
  toolCallEnded,
  toolCallStarted,
  NO_ANSWER,
} from '../common.ts';
import { answerOnce, type Items, type Parsed, type Run } from '../conversation.ts';
import { takeSteers } from '../steering.ts';
import { conversationView } from '../messages.ts';
import { type Answer, withChecked } from '../output.ts';
import type { z } from 'zod';
import { type Definition, sessionObject } from '../object.ts';
import { isTool, jsonSchemaOf, type Tool as AnyTool } from '../tools.ts';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** The id of the tool call a tool runs for: the runner always passes it. */
export const callId = (context?: BetaToolRunContext) => {
  if (!context) throw new Error('a tool call without its context');
  return context.toolUse.id;
};

/**
 * `messages` as the API takes them: it refuses an empty text, and an
 * assistant's message with no content but the last. The model may reply
 * with nothing (stored as it came): sent back, such a reply says so.
 */
const sendable = (messages: MessageParam[]): MessageParam[] =>
  messages.map((m) => {
    if (m.role !== 'assistant') return m;
    if (typeof m.content === 'string') return m.content.trim() ? m : { ...m, content: NO_ANSWER };
    const content = m.content.filter((b) => b.type !== 'text' || b.text.trim() !== '');
    if (content.length === 0) return { ...m, content: NO_ANSWER };
    return content.length === m.content.length ? m : { ...m, content };
  });

/** The text of stored content, without its tool calls and results. */
const storedText = (content: string | readonly { type: string; text?: string }[] | undefined) =>
  typeof content === 'string' ? content : (content ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');

/**
 * Claude's items: the SDK's messages, as JSON. A user's text is said by the
 * user, an assistant's by the assistant, and its `tool_use` blocks are its
 * calls; a `tool_result` is a result. A server tool's blocks (and a
 * `system` message) say nothing: they leave no open call the API would
 * refuse a result for.
 */
export const items: Items<MessageParam> = {
  dump: (message) => JSON.stringify(message),
  load: (stored) => {
    // Only a message of the API's (a role and its content): another framework's row is not one.
    const message = JSON.parse(stored) as MessageParam;
    const { role, content, ...rest } = message;
    if ((role !== 'user' && role !== 'assistant') || (typeof content !== 'string' && !Array.isArray(content)))
      throw new Error('not a message of the Claude API (a role and its content)');
    if (Object.keys(rest).length > 0)
      throw new Error(`not a message of the Claude API: ${Object.keys(rest).join(', ')}`);
    return message;
  },
  prompt: (text) => ({ role: 'user', content: text }),
  // The API refuses an empty text: an empty answer, as the model sees it later, says so.
  reply: (text) => ({ role: 'assistant', content: text.trim() ? text : NO_ANSWER }),
  // Every result of a reply in one message, as the API wants them.
  results: (results) =>
    results.length === 0
      ? []
      : [
          {
            role: 'user',
            content: results.map(([call, output]) => ({
              type: 'tool_result' as const,
              tool_use_id: call.id,
              content: output,
              ...(output === RETURNED_UNRECORDED ? {} : { is_error: true }),
            })),
          },
        ],
  read: (message): Parsed => {
    if (message.role !== 'user' && message.role !== 'assistant') return {};
    const { role, content } = message;
    if (typeof content === 'string') return { said: [role, content] };
    const texts = content.filter((b) => b.type === 'text');
    const calls = content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []));
    const results = content.flatMap((b) =>
      b.type === 'tool_result'
        ? [{ id: b.tool_use_id, output: storedText(b.content as never), error: b.is_error === true }]
        : [],
    );
    // Each reply of the model is a message of its own, its tool calls' too (as
    // the views gave them before); a message of results only says nothing.
    const said = role === 'assistant' || texts.length > 0;
    return {
      ...(said ? { said: [role, texts.map((b) => b.text).join('')] as ['user' | 'assistant', string] } : {}),
      calls,
      results,
    };
  },
};

/**
 * `tools`, whose errors fail the attempt: the runner would hand a thrown error
 * to the model as the tool's result, so each one is kept, for `check()` to
 * throw once the tools ran. The SDK's `ToolError` is for the model: the
 * runner hands it over as the tool's result.
 */
function failing(ctx: restate.SessionContext, tools: BetaRunnableTool[]) {
  let failure: unknown;
  return {
    tools: tools.map((tool): BetaRunnableTool => ({
      ...tool,
      run: async (args, context) => {
        try {
          return await tool.run(args, context);
        } catch (e) {
          if (e instanceof ToolError) throw e;
          fromTool(ctx, e);
          failure ??= e;
          throw e;
        }
      },
    })),
    check: () => {
      if (failure !== undefined) throw failure;
    },
  };
}

const textOf = (content: Anthropic.Beta.Messages.BetaContentBlock[]) =>
  content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

interface Agent {
  client: Anthropic;
  model: string;
  maxTokens: number;
  effort?: Effort;
  system?: string;
  tools: BetaRunnableTool[];
  /** The JSON schema of `output`, asked for natively: the API holds the final reply to it. */
  format?: Anthropic.Beta.Messages.BetaJSONOutputFormat;
}

/**
 * The run of `agent` on the conversation: from the stored turn on, each
 * reply stored before its tools run, and their results after; each round of
 * tool calls published as it starts and ends (for the clients that follow
 * the conversation). At each step (before a request that follows the
 * prompt or the tools' results), it takes the messages steered to the turn
 * (`takeSteers`): the request then goes out from the conversation's
 * history, which has them after the tools' results.
 */
const runOf =
  (ctx: restate.SessionContext, agent: Agent): Run<MessageParam> =>
  async (conversation) => {
    const { client, model, maxTokens, effort, system, format } = agent;
    const turn = conversation.turn;
    for (;;) {
      // A stored final reply is the answer: the model is not asked for it again.
      const final = turn.finalReply();
      if (final !== undefined) return final;
      // A paused reply goes back as the last message, which a steered one would not leave it.
      if (turn.entries.at(-1)!.parsed?.said?.[0] !== 'assistant') await takeSteers(ctx, conversation);
      const { tools, check } = failing(ctx, agent.tools);
      const runner = client.beta.messages.toolRunner(
        {
          model,
          max_tokens: maxTokens,
          ...(effort === undefined && format === undefined ? {} : { output_config: { effort, format } }),
          ...(system === undefined ? {} : { system }),
          tools,
          messages: sendable(conversation.history()),
        },
        { signal: stopSignalOf(ctx) },
      );
      /** A step: the messages steered to the turn go into the next request, after the tools' results. */
      const step = async () => {
        if ((await takeSteers(ctx, conversation)).length === 0) return;
        // The runner leaves the history to its caller, who changed it: the reply, its results and the messages.
        runner.setMessagesParams((params) => ({ ...params, messages: sendable(conversation.history()) }));
      };
      // A reply whose tools did not finish (a crash): run them, with the same
      // ids, once the calls whose results are stored are settled, as for any
      // reply: else one of its calls could take the id of an identical call
      // answered before.
      if (turn.openCalls().length > 0) {
        await toolCallStarted(ctx);
        const results = await runner.generateToolResponse();
        check();
        if (results) {
          await turn.append(results);
          runner.pushMessages(results);
        }
        await toolCallEnded(ctx);
        await step();
      }
      let paused = false;
      for await (const message of runner) {
        // A reply that cannot go on ends the turn, whose tool calls do not run.
        const stopped = stoppedShort(message, maxTokens);
        if (stopped) throw new restate.TerminalError(stopped);
        const said: MessageParam = { role: 'assistant', content: message.content };
        // Paused (a server tool's long turn): a step of the turn, not a reply to
        // end it with, and the model goes on from it.
        if (message.stop_reason === 'pause_turn') {
          await turn.append(said);
          paused = true;
          break;
        }
        await turn.appendReply([said]);
        if (!message.content.some((c) => c.type === 'tool_use')) return textOf(message.content);
        await toolCallStarted(ctx);
        const results = await runner.generateToolResponse();
        check();
        if (results) await turn.append(results);
        await toolCallEnded(ctx);
        await step();
      }
      if (!paused) throw new Error('the tool runner ended without a reply');
    }
  };

/**
 * Why the model's `message` stopped short of a reply to go on from: cut off
 * at `maxTokens` (its text, or a tool call's input, unfinished), declined, or
 * past the model's context window: a terminal error's message.
 */
function stoppedShort(message: Anthropic.Beta.Messages.BetaMessage, maxTokens: number) {
  if (message.stop_reason === 'max_tokens') {
    return `the model's reply reached maxTokens (${maxTokens}) before it ended: raise the agent's maxTokens`;
  }
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    return `the model declined to answer${category ? ` (${category})` : ''}`;
  }
  if (message.stop_reason === 'model_context_window_exceeded') {
    return "the conversation outgrew the model's context window: lower the agent's window or budget";
  }
  return undefined;
}

/** `t` as a tool of the Anthropic SDK's tool runner: `t.run` checks the model's arguments itself. */
const native = (t: AnyTool, ctx: restate.SessionContext): BetaRunnableTool => ({
  type: 'custom',
  name: t.name,
  description: t.description,
  input_schema: jsonSchemaOf(t) as Anthropic.Beta.Messages.BetaTool.InputSchema,
  parse: (args) => args,
  run: (args, context) => t.run(args, { ctx, callId: callId(context) }),
});

/** How much effort the model puts into a reply (Anthropic's `output_config.effort`). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** An agent's options: `chat` and `prompt` take them. */
export interface Options<O extends z.ZodObject | undefined = z.ZodObject | undefined> {
  /** The model, as `anthropic/model-id`: MODEL, or else anthropic/claude-sonnet-5-5. */
  model?: string;
  /** The system prompt. */
  system?: string;
  /** The agent's tools: `tool()`s, Restate's (`call`, `signal`...), or the SDK's (such as `betaZodTool`s). */
  tools?: (AnyTool | BetaRunnableTool)[];
  /** The client of the Anthropic API: by default one with ANTHROPIC_API_KEY. */
  client?: Anthropic;
  /**
   * The most tokens of each of the model's replies (default 16000). A reply
   * cut off there ends its prompt, which fails (a terminal error).
   */
  maxTokens?: number;
  /** How much effort the model puts into each reply: more is more thorough, and slower (default: the model's). */
  effort?: Effort;
  /**
   * The answer as data: a zod object, whose JSON the agent replies with
   * (checked), and `chat` and `prompt` answer with (see output.ts).
   */
  output?: O;
  /**
   * Whether the model is asked for `output` natively, with the API's
   * structured outputs (`output_config.format`: the JSON schema the API
   * holds the final reply to), rather than in the prompt (default: if the
   * model has them, as Claude's have since the 4.5 models). A schema the API
   * cannot take (too complex, say) refuses the message: `false` asks in the
   * prompt instead.
   */
  nativeOutput?: boolean;
}

/**
 * The Claude models with structured outputs: of each family, the 4.5 models
 * and later (and Mythos Preview); not Claude 3, Opus 4 and 4.1, or Sonnet 4.
 */
const STRUCTURED_OUTPUTS =
  /claude-(?:(?:opus|sonnet|haiku)-4-[5-9](?!\d)|(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|[1-9]\d)|mythos-preview)/;

/** Whether an agent of `options` asks the model for its `output` natively (see `nativeOutput`). */
const asksNatively = ({ model, output, nativeOutput }: Options) =>
  output !== undefined &&
  (nativeOutput ?? STRUCTURED_OUTPUTS.test(modelIdOf(modelOf(model, CLAUDE_MODEL), 'anthropic')));

/**
 * `output`'s JSON schema, as the API takes it (the SDK's helper's): what the
 * API does not take (a string's `minLength`, say) goes to a description, and
 * is left to the check of the reply.
 */
const formatOf = (output: z.ZodObject): Anthropic.Beta.Messages.BetaJSONOutputFormat => {
  const { type, schema } = betaZodOutputFormat(output);
  return { type, schema };
};

/** The client of an agent without one of its own, on the context of the turn it answers. */
const CLIENT = new ScopeKey<Anthropic>('the Anthropic client');

/** The agent of `options`, for the turn of `ctx`. */
const agentOf = (ctx: restate.SessionContext, options: Options): Agent => {
  const { model, system, tools = [], client, maxTokens = 16_000, effort, output } = options;
  return {
    client: client ?? CLIENT.of(ctx, () => new Anthropic()),
    model: modelIdOf(modelOf(model, CLAUDE_MODEL), 'anthropic'),
    maxTokens,
    effort,
    system,
    tools: tools.map((t) => (isTool(t) ? native(t, ctx) : t)),
    ...(output !== undefined && asksNatively(options) ? { format: formatOf(output) } : {}),
  };
};

/**
 * Answer `text`, once: a retried attempt resumes the same prompt. Each prompt
 * of an invocation is a prompt of its own.
 * With `output`, it answers with the value the agent replies with (see
 * output.ts), not its text: a reply that is not one is asked again within
 * its turn, once. A model with structured outputs is asked for it natively
 * (`nativeOutput`), else in the prompt.
 */
export const prompt = async <O extends z.ZodObject | undefined = undefined>(
  ctx: restate.SessionContext,
  text: string,
  options: Options<O> = {},
): Promise<Answer<O>> =>
  withChecked(
    text,
    options,
    (t, o, check, reminder) => answerOnce(ctx, t, items, runOf(ctx, agentOf(ctx, o)), { check, reminder }),
    asksNatively(options),
  ) as Promise<Answer<O>>;

/**
 * A chat handler: each message an invocation, the conversation in the
 * object's database, with `options`, or the options a function of the
 * invocation's context gives. It takes the message as plain text
 * (`curl -d 'Hi'`) or as a JSON string (`curl --json '"Hi"'`).
 */
export const chat = <O extends z.ZodObject | undefined = undefined>(options: Configure<Options<O>> = {}) => {
  if (typeof options === 'object') modelIdOf(modelOf(options.model, CLAUDE_MODEL), 'anthropic');
  return chatHandler(async (ctx, message) => prompt(ctx, message, await configured(options, ctx)), { steers: true });
};

/**
 * A view of the conversation as clients read it: a page at a time, or what
 * is new or changed since a cursor; `view: 'summary'` for each turn's
 * message and answer. It answers while a message is answered.
 */
export const messages = () => conversationView(items);

/**
 * How an agent of `options` summarizes the earliest turns, past its budget:
 * with its own client and model (`agent()` gives it; for an object of your
 * own, `sessionObject`'s `summarize`).
 */
export const summarizer =
  (options: Options = {}): Summarize =>
  async (ctx, request) => {
    const { client, model, maxTokens } = agentOf(ctx, { ...options, tools: [] });
    const message = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: request }],
    });
    return textOf(message.content);
  };

/** An agent: a virtual object `name`, one per key, whose `chat` handler is {@link chat}, and `messages` {@link messages}. */
export const agent = <P extends string, O extends z.ZodObject | undefined = undefined>({
  name,
  description,
  schema,
  background,
  window,
  budget,
  summarize,
  ...options
}: Options<O> & Definition<P>) =>
  sessionObject({
    name,
    description,
    schema,
    background,
    window,
    budget,
    summarize: summarize ?? summarizer(options),
    handlers: { chat: chat(options) },
    views: { messages: messages() },
  });
