// The bank agent on the DeepSeek Harness (@restatedev/agents/deepseek): a DeepSeekAgent object per conversation, whose tools
// (./bank.ts) move money in the ledger.
//
// Environment: PORT (default 9080), DEEPSEEK_API_KEY, MODEL, and ABORT_PER_MILLE (see
// ../faults.ts).
import { sessionObject, signals } from '@restatedev/agents';
import * as deepseek from '@restatedev/agents/deepseek';
import { serveIfMain } from '@restatedev/sessions/test/faults';
import { ledger } from '@restatedev/sessions/test/ledger';
import { bank } from './bank.ts';

/** Answer a message, once per invocation. */
export const prompt = deepseek.chat({
  system: 'You keep the books of a bank, with your tools. Answer briefly.',
  tools: bank('DeepSeekAgent'),
});

export const agent = sessionObject({
  name: 'DeepSeekAgent',
  handlers: { chat: prompt },
  views: { messages: deepseek.messages() },
});

serveIfMain(import.meta, [agent, ledger, signals]);
