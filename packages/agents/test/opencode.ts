// The bank agent on OpenCode 2.0 (@restatedev/agents/opencode): an OpenCodeAgent object per session, whose tools
// (./bank.ts) move money in the ledger.
//
// Environment: PORT (default 9080), OPENAI_API_KEY, MODEL, and ABORT_PER_MILLE (see
// ../faults.ts).
import { sessionObject, signals } from '@restatedev/agents';
import * as opencode from '@restatedev/agents/opencode';
import { serveIfMain } from '@restatedev/sessions/test/faults';
import { ledger } from '@restatedev/sessions/test/ledger';
import { bank } from './bank.ts';

/** Answer a message, once per invocation. */
export const prompt = opencode.chat({ tools: bank('OpenCodeAgent') });

export const agent = sessionObject({
  name: 'OpenCodeAgent',
  handlers: { chat: prompt },
  views: { messages: opencode.messages() },
});

serveIfMain(import.meta, [agent, ledger, signals]);
