// Prebuilt LangGraph nodes that are Restate steps: wait for a signal, run a
// workflow, call or send to a handler, ask another agent. The Python SDK's
// restate/agents/langgraph/nodes.py.
//
// Add them to a graph of your own, as Restate's tools are added to an agent.
// Each reads its input from the graph's state, and writes what it gets back
// to the state field `output`:
//
//   const graph = new StateGraph(State)
//     .addNode('approve', nodes.waitForSignal('approval', { input: (s) => s.refund, output: 'approved' }))
//     .addNode('ship', nodes.workflow(shipping, { input: (s) => s.order, output: 'receipt' }));
//   const desk = langgraph.agent({ name: 'desk', graph });
//
// Or run the graph in a handler of your own, with its context as LangGraph's
// run context, its checkpoints in its database, and `durability: 'sync'`:
//
//   const app = graph.compile({ checkpointer: new SqlCheckpointSaver(ctx.db) });
//   await app.invoke(input, { configurable: { thread_id: 'refunds' }, context: ctx, durability: 'sync' });
//
// Each node does its step once. A crash runs a node again from the
// checkpoint it started from, which `durability: 'sync'` stored before the
// node ran, and LangGraph gives it the same task id there, so the node joins
// the workflow, the call, the agent's answer or the wait it started before
// rather than start another. A wait is listed by the agent's `pending` view,
// and its `signal` view resolves it.
import type * as restate from '@restatedev/sessions';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { signals, signalsOf } from '../signals.ts';
import { handlerContext } from './context.ts';

/** A LangGraph node: it takes the state and the run's config, and returns the state's update. */
// oxlint-disable-next-line typescript/no-explicit-any -- any graph's state
export type Node = (state: any, config: LangGraphRunnableConfig) => Promise<Record<string, unknown>>;

/** A service, virtual object or workflow, as its definition, of handlers `M`. */
type Target<M = unknown> =
  | restate.ServiceDefinition<string, M>
  | restate.VirtualObjectDefinition<string, M>
  | restate.WorkflowDefinition<string, M>;

/** Whether a target is keyed: a virtual object (key) or a workflow (id). */
const keyed = (target: Target) => 'object' in target || 'workflow' in target;

/** A node's run: the agent's context, the node's name, and the key that is the same each time it runs again. */
interface Step {
  ctx: restate.SessionContext;
  node: string;
  idempotencyKey: string;
}

/** LangGraph's keys, in a node's config, of its run's checkpointer, durability, and task id. */
const CHECKPOINTER = '__pregel_checkpointer';
const DURABILITY = '__pregel_durability';
const TASK_ID = '__pregel_task_id';

/** The run of a node of `kind`, from LangGraph's config. */
function stepOf(config: LangGraphRunnableConfig, kind: string): Step {
  const ctx = handlerContext(config.context);
  if (!ctx) {
    throw new TypeError(
      `nodes.${kind} runs in a graph that langgraph.agent({ graph }) runs, or that is invoked with the handler's ` +
        'context: invoke(input, { context: ctx })',
    );
  }
  const configurable = (config.configurable ?? {}) as Record<string, unknown>;
  if (!configurable[CHECKPOINTER]) {
    throw new TypeError(
      `nodes.${kind} runs in a graph with a checkpointer, so that a retried attempt resumes it: ` +
        'compile({ checkpointer: new SqlCheckpointSaver(ctx.db) })',
    );
  }
  // Only 'sync' stores a step's checkpoint before its tasks run. Otherwise a crash before the save makes the resumed
  // run create the checkpoint again, with a new id, and so new task ids: the step would be made twice.
  const durability = (config as { durability?: unknown }).durability ?? configurable[DURABILITY];
  if (durability !== 'sync') {
    throw new TypeError(
      `nodes.${kind} runs in a graph that stores each step's checkpoint before the step runs, so that a retried ` +
        "attempt gets the same task ids: invoke(input, { durability: 'sync' })",
    );
  }
  // The task's namespace holds its id, which LangGraph derives from the checkpoint the step started from: a node
  // run again from that checkpoint gets the same one. It holds the subgraph's path too.
  const namespace = String(configurable.checkpoint_ns || configurable[TASK_ID]);
  const node = namespace.split('|').at(-1)!.split(':')[0]!;
  return { ctx, node, idempotencyKey: `langgraph:${ctx.key}:${namespace}` };
}

/** The state's update that writes `value` to `output`, if given. */
const update = (output: string | undefined, value: unknown) => (output === undefined ? {} : { [output]: value });

/** As JSON, which Restate and the companion store: the state may hold class instances. */
const plain = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * A node that waits for the signal `name` to the agent, and writes its value
 * to `output`: a person's approval, say, or another system's result. The
 * graph waits without holding a process, for as long as it takes. The
 * agent's `pending` view lists the wait, with `input`'s value, and its
 * `signal` view resolves it:
 *
 *   graph.addNode('approve', nodes.waitForSignal('approval', { input: (s) => s.refund, output: 'approved' }))
 */
export const waitForSignal =
  // oxlint-disable-next-line typescript/no-explicit-any -- any graph's state
  (name: string, { output, input }: { output?: string; input?: (state: any) => unknown } = {}): Node =>
    async (state, config) => {
      const step = stepOf(config, 'waitForSignal');
      // The wait's id starts with the invocation's (the same in each attempt), as the waits of tools do, so that a
      // turn that ends without it (killed, say) has it closed: the companion closes the waits whose ids start with
      // the turn's.
      const id = `${step.ctx.request.id}:${step.idempotencyKey}`;
      const shown = input === undefined ? {} : { input: plain(input(state)) };
      const value = await step.ctx
        .rpc(signals, signalsOf(step.ctx), { idempotencyKey: id })
        .wait({ id, name, ...shown });
      return update(output, value);
    };

/** What a node that calls a handler takes. */
interface CallOptions {
  /** The state field that gets the result; none to write nothing. */
  output?: string;
  /** The handler's input, from the state; none for a handler that takes none. */
  // oxlint-disable-next-line typescript/no-explicit-any -- any graph's state
  input?: (state: any) => unknown;
  /** The key to call, from the state: for a virtual object's or a workflow's handler, and only for those. */
  // oxlint-disable-next-line typescript/no-explicit-any -- any graph's state
  key?: (state: any) => string;
}

/** Throw a `TypeError` if `key` is given for a target that is not keyed, or the other way around. */
function checkKey(target: Target, key: unknown) {
  if (keyed(target) !== (key !== undefined)) {
    throw new TypeError(
      `${target.name} ${keyed(target) ? 'is' : 'is not'} keyed: ${keyed(target) ? 'pass' : 'drop'} key`,
    );
  }
}

/**
 * A node that calls `handler` of `target` (a service, virtual object or
 * workflow), and writes its result to `output`:
 *
 *   graph.addNode('status', nodes.call(orders, 'status', { input: (s) => s.order, key: (s) => s.customer, output: 'status' }))
 */
export const call = <M>(target: Target<M>, handler: keyof M & string, options: CallOptions = {}): Node => {
  checkKey(target, options.key);
  return async (state, config) => {
    const { ctx, idempotencyKey } = stepOf(config, 'call');
    const result = await ctx.rpc({
      service: target.name,
      handler,
      key: options.key?.(state),
      input: plain(options.input?.(state)),
      idempotencyKey,
    });
    return update(options.output, result);
  };
};

/**
 * A node that sends to `handler` of `target`, without waiting for it to run,
 * after `delay` if given (such as `{ days: 1 }`). It writes nothing:
 *
 *   graph.addNode('remind', nodes.send(checkins, 'remind', { input: (s) => s.checkin, delay: { days: 1 } }))
 */
export const send = <M>(
  target: Target<M>,
  handler: keyof M & string,
  options: Omit<CallOptions, 'output'> & { delay?: restate.Duration } = {},
): Node => {
  checkKey(target, options.key);
  return async (state, config) => {
    const { ctx, idempotencyKey } = stepOf(config, 'send');
    ctx.send({
      service: target.name,
      handler,
      key: options.key?.(state),
      input: plain(options.input?.(state)),
      delay: options.delay,
      idempotencyKey,
    });
    return {};
  };
};

/**
 * A node that runs the workflow `target` (its `run` handler) to the end, and
 * writes its result to `output`. The workflow's id is `key`'s, or one of the
 * node's own, made of the agent's key and the node's task:
 *
 *   graph.addNode('ship', nodes.workflow(shipping, { input: (s) => s.order, output: 'receipt' }))
 */
export const workflow =
  (target: restate.WorkflowDefinition<string, { run: unknown }>, { output, input, key }: CallOptions = {}): Node =>
  async (state, config) => {
    const { ctx, idempotencyKey } = stepOf(config, 'workflow');
    const result = await ctx.rpc({
      service: target.name,
      handler: 'run',
      key: key?.(state) ?? idempotencyKey,
      input: plain(input?.(state)),
      idempotencyKey,
    });
    return update(output, result);
  };

/**
 * A node that sends a message to another agent (or any virtual object with
 * a handler that takes text), and writes its answer to `output`. The message
 * goes to the agent's key `<this key>.<node name>` unless `key` gives one, so
 * each run of the graph continues the same conversation with it:
 *
 *   graph.addNode('research', nodes.subagent(researcher, { message: (s) => s.question, output: 'findings' }))
 */
export const subagent =
  <M>(
    agent: restate.VirtualObjectDefinition<string, M>,
    {
      message,
      output,
      key,
      handler = 'chat',
    }: {
      // oxlint-disable-next-line typescript/no-explicit-any -- any graph's state
      message: (state: any) => string;
      output?: string;
      // oxlint-disable-next-line typescript/no-explicit-any -- any graph's state
      key?: (state: any) => string;
      handler?: string;
    },
  ): Node =>
  async (state, config) => {
    const { ctx, node, idempotencyKey } = stepOf(config, 'subagent');
    const answer = await ctx.rpc({
      service: agent.name,
      handler,
      key: key?.(state) ?? `${ctx.key}.${node}`,
      input: message(state),
      idempotencyKey,
    });
    return update(output, answer);
  };
