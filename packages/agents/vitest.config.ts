import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// LangGraph's checkpointer suite (storage/langgraph.test.ts) uses the
// test globals. The LangGraph agent's model is the teller (test/fakes/langgraph.ts),
// in place of @langchain/openai where it resolves: a `vi.mock` of it gives
// some of the agent's imports at once (the crash test's attempts) the real one.
export default defineConfig({
  test: {
    globals: true,
    alias: { '@langchain/openai': fileURLToPath(new URL('./test/fakes/langgraph.ts', import.meta.url)) },
  },
});
