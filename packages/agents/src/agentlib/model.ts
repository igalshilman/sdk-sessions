// The agentlib agent's model: a model by name (`openai/…`, `anthropic/…`) or
// one of agentlib's, and how its provider's refusals end a turn.
import { isContextOverflow } from '@restatedev/agentlib';
import type { CompactionPolicy, Model, ModelRequest } from '@restatedev/agentlib';
import type { aiModel } from '@restatedev/agentlib/provider';
import { sdk as restate } from '@restatedev/sessions/internal';
import { CHECK_MODEL, ModelError, REFUSED } from '../common.ts';

/** The model of an agent that names none, without MODEL either: OpenAI's (OPENAI_API_KEY). */
export const DEFAULT_MODEL = 'openai/gpt-6-sol';

type LanguageModel = Parameters<typeof aiModel>[0]['model'];

/** The AI SDK's provider packages, by provider. OpenAI's uses its Responses API. */
const PROVIDERS: Record<string, () => Promise<(modelId: string) => LanguageModel>> = {
  openai: async () => (await import('@ai-sdk/openai')).openai,
  anthropic: async () => (await import('@ai-sdk/anthropic')).anthropic,
};

/**
 * Returns what loads agent `agent`'s model on its first turn: `model` itself,
 * or the model it names (`provider/model-id`, else MODEL, else
 * {@link DEFAULT_MODEL}) on the AI SDK. A name it cannot take throws at once.
 */
export function modelLoader(
  agent: string,
  model: string | Model | undefined,
): () => Promise<Model> {
  if (typeof model === 'function') return async () => model;

  const id = model ?? process.env.MODEL ?? DEFAULT_MODEL;
  const at = id.indexOf('/');
  if (at <= 0 || at === id.length - 1) {
    throw new Error(`${agent}: the model ${id} is not provider/model-id`);
  }
  const provider = id.slice(0, at);
  const modelId = id.slice(at + 1);
  const loadProvider = PROVIDERS[provider];
  if (!loadProvider) {
    throw new Error(
      `${agent}: an agentlib agent takes openai/… and anthropic/… models by name, not ${id}. ` +
        'Give any other as a model of agentlib (aiModel of @restatedev/agentlib/provider).',
    );
  }

  return async () => {
    const { aiModel } = await import('@restatedev/agentlib/provider');
    const languageModel = await loadLanguageModel(id, loadProvider, modelId);
    // `retry: {}` sets no retry limit of the model's own: an outage fails the
    // attempt, and Restate retries it, as for every agent.
    const loaded = aiModel({ model: languageModel, retry: {} });
    return provider === 'anthropic' ? withoutSchemaBounds(loaded) : loaded;
  };
}

/** Creates the AI SDK model `modelId`, with a clear error if its provider package is missing. */
async function loadLanguageModel(
  id: string,
  loadProvider: () => Promise<(modelId: string) => LanguageModel>,
  modelId: string,
): Promise<LanguageModel> {
  let create: (modelId: string) => LanguageModel;
  try {
    create = await loadProvider();
  } catch (error) {
    const provider = id.slice(0, id.indexOf('/'));
    const advice = `install it beside @restatedev/agentlib (${String(error)})`;
    throw new ModelError(`${id} needs @ai-sdk/${provider}: ${advice}`);
  }
  return create(modelId);
}

/**
 * Whether `error`, thrown by a model, is its provider's refusal that a retry
 * does not change: a request answered with a 4xx (a wrong API key, an unknown
 * model, a rejected request), or a missing API key. Only a plain
 * `TerminalError` qualifies: agentlib's own errors (an overflow, a protocol
 * error) and cancellations are subclasses. An overflow is never one: it is a
 * subclass only on the first attempt, and replay restores it as a plain
 * `TerminalError` with code 413, which agentlib still has to see to compact.
 */
export function refused(error: unknown): error is restate.TerminalError {
  if (!(error instanceof restate.TerminalError)) return false;
  if (isContextOverflow(error)) return false;
  if (error.constructor !== restate.TerminalError) return false;
  const clientError = error.code >= 400 && error.code < 500;
  return clientError || /API key/i.test(error.message);
}

/** Wraps `model` so that its provider's refusals end the turn with a 424, as for every agent. */
export function refusing(model: Model): Model {
  return function* (request: ModelRequest) {
    try {
      return yield* model(request);
    } catch (error) {
      if (!refused(error)) throw error;
      const message = `the model's provider refused the request: ${CHECK_MODEL}. ${error.message}`;
      throw new restate.TerminalError(message, { errorCode: REFUSED });
    }
  };
}

const NUMBER_BOUNDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);

/** Returns `schema` (a JSON schema) without the bounds of its numbers, at any depth. */
export function withoutBounds(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutBounds);
  if (typeof schema !== 'object' || schema === null) return schema;

  const type = (schema as { type?: unknown }).type;
  const types = Array.isArray(type) ? type : [type];
  const numeric = types.includes('integer') || types.includes('number');

  const kept = Object.entries(schema).filter(([key]) => !(numeric && NUMBER_BOUNDS.has(key)));
  return Object.fromEntries(kept.map(([key, value]) => [key, withoutBounds(value)]));
}

/**
 * Wraps an Anthropic `model` so that it gets its tools' schemas without
 * numeric bounds. agentlib 0.1.0 asked for strict tools where a schema
 * allowed it, and Anthropic refuses strict tools with bounded numbers (such as
 * agentlib's own `read_tool_result`). 0.2.0 leaves strict mode to the AI SDK's
 * defaults; the bounds still go, which costs nothing: the tools still check
 * their input.
 */
function withoutSchemaBounds(model: Model): Model {
  return (request) => {
    const tools = request.tools.map((tool) => {
      const inputSchema = withoutBounds(tool.inputSchema) as Record<string, unknown>;
      return { ...tool, inputSchema };
    });
    return model({ ...request, tools });
  };
}

/**
 * Checks that agent `agent`'s `history` bounds are positive integers. agentlib
 * checks them only when a turn compacts, with an error that a retry would meet
 * again and again.
 */
export function checkHistory(agent: string, history: CompactionPolicy) {
  for (const bound of ['maxMessages', 'maxChars', 'retainMessages'] as const) {
    const value = history[bound];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      const given = JSON.stringify(value);
      throw new Error(`${agent}: history.${bound} must be a positive integer, not ${given}`);
    }
  }
}
