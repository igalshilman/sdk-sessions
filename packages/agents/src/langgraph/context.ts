// The handler's context of a graph's run, for this package's prebuilt nodes
// and Restate tools: the Python SDK's restate/agents/langgraph/_context.py.
//
// `langgraph.agent({ graph })` sets it for each run, which leaves LangGraph's
// run context (`runtime.context`, `config.context`) to the graph: one with a
// context schema of its own gets its own. A graph that a handler of your own
// runs, with `invoke(input, { context: ctx })`, has the handler's context as
// its run context, which the nodes and tools fall back to.
import { AsyncLocalStorage } from 'node:async_hooks';
import type * as restate from '@restatedev/sessions';

const RUN = new AsyncLocalStorage<restate.SessionContext>();

/** Run `body`, a graph's run for the handler of `ctx`: its nodes and tools find it with {@link handlerContext}. */
export const running = <T>(ctx: restate.SessionContext, body: () => Promise<T>): Promise<T> => RUN.run(ctx, body);

/** Whether `value` is a handler's context (a session object's): it has a database and a request. */
const isContext = (value: unknown): value is restate.SessionContext =>
  typeof value === 'object' && value !== null && 'db' in value && 'request' in value && 'key' in value;

/**
 * The handler's context of the graph run in progress, given LangGraph's run
 * context: the one {@link running} set, else the run context itself, for a
 * graph invoked with `context: ctx`; `undefined` if there is neither.
 */
export const handlerContext = (runContext: unknown): restate.SessionContext | undefined =>
  RUN.getStore() ?? (isContext(runContext) ? runContext : undefined);
