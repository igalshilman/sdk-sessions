// LangGraph agents in Restate virtual objects: a tool-calling graph on the
// object's conversation of turns (../conversation.ts), whose items are
// LangChain's messages. `SqlCheckpointSaver` (checkpointer.ts) is for graphs
// of your own, which keep their checkpoints in the object's database.
//
//   const assistant = langgraph.agent({ name: 'assistant', tools: [search] });
//
// or a handler of an object of your own: `handlers: { chat: langgraph.chat() }`,
// with options for each invocation: `langgraph.chat(async (ctx) => ({ system }))`,
// or a prompt of your own handler: `langgraph.prompt(ctx, text, options)`
//
// The graph is the usual tool-calling loop: a model node, a tools node, and
// back to the model until it answers. The model is `model` (a chat model,
// `openai/model-id` or `anthropic/model-id`), or else MODEL, or else
// openai/gpt-6-sol, with OPENAI_API_KEY.
//
// The handler is not replayed: a retried attempt (a crash, a lost connection)
// runs again from the start, and the graph starts from what the model sees
// of the conversation (`history()`: the earlier turns as their prompts and
// answers, the latest whole):
// - The model node stores its reply before it returns, and the tools node
//   each tool's result as it lands. So a crash during the tools resumes
//   those without a result, with the same tool call ids, which a tool passes
//   on to stay idempotent; and a stored final reply is the answer, without
//   asking the model again.
// - A tool's error fails the attempt, which Restate retries (the ToolNode
//   would hand it to the model as the tool's result); a call of a tool the
//   agent lacks, or with arguments that do not fit, is the model's to fix.
// - A message is answered once per invocation (`answerOnce`).
import type * as restate from '@restatedev/sessions';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  mapStoredMessagesToChatMessages,
  type StoredMessage,
  SystemMessage,
  type ToolCall,
  ToolMessage,
} from '@langchain/core/messages';
import { type StructuredToolInterface, tool, ToolInputParsingException } from '@langchain/core/tools';
import { END, isGraphInterrupt, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import {
  chatHandler,
  type Configure,
  configured,
  fromTool,
  ModelError,
  modelOf,
  providerOf,
  RETURNED_UNRECORDED,
  stopSignalOf,
  type Summarize,
  toolCallEnded,
  toolCallStarted,
  NO_ANSWER,
} from '../common.ts';
import { answerOnce, type Conversation, type Items, type Run, type Turn } from '../conversation.ts';
import { conversationView } from '../messages.ts';
import { type Answer, withChecked } from '../output.ts';
import type { z } from 'zod';
import { type Definition, sessionObject } from '../object.ts';
import { takeSteers } from '../steering.ts';
import { isTool, jsonSchemaOf, type Tool as AnyTool } from '../tools.ts';

import { SqlCheckpointSaver } from './checkpointer.ts';
import { handlerContext } from './context.ts';
import { terminalOf } from './errors.ts';
import { type AnyGraph, check as checkGraph, graphRun } from './graph.ts';

export { SqlCheckpointSaver };
export { type AnyGraph, INTERRUPT } from './graph.ts';
export * as nodes from './nodes.ts';

/**
 * LangGraph's items: LangChain's messages, stored as their `toDict()`. A
 * human message is said by the user; an AI message by the assistant, with
 * its `tool_calls` as calls; a tool message is a result (an error if its
 * status says so).
 */
export const items: Items<BaseMessage> = {
  dump: (message) => JSON.stringify(message.toDict()),
  load: (stored) => mapStoredMessagesToChatMessages([JSON.parse(stored) as StoredMessage])[0]!,
  prompt: (text) => new HumanMessage(text),
  // A steered message, told apart from a prompt in the run's state by its id, which is stored with it.
  steered: (text, steerId) => new HumanMessage({ content: text, id: `steer:${steerId}` }),
  // A provider may refuse an empty message: an empty answer, as the model sees it later, says so.
  reply: (text) => new AIMessage(text.trim() ? text : NO_ANSWER),
  results: (results) =>
    results.map(
      ([call, output]) =>
        new ToolMessage({
          tool_call_id: call.id,
          name: call.name,
          content: output,
          ...(output === RETURNED_UNRECORDED ? {} : { status: 'error' as const }),
        }),
    ),
  read: (message) => {
    if (HumanMessage.isInstance(message)) return { said: ['user', message.text] };
    if (AIMessage.isInstance(message)) {
      const calls = (message.tool_calls ?? []).map((c) => ({ id: c.id ?? '', name: c.name, input: c.args }));
      // Each reply is a message of its own, its tool calls' too.
      return { said: ['assistant', message.text], calls };
    }
    if (ToolMessage.isInstance(message)) {
      return { results: [{ id: message.tool_call_id, output: message.text, error: message.status === 'error' }] };
    }
    return {};
  },
};

/** Whether `message` is a reply of the model with nothing in it: no text, no tool call, no other content. */
const blank = (message: AIMessage) =>
  (message.tool_calls ?? []).length === 0 &&
  (typeof message.content === 'string'
    ? !message.content.trim()
    : message.content.every((b) => b.type === 'text' && !(typeof b.text === 'string' && b.text.trim())));

/**
 * `messages` as a provider takes them: a reply of the model with nothing in
 * it (stored as it came) says so, as an empty answer does. Anthropic's API
 * refuses an empty message but the last.
 */
const sendable = (messages: BaseMessage[]) =>
  messages.map((m) => (AIMessage.isInstance(m) && blank(m) ? new AIMessage(NO_ANSWER) : m));

/** `t`, its errors given to `failed`, but for its input's (arguments that do not fit) and LangGraph's interrupts. */
const failing = (
  ctx: restate.SessionContext,
  t: StructuredToolInterface,
  failed: (error: unknown) => void,
): StructuredToolInterface =>
  Object.create(t, {
    invoke: {
      value: async (...args: Parameters<StructuredToolInterface['invoke']>) => {
        try {
          return await t.invoke(...args);
        } catch (error) {
          if (!(error instanceof ToolInputParsingException) && !isGraphInterrupt(error)) {
            fromTool(ctx, error);
            failed(error);
          }
          throw error;
        }
      },
    },
  }) as StructuredToolInterface;

/**
 * The tools node: each tool call of the turn without a result run by a
 * ToolNode, which answers the model with what is wrong when a call names a
 * tool the agent does not have, or arguments that do not fit (the model's to
 * fix: failing the attempt, every retry would meet the same call again). Each
 * result is stored as it lands. Any other error of a tool fails the attempt,
 * at once (the ToolNode would hand it to the model too). The round is
 * published as it starts and ends, for the clients that follow the
 * conversation.
 */
function toolsNode(ctx: restate.SessionContext, turn: Turn<BaseMessage>, tools: StructuredToolInterface[]) {
  return async (_state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
    await toolCallStarted(ctx);
    // The first error fails the attempt at once, not once the other calls end.
    const { promise: failure, reject } = Promise.withResolvers<never>();
    failure.catch(() => {});
    let broken = false;
    const failed = (error: unknown) => {
      broken = true;
      reject(error);
    };
    const node = new ToolNode(
      tools.map((t) => failing(ctx, t, failed)),
      { handleToolErrors: true },
    );
    const one = async (call: ToolCall) => {
      const ran = (await node.invoke({ messages: [new AIMessage({ content: '', tool_calls: [call] })] }, config)) as {
        messages: BaseMessage[];
      };
      // A tool's error fails the attempt: the ToolNode's answer to the model of it is not the call's result.
      if (broken) return [];
      await turn.append(...ran.messages);
      return ran.messages;
    };
    const calls = turn.openCalls().map((c) => ({ id: c.id, name: c.name, args: c.input as Record<string, unknown> }));
    const ran = await Promise.race([Promise.all(calls.map(one)), failure]);
    await toolCallEnded(ctx);
    return { messages: ran.flat() };
  };
}

/** `provider/model-id` as its provider and model id, for a provider the usual graph takes. */
const providerOfModel = (named: string) => {
  const [provider, id] = providerOf(named);
  if ((provider !== 'openai' && provider !== 'anthropic') || !id) {
    const from = process.env.MODEL === named ? ' (from MODEL)' : '';
    throw new ModelError(`the model "${named}"${from} is neither openai/<model-id> nor anthropic/<model-id>`);
  }
  return [provider, id] as const;
};

/**
 * The chat model `provider/model-id` names: OpenAI's or Anthropic's, through
 * LangChain's integration of the provider, loaded when a model of it is
 * used (Node loads a module once): only that one need be installed.
 */
const chatModel = async (named: string): Promise<BaseChatModel> => {
  const [provider, id] = providerOfModel(named);
  if (provider === 'openai') {
    const { ChatOpenAI } = await integration('@langchain/openai', () => import('@langchain/openai'));
    // OpenAI's reasoning models take function tools only on the Responses API
    // (on Chat Completions they refuse them, unless reasoning is off).
    return new ChatOpenAI({ model: id, useResponsesApi: true });
  }
  const { ChatAnthropic } = await integration('@langchain/anthropic', () => import('@langchain/anthropic'));
  return new ChatAnthropic({ model: id });
};

/** The integration `name`, which its user installs beside @restatedev/agents. */
async function integration<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new ModelError(
      `${name.replace('@langchain/', '')}/<model-id> models need ${name}: install it beside @restatedev/agents`,
    );
  }
}

/**
 * The agent's graph, for the latest turn of `conversation`: `model`, calling
 * `tools`, from the tools if the turn has calls without results (a crash cut
 * them off). The model node takes the messages steered to the turn first
 * (`takeSteers`: it runs after the prompt or the tools' results), which go
 * into its request and stay in the run's state, and stores each reply before
 * it returns.
 */
function toolLoop(
  ctx: restate.SessionContext,
  conversation: Conversation<BaseMessage>,
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  system?: string,
) {
  if (!model.bindTools) throw new Error(`${model.getName()} does not call tools`);
  const withTools = model.bindTools(tools);
  const turn = conversation.turn;
  return new StateGraph(MessagesAnnotation)
    .addNode('model', async ({ messages }) => {
      const steered = await takeSteers(ctx, conversation);
      const asked = [...messages, ...steered];
      const reply = await withTools.invoke(system ? [new SystemMessage(system), ...asked] : asked);
      await turn.appendReply([reply]);
      return { messages: [...steered, reply] };
    })
    .addNode('tools', toolsNode(ctx, turn, tools))
    .addConditionalEdges(START, () => (turn.openCalls().length > 0 ? 'tools' : 'model'), {
      tools: 'tools',
      model: 'model',
    })
    .addConditionalEdges('model', toolsCondition, { tools: 'tools', [END]: END })
    .addEdge('tools', 'model');
}

/** How many steps a turn takes at most, by default: tool rounds enough for any turn, and the end of a run that loops. */
const RECURSION_LIMIT = 10_000;

/** The run of the agent: the graph from what the model sees, to the final reply's text. */
const runOf =
  (
    ctx: restate.SessionContext,
    model: BaseChatModel,
    tools: StructuredToolInterface[],
    system?: string,
    recursionLimit = RECURSION_LIMIT,
  ): Run<BaseMessage> =>
  async (conversation) => {
    const turn = conversation.turn;
    // A stored final reply is the answer: the model is not asked for it again.
    const final = turn.finalReply();
    if (final !== undefined) return final;
    const app = toolLoop(ctx, conversation, model, tools, system).compile();
    try {
      const { messages } = await app.invoke(
        { messages: sendable(conversation.history()) },
        { signal: stopSignalOf(ctx), recursionLimit },
      );
      return messages.at(-1)!.text;
    } catch (error) {
      // LangGraph's own errors (a run that loops, an invalid update) would be met again: they end the turn.
      throw terminalOf(error) ?? error;
    }
  };

/**
 * `t` as a LangChain tool: `t.run` checks the model's arguments itself. Its
 * context is `ctx`, or else the graph's run's (context.ts).
 */
const native = (t: AnyTool, ctx?: restate.SessionContext): StructuredToolInterface =>
  tool(
    async (args: unknown, config) => {
      const { toolCall } = config;
      if (!toolCall?.id) throw new Error('a tool call without an id');
      const at = ctx ?? handlerContext((config as { context?: unknown }).context);
      if (!at) {
        throw new TypeError(
          `the tool ${t.name} runs in a graph that langgraph.agent({ graph }) runs, or that is invoked with the ` +
            "handler's context: invoke(input, { context: ctx })",
        );
      }
      return t.run(args, { ctx: at, callId: toolCall.id });
    },
    // What does not fit, for the model to fix: not only that something does not.
    { name: t.name, description: t.description, schema: jsonSchemaOf(t), verboseParsingErrors: true },
  );

/**
 * `given` as LangChain tools, for a graph of your own or LangChain's
 * `createAgent`:
 *
 *   const graph = createAgent({ model, tools: langgraph.tools([call(orders, 'status', { description: '…' })]) });
 *   const desk = langgraph.agent({ name: 'desk', graph });
 *
 * Restate's tools (`call`, `send`, `workflow`, `subagent`, `signal`) make
 * their Restate calls once per tool call, even if a crash runs the tool call
 * again: the model's reply, with the tool call's id, is checkpointed before
 * the tools run. A `tool()` of your own runs your function, again after a
 * crash, as do LangChain's tools, which are passed through. They take the
 * handler's context from the graph's run (`langgraph.agent({ graph })` gives
 * it; a handler of your own passes `context: ctx`).
 */
export const tools = (given: (AnyTool | StructuredToolInterface)[]): StructuredToolInterface[] =>
  given.map((t) => (isTool(t) ? native(t) : t));

/** An agent's options: `chat` and `prompt` take them. */
export interface Options<O extends z.ZodObject | undefined = z.ZodObject | undefined> {
  /** The model: `openai/model-id` or `anthropic/model-id` (MODEL, or else openai/gpt-6-sol), or a chat model that calls tools. */
  model?: string | BaseChatModel;
  /** The system prompt: who the agent is, and how it answers. */
  system?: string;
  /** The agent's tools: `tool()`s, Restate's (`call`, `signal`...), or LangChain's. */
  tools?: (AnyTool | StructuredToolInterface)[];
  /** How many steps of the graph a turn takes at most (default 10 000): past it, the turn fails for good. */
  recursionLimit?: number;
  /**
   * The answer as data: a zod object, whose JSON the agent replies with
   * (checked), and `chat` and `prompt` answer with (see output.ts). With
   * `graph`, the graph's own prompts must ask for it.
   */
  output?: O;
  /**
   * A graph of your own to run, instead of the built-in tool-calling loop
   * (graph.ts): a `StateGraph` whose state has `messages`, or a compiled one
   * (such as LangChain's `createAgent` makes). It has its own model and
   * tools, so it takes no `model`, `system`, `tools` or `recursionLimit`.
   */
  graph?: AnyGraph;
  /**
   * The run context of `graph` (LangGraph's `context`), for a graph with a
   * context schema of its own. By default the handler's context. The
   * prebuilt `nodes` and the tools of `tools()` get the handler's context
   * either way.
   */
  context?: unknown;
}

/** Throw a `TypeError` if `options` gives a graph of your own with what only the built-in loop takes, or the other way around. */
function checkOptions({ graph, model, system, tools: given, recursionLimit, context }: Options) {
  if (graph === undefined) {
    if (context !== undefined) throw new TypeError('context is the run context of a graph of your own: pass graph');
    return;
  }
  const extra = Object.entries({ model, system, tools: given, recursionLimit }).flatMap(([name, value]) =>
    value === undefined ? [] : [name],
  );
  if (extra.length > 0) {
    throw new TypeError(`a graph of your own has its own model and tools: it takes no ${extra.join(', ')}`);
  }
  checkGraph(graph);
}

/** The chat model of `model`. */
const modelOfOptions = async (model: Options['model']) =>
  typeof model === 'object' ? model : chatModel(modelOf(model));

/**
 * Answer `text`, once: a retried attempt resumes the same prompt. Each prompt
 * of an invocation is a prompt of its own.
 * With `output`, it answers with the value the agent replies with (see
 * output.ts), not its text: a reply that is not one is asked again within
 * its turn, once.
 */
export const prompt = <O extends z.ZodObject | undefined = undefined>(
  ctx: restate.SessionContext,
  text: string,
  options: Options<O> = {},
): Promise<Answer<O>> => {
  checkOptions(options);
  const { graph, context } = options;
  if (graph !== undefined) {
    // The graph keeps its own history: the conversation loads the previous turn whole, for what closed it.
    return withChecked(text, options, (t, _options, check) =>
      answerOnce(ctx, t, items, graphRun(ctx, graph, context), { check, window: 1, budget: 0 }),
    ) as Promise<Answer<O>>;
  }
  return withChecked(text, options, async (t, { model, system, tools: given = [], recursionLimit }, check, reminder) =>
    answerOnce(
      ctx,
      t,
      items,
      runOf(
        ctx,
        await modelOfOptions(model),
        given.map((x) => (isTool(x) ? native(x, ctx) : x)),
        system,
        recursionLimit,
      ),
      { check, reminder },
    ),
  ) as Promise<Answer<O>>;
};

/**
 * A chat handler: each message an invocation, the conversation in the
 * object's database, with `options`, or the options a function of the
 * invocation's context gives. It takes the message as plain text
 * (`curl -d 'Hi'`) or as a JSON string (`curl --json '"Hi"'`).
 */
export const chat = <O extends z.ZodObject | undefined = undefined>(options: Configure<Options<O>> = {}) => {
  if (typeof options === 'object') {
    checkOptions(options);
    if (options.graph === undefined && typeof options.model !== 'object') providerOfModel(modelOf(options.model));
  }
  // The built-in loop takes steered messages at its steps; a graph of your own takes none (each is a turn of its
  // own). Options a function gives are its message's: given once per attempt, to the turn's start and its prompt.
  if (typeof options !== 'function') {
    const steers = options.graph === undefined;
    return chatHandler(async (ctx, message) => prompt(ctx, message, options), { steers });
  }
  const given = new WeakMap<restate.SessionContext, Promise<Options<O>>>();
  const optionsOf = (ctx: restate.SessionContext) => {
    let of = given.get(ctx);
    if (!of) given.set(ctx, (of = configured(options, ctx)));
    return of;
  };
  return chatHandler(async (ctx, message) => prompt(ctx, message, await optionsOf(ctx)), {
    steers: async (ctx) => (await optionsOf(ctx)).graph === undefined,
  });
};

/**
 * A view of the conversation as clients read it: a page at a time, or what
 * is new or changed since a cursor; `view: 'summary'` for each turn's
 * message and answer. It answers while a message is answered.
 */
export const messages = () => conversationView(items);

/**
 * How an agent of `model` summarizes the earliest turns, past its budget:
 * with its own model (`agent()` gives it; for an object of your own,
 * `sessionObject`'s `summarize`).
 */
export const summarizer =
  (model?: Options['model']): Summarize =>
  async (_ctx, request) =>
    (await (await modelOfOptions(model)).invoke([new HumanMessage(request)])).text;

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
    // A graph of your own keeps its own history, which the conversation's summaries do not reach.
    summarize: summarize ?? (options.graph === undefined ? summarizer(options.model) : undefined),
    handlers: { chat: chat(options) },
    views: { messages: messages() },
  });
