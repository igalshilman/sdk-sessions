// LangGraph's checkpointer conformance suite on checkpointer.ts, over a
// SQL database in memory: `pnpm --filter @restatedev/agents test langgraph`.
import { validate } from '@langchain/langgraph-checkpoint-validation';
import { asDatabase, open, type Connection } from '@restatedev/sessions/internal';
import { memoryStore } from '@restatedev/sessions/test/support';
import { SqlCheckpointSaver } from '@restatedev/agents/langgraph';

let n = 0;
const databases = new WeakMap<SqlCheckpointSaver, Connection>();
validate({
  checkpointerName: '@restatedev/sessions',
  async createCheckpointer() {
    const db = await open(`langgraph-${process.pid}-${n++}`, memoryStore());
    const saver = new SqlCheckpointSaver(asDatabase(db));
    databases.set(saver, db);
    return saver;
  },
  async destroyCheckpointer(saver) {
    await databases.get(saver)?.close();
  },
});
