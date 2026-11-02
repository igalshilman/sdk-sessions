// The bank agent on Claude (@restatedev/agents/claude): a ClaudeAgent object per conversation, whose tools
// (./bank.ts) move money in the ledger.
//
// Environment: PORT (default 9080), ANTHROPIC_API_KEY, MODEL, and ABORT_PER_MILLE (see
// ../faults.ts).
import { sessionObject, signals } from '@restatedev/agents';
import * as claude from '@restatedev/agents/claude';
import { serveIfMain } from '@restatedev/sessions/test/faults';
import { ledger } from '@restatedev/sessions/test/ledger';
import { bank } from './bank.ts';

/** Answer a message, once per invocation. */
export const prompt = claude.chat({
  system: 'You keep the books of a bank, with your tools. Answer briefly.',
  tools: bank('ClaudeAgent'),
});

export const agent = sessionObject({
  name: 'ClaudeAgent',
  handlers: { chat: prompt },
  views: { messages: claude.messages() },
});

serveIfMain(import.meta, [agent, ledger, signals]);
