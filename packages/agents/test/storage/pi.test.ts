// pi-durable's storage conformance suite on @restatedev/agents/pi/storage, over an SQL
// database in memory: `pnpm --filter @restatedev/agents test pi`.
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { asDatabase, open } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { memoryStore } from '@restatedev/sessions/test/support';
import { openSqlKvStorage } from '@restatedev/agents/pi/storage';

let n = 0;
registerStorageConformance({ describe, expect, it }, '@restatedev/sessions', async (use) => {
  const db = await open(`conformance-${process.pid}-${n++}`, memoryStore());
  try {
    await use(await openSqlKvStorage(asDatabase(db)));
  } finally {
    await db.close();
  }
});
