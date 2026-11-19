// A graph of your own calls its models as it likes: its nodes, or LangChain's
// `createAgent`. The attempt must be kept alive (`ctx.working`) while a model
// serves a request, and a request is what LangChain's callbacks bracket: a
// chat model's start opens a scope, its end or error closes it.
//
// The handler awaits its handlers (`awaitHandlers`): LangChain awaits the
// start callback before it sends the request, so the scope is open by then.
// Not every request ends in a callback: a stream its consumer abandons, or a
// run cut off by a stop, calls neither the end nor the error. The run
// releases what is left (`releaseAll`) when its stream ends, however it ends.
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type * as restate from '@restatedev/sessions';
import { keepAlive } from '../common.ts';

/** A callback handler that keeps the attempt of `ctx` alive while a model's request of the run is out. */
export class KeepModelsAlive extends BaseCallbackHandler {
  name = 'restate-keep-models-alive';
  // Awaited, so that the scope is open before LangChain sends the request.
  override awaitHandlers = true;
  readonly #ctx: restate.SessionContext;
  readonly #open = new Map<string, () => void>();

  constructor(ctx: restate.SessionContext) {
    super();
    this.#ctx = ctx;
  }

  #begin(runId: string) {
    if (!this.#open.has(runId)) this.#open.set(runId, keepAlive(this.#ctx));
  }

  #end(runId: string) {
    this.#open.get(runId)?.();
    this.#open.delete(runId);
  }

  override handleChatModelStart(_llm: unknown, _messages: unknown, runId: string) {
    this.#begin(runId);
  }

  override handleLLMStart(_llm: unknown, _prompts: unknown, runId: string) {
    this.#begin(runId);
  }

  override handleLLMEnd(_output: unknown, runId: string) {
    this.#end(runId);
  }

  override handleLLMError(_error: unknown, runId: string) {
    this.#end(runId);
  }

  /** Close the scopes of requests that never reported their end: a run's, once its stream has ended. */
  releaseAll() {
    for (const release of this.#open.values()) release();
    this.#open.clear();
  }
}
