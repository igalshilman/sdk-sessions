// The bank agent on LangGraph (@restatedev/agents/langgraph): a GraphAgent object per conversation, whose tools
// (./bank.ts) move money in the ledger.
//
// Environment: PORT (default 9080), OPENAI_API_KEY, MODEL, and ABORT_PER_MILLE (see
// ../faults.ts).
import { sessionObject, signals } from '@restatedev/agents';
import * as langgraph from '@restatedev/agents/langgraph';
import { serveIfMain } from '@restatedev/sessions/test/faults';
import { ledger } from '@restatedev/sessions/test/ledger';
import { bank } from './bank.ts';

/** Answer a message, once per invocation. */
export const prompt = langgraph.chat({ tools: bank('GraphAgent') });

export const agent = sessionObject({
  name: 'GraphAgent',
  handlers: { chat: prompt },
  views: { messages: langgraph.messages() },
});

serveIfMain(import.meta, [agent, ledger, signals]);
