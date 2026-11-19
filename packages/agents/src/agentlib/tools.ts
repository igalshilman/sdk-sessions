// The tools of @restatedev/agents in an agentlib agent. Each becomes an
// agentlib tool whose calls are the generator SDK's, on the classic context
// of the agent's invocation, so Restate journals them:
//
// - `call`, `subagent` and `workflow` are calls: a crash replays their answer,
//   and stopping the turn cancels them. No call records or idempotency keys
//   are needed, as in a session object.
// - `send` is a send, made once.
// - `signal` waits at the agent's companion.
// - A `tool()` runs as a journaled step, as agentlib's `asyncTool` does. Its
//   `ctx` has `key` and `request`, but no database or calls: a classic
//   object has no session.
import {
  RunFailedError,
  tool as libTool,
  type JsonValue,
  type Tool as LibTool,
  type ToolContext as LibToolContext,
} from '@restatedev/agentlib';
import type { SessionContext } from '@restatedev/sessions';
import { call, run, send, serde, type Operation } from '@restatedev/restate-sdk-gen';
import { sdk as restate } from '@restatedev/sessions/internal';
import type { z } from 'zod';
import type { Configure } from '../common.ts';
import {
  type Approval,
  isTool,
  keyed,
  sentTo,
  specOf,
  type Target,
  type TargetOptions,
  text,
  type Tool,
  type ToolSpec,
} from '../tools.ts';
import { waitForSignal } from './state.ts';

/**
 * The context of an agentlib agent's run (agentlib's `RunContext.context`,
 * and a tool's `context.context`): the invocation's context of the classic
 * SDK. An operation awaits its calls with `internal.adopt` of
 * @restatedev/restate-sdk-gen.
 */
export interface AgentlibContext {
  readonly ctx: restate.ObjectContext;
}

/** A tool of agentlib (`tool`, `asyncTool`, `serviceTool`, `agentTool`, MCP's...). */
// A tool of any context (the agent's is AgentlibContext).
// oxlint-disable-next-line typescript/no-explicit-any
export type AgentlibTool = LibTool<any>;

/**
 * An agentlib agent's tools: the tools of `@restatedev/agents` (named by
 * their `name`), and agentlib's own (named by their key), in a list or in
 * one record.
 */
export type Tools =
  | ReadonlyArray<Tool | Record<string, AgentlibTool>>
  | Record<string, AgentlibTool | Tool>;

export type { Approval };

/**
 * Gives each tool its name, turning the tools of `@restatedev/agents` into
 * agentlib's. Those that `approval` names wait for a person's approval.
 */
export function toolsOf(
  agent: string,
  tools: Tools,
  approval?: Approval,
): Record<string, AgentlibTool> {
  const named: Record<string, AgentlibTool> = {};
  const ours = new Set<string>();
  const add = (name: string, tool: AgentlibTool | Tool) => {
    if (name in named) throw new Error(`${agent}: two tools are named ${name}`);
    if (isTool(tool)) {
      named[name] = fromTool(tool, name, approval);
      ours.add(name);
    } else {
      named[name] = tool;
    }
  };
  const addRecord = (record: Record<string, AgentlibTool | Tool>) => {
    for (const [name, tool] of Object.entries(record)) add(name, tool);
  };

  if (Array.isArray(tools)) {
    for (const tool of tools as ReadonlyArray<Tool | Record<string, AgentlibTool>>) {
      if (isTool(tool)) add(tool.name, tool);
      else addRecord(tool);
    }
  } else {
    addRecord(tools as Record<string, AgentlibTool | Tool>);
  }

  for (const name of Array.isArray(approval) ? approval : []) {
    if (ours.has(name)) continue;
    throw new Error(
      `${agent}: approval names ${name}, which is none of its tools of @restatedev/agents ` +
        "(agentlib's own tools take needsApproval)",
    );
  }
  return named;
}

/**
 * Turns `tool`, one of `@restatedev/agents`, into agentlib's, named `name`.
 * As in every agent, arguments that do not fit its input are the model's to
 * fix, and a terminal error is the tool's answer, which the model sees.
 */
export function fromTool(tool: Tool, name = tool.name, approval?: Approval): AgentlibTool {
  const spec = specOf(tool);
  if (!spec) {
    throw new Error(`${tool.name} is no tool of @restatedev/agents (tool(), call, send...)`);
  }

  function* execute(
    input: Record<string, unknown>,
    { context, callId }: LibToolContext<AgentlibContext>,
  ): Operation<JsonValue> {
    try {
      return yield* perform(tool, spec, input, context.ctx, callId);
    } catch (error) {
      // A tool() that reached for what an agentlib agent lacks is a programming
      // error: it fails the turn, rather than reach the model as an answer.
      if (error instanceof restate.TerminalError && error.message.startsWith(MISSING)) {
        throw new RunFailedError(`the tool ${tool.name}: ${error.message}`);
      }
      throw error;
    }
  }

  // agentlib's own tool(): it checks the input, and asks for the approval.
  return libTool<z.ZodObject, AgentlibContext>({
    description: tool.description,
    input: tool.input,
    needsApproval: needsApprovalOf(name, approval),
    execute,
  });
}

/** Whether the tool `name` needs approval, as agentlib's `needsApproval` takes it. */
function needsApprovalOf(name: string, approval: Approval | undefined) {
  if (approval === undefined) return false;
  if (typeof approval !== 'function') return approval.includes(name);
  const asks = approval;
  // oxlint-disable-next-line require-yield -- deciding needs no wait
  return function* (args: unknown): Operation<boolean> {
    return asks({ name, args });
  };
}

/** Does what `tool` does, with its checked `input`, as tool call `callId`. */
function* perform(
  tool: Tool,
  spec: ToolSpec,
  input: Record<string, unknown>,
  ctx: restate.ObjectContext,
  callId: string,
): Operation<JsonValue> {
  switch (spec.kind) {
    case 'run':
      return yield* runTool(tool.name, spec.run, input, ctx, callId);
    case 'call':
      return yield* callTool(tool.name, spec, input, ctx);
    case 'send':
      return yield* sendTool(tool.name, spec, input, ctx);
    case 'workflow':
      return yield* workflowTool(tool.name, spec, input, ctx, callId);
    case 'signal': {
      const shown = spec.shown ? input : undefined;
      return text(yield* waitForSignal(ctx, callId, spec.name, shown));
    }
    case 'subagent': {
      const { name, task } = input as { name: string; task: string };
      return text(yield* callJson(spec.agent, spec.handler, `${ctx.key}.${name}`, task));
    }
    default:
      throw new Error(`the tool ${tool.name} does what no agentlib agent knows`);
  }
}

// One function per kind of tool.

type Spec<K extends ToolSpec['kind']> = Extract<ToolSpec, { kind: K }>;

/**
 * A `tool()`: its `run` as a journaled step. It has no retry limit of its
 * own: a failure fails the attempt, which Restate retries.
 */
function* runTool(
  name: string,
  runOf: Spec<'run'>['run'],
  input: unknown,
  ctx: restate.ObjectContext,
  callId: string,
): Operation<JsonValue> {
  const context = { ctx: sessionOf(ctx), callId, idempotencyKey: `${ctx.request().id}:${callId}` };
  const action = runOf as (input: unknown, context: unknown) => unknown;
  return yield* run(async () => text(await action(input, context)), { name, retry: {} });
}

/** A `call`: a call of the handler, or the run of a workflow, which it waits for. */
function* callTool(
  name: string,
  spec: Spec<'call'>,
  input: Record<string, unknown>,
  ctx: restate.ObjectContext,
) {
  const { target, handler, options } = spec;
  const { key, parameter } = yield* split(name, target, options, input, ctx);
  if ('workflow' in target && handler === 'run') {
    return text(yield* runWorkflow(target.name, key!, parameter));
  }
  return text(yield* callJson(target.name, handler, key, parameter));
}

/** A `send`: a one-way call, after the tool's `delay` if it has one. */
function* sendTool(
  name: string,
  spec: Spec<'send'>,
  input: Record<string, unknown>,
  ctx: restate.ObjectContext,
) {
  const { target, handler, options } = spec;
  const { key, parameter } = yield* split(name, target, options, input, ctx);
  const message = { service: target.name, method: handler, key, parameter, inputSerde: serde.json };
  send(options.delay === undefined ? message : { ...message, delay: options.delay });
  return sentTo(target.name, key, handler);
}

/** A `workflow`: a run of its own per tool call, unless the tool's `key` gives its id. */
function* workflowTool(
  name: string,
  spec: Spec<'workflow'>,
  input: Record<string, unknown>,
  ctx: restate.ObjectContext,
  callId: string,
) {
  const { target, options } = spec;
  const key =
    options.key === undefined ? `${ctx.key}-${callId}` : yield* configured(name, options.key, ctx);
  return text(yield* runWorkflow(target.name, key, options.input ? input : undefined));
}

// The calls.

/** Calls `method` of `service` (at `key`), with JSON in and out. */
function callJson(service: string, method: string, key: string | undefined, parameter: unknown) {
  return call<unknown, unknown>({
    service,
    method,
    key,
    parameter,
    inputSerde: serde.json,
    outputSerde: serde.json,
  });
}

/**
 * Runs workflow `service` with id `key` to its end, and returns its result.
 * A workflow's `run` runs once per id: Restate refuses a second call of it,
 * but that call's invocation id is the run's. So the tool calls `run`, takes
 * the call's invocation id, and waits for that invocation; a fixed id that
 * ran before gets its run's result. It is a call, not a send, so that
 * stopping the turn cancels the run.
 */
function* runWorkflow(service: string, key: string, parameter: unknown): Operation<unknown> {
  const started = call<unknown>({
    service,
    method: 'run',
    key,
    parameter,
    inputSerde: serde.json,
    outputSerde: serde.binary,
  });
  const invocation = yield* started.invocation;
  return yield* invocation.attach(serde.json);
}

/** The key, and the handler's input, of a tool call's input (as `split` in ../tools.ts). */
function* split(
  name: string,
  target: Target,
  options: TargetOptions<z.ZodObject | undefined>,
  input: Record<string, unknown>,
  ctx: restate.ObjectContext,
): Operation<{ key: string | undefined; parameter: unknown }> {
  if (!keyed(target)) {
    return { key: undefined, parameter: options.input ? input : undefined };
  }
  if (options.key !== undefined) {
    const key = yield* configured(name, options.key, ctx);
    return { key, parameter: options.input ? input : undefined };
  }
  // The model chose the key, as a field of the tool's input.
  const { key, ...rest } = input as { key: string };
  return { key, parameter: options.input ? rest : undefined };
}

/** `value`, or, for a function of a session's context, what it returns, as a journaled step. */
function* configured<T>(
  name: string,
  value: Configure<T>,
  ctx: restate.ObjectContext,
): Operation<T> {
  if (typeof value !== 'function') return value;
  const session = sessionOf(ctx);
  const of = value as (ctx: SessionContext) => T | Promise<T>;
  return yield* run(async () => of(session), { name: `${name}: key` });
}

// What a tool() gets as its ctx.

/** How the error of a `tool()` that reached for a missing `ctx` field starts. */
const MISSING = 'not in an agentlib agent:';

const NO_DATABASE = 'an agentlib agent keeps its conversation in its state, with no SQL database';

const CALLS_INSTEAD =
  "give the agent Restate's tools (call, send, workflow, subagent) or agentlib's own";

/** Throws the error for a `tool()` that reached for `what`, saying what to use `instead`. */
function missing(what: string, instead: string): never {
  throw new restate.TerminalError(`${MISSING} ${what}: ${instead}`);
}

/**
 * A session object's context, as a `tool()` in an agentlib agent gets it:
 * `key` and `request`. Its database and calls fail the turn, saying what to
 * use instead.
 */
function sessionOf(ctx: restate.ObjectContext): SessionContext {
  const request = ctx.request();
  return Object.freeze({
    key: ctx.key,
    request,
    get db(): never {
      return missing('ctx.db', NO_DATABASE);
    },
    get rpc(): never {
      return missing('ctx.rpc', CALLS_INSTEAD);
    },
    get send(): never {
      return missing('ctx.send', CALLS_INSTEAD);
    },
    get cancel(): never {
      return missing('ctx.cancel', CALLS_INSTEAD);
    },
    // An agentlib agent runs on the SDK's journaled context, which has no `working`: the work just runs.
    working: <T>(fn: () => T | Promise<T>) => (async () => fn())(),
  });
}
