// A parallel step cut while one of its nodes still runs: a node that finished
// has its writes stored, whatever the checkpointer groups with a checkpoint, so
// that after a crash it does not run again (and repeat its effects). The crash
// is a copy of the store's bytes, taken while the other node runs: what is
// durable then, from which a new saver and graph resume.
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { asDatabase, open } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { memoryStore } from '@restatedev/sessions/test/support';
import { SqlCheckpointSaver } from '@restatedev/agents/langgraph';

/** How many times each node ran. */
interface Ran {
  x: number;
  y: number;
  join: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const saverOf = (db: ReturnType<typeof asDatabase>) => new SqlCheckpointSaver(db);

/** The control: a saver that holds each putWrites until the next put (and resolves it at once). */
class HoldsWrites extends SqlCheckpointSaver {
  held: Array<() => Promise<void>> = [];
  override putWrites(...args: Parameters<SqlCheckpointSaver['putWrites']>) {
    this.held.push(() => super.putWrites(...args));
    return Promise.resolve();
  }
  override async put(...args: Parameters<SqlCheckpointSaver['put']>) {
    for (const write of this.held.splice(0)) await write();
    return super.put(...args);
  }
}
const State = Annotation.Root({
  par: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
const thread = { configurable: { thread_id: 't' }, durability: 'sync' as const };
let n = 0;

/** A graph START -> {x, y} -> join, whose Y waits on `gate` in its first attempt; `ran` counts each node's runs. */
function parallel(saver: SqlCheckpointSaver, ran: Ran, gate?: Promise<void>, fail = false) {
  return new StateGraph(State)
    .addNode('x', async () => {
      ran.x++;
      await sleep(5);
      return { par: ['x'] };
    })
    .addNode('y', async () => {
      ran.y++;
      if (gate) await gate;
      if (fail) throw new Error('y failed');
      return { par: ['y'] };
    })
    .addNode('join', async () => {
      ran.join++;
      return {};
    })
    .addEdge(START, 'x')
    .addEdge(START, 'y')
    .addEdge('x', 'join')
    .addEdge('y', 'join')
    .addEdge('join', END)
    .compile({ checkpointer: saver });
}

const crash = async (make: (db: ReturnType<typeof asDatabase>) => SqlCheckpointSaver) => {
  const map = new Map<string, Uint8Array>();
  const db = asDatabase(await open(`par-${process.pid}-${n++}`, memoryStore(map)));
  const ran = { x: 0, y: 0, join: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = parallel(make(db), ran, gate, true);
  const attempt = first.invoke({}, thread).catch((e: Error) => e);
  // X is done; Y waits. Give any write several macrotasks, then take what is durable.
  while (ran.x === 0 || ran.y === 0) await sleep(1);
  await sleep(100);
  const image = new Map(map);
  release();
  expect(((await attempt) as Error).message).toBe('y failed');

  // The resume, in a fresh process: from the image only.
  const db2 = asDatabase(await open(`par-${process.pid}-${n++}`, memoryStore(image)));
  const resumed = parallel(make(db2), ran);
  const out = await resumed.invoke(null, thread);
  return { ran, par: out.par.toSorted() };
};

describe('a parallel step cut while one node still runs', () => {
  it('does not run the finished node again after a crash (the durable bytes at that moment)', async () => {
    const { ran, par } = await crash(saverOf);
    expect(ran).toEqual({ x: 1, y: 2, join: 1 });
    expect(par).toEqual(['x', 'y']);
  });

  it('a saver that holds every putWrites until the next put makes it run again: the test tells them apart', async () => {
    const { ran } = await crash((db) => new HoldsWrites(db));
    expect(ran.x).toBe(2);
  });

  it('does not run the finished node again after the attempt fails (the same database)', async () => {
    const db = asDatabase(await open(`par-${process.pid}-${n++}`, memoryStore()));
    const ran = { x: 0, y: 0, join: 0 };
    const failing = parallel(saverOf(db), ran, sleep(50), true);
    await expect(failing.invoke({}, thread)).rejects.toThrow('y failed');
    const out = await parallel(saverOf(db), ran).invoke(null, thread);
    expect(ran).toEqual({ x: 1, y: 2, join: 1 });
    expect(out.par.toSorted()).toEqual(['x', 'y']);
  });
});
