// LangGraph's own errors that a retry would meet again, which end a turn for
// good: the Python SDK's restate/agents/langgraph/_errors.py.
import * as restate from '@restatedev/sessions';
import { EmptyInputError, GraphRecursionError, InvalidUpdateError } from '@langchain/langgraph';

/**
 * The terminal error that ends the turn whose graph run failed with `error`,
 * if a retry cannot help. That is so for the errors that LangGraph's runtime
 * throws itself, rather than a node, a tool or a model:
 *
 * - `GraphRecursionError`: the run took more steps than its `recursionLimit`
 *   without finishing (a model that keeps calling tools, say). A retry runs
 *   on with a fresh limit, and calls the model again, at each retry.
 * - `InvalidUpdateError`: a step's update does not fit the state (two nodes
 *   writing a field that takes one value per step, say). A retry runs the
 *   step again, to the same update.
 * - `EmptyInputError`: the run had no input.
 */
export function terminalOf(error: unknown): restate.TerminalError | undefined {
  let why: string;
  if (error instanceof GraphRecursionError) why = 'the graph stopped at its recursion limit';
  else if (error instanceof InvalidUpdateError) why = 'the graph made an invalid state update';
  else if (error instanceof EmptyInputError) why = 'the graph got no input';
  else return undefined;
  return new restate.TerminalError(`${why}: ${error.message}`);
}
