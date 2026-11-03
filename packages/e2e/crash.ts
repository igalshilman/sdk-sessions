// The examples against a real Restate server, through crashes: the services
// abort at random state requests, and the server is killed twice, while
// clients place, pay and expire orders, move money between accounts (a key
// each, some transfers cancelled), read views of all of them, and prompt
// agents. The ledger, the shop and the bank run in two processes behind one
// deployment (ABORT_PER_MILLE, default 15): a proxy hands each connection
// Restate opens to the next of them, and cuts them every few seconds, so a
// key's invocations move between two warm page caches, one of them small
// (1 MiB of memory, 8 MiB of disk). Each kind of agent runs in its own: the pi, LangGraph and DeepSeek Harness agents
// (AGENT_ABORT_PER_MILLE, default 3: a pi or DeepSeek Harness prompt makes
// some hundreds of state requests), the Claude agents (ABORT_PER_MILLE), and
// the OpenCode agents (OPENCODE_ABORT_PER_MILLE, default 1: an OpenCode prompt
// makes some hundreds of state requests too, and its process takes seconds to
// start).
// The agents get the same prompts. Each request is resent until answered,
// some twice.
//
// The agents' models are the scripted tellers (@restatedev/agents/test/fakes/fakes.ts), which need
// no API key: "move 5 from 1 to 2" makes a transfer.
//
// Checks: the warehouses' books balance and agree with every order; every
// transfer between accounts is on both of its keys or on neither, and the
// money adds up; every view read along the way saw a committed state (books
// that balance, order statuses that only move forward, a slow view's two
// reads alike); and every agent prompt moved money exactly once.
//
// Every random choice comes from one seed, printed at the start: ABORT_SEED=n
// runs with the same abort points (counted in each process's state requests)
// and the same server kills, though timing still varies the requests.
//
// A soak: SOAK_MINUTES=n runs the shop and the bank in rounds until n
// minutes passed, killing the server every KILL_EVERY_MINUTES (default 4),
// and checks every service process's memory (RSS) stays under SOAK_RSS_MB (default
// 1536). CRASH_ORDERS, CRASH_MOVES (per round) and CRASH_ACCOUNTS (default
// 60, 120 and 12) set how many keys a run touches.
//
//   pnpm --filter e2e crash   (RESTATE_SERVER=/path/to/restate-server to use another)
//   ABORT_SEED=1234 pnpm --filter e2e crash   (again, as a failed run printed it)
//   SOAK_MINUTES=60 CRASH_ORDERS=500 CRASH_ACCOUNTS=200 pnpm --filter e2e crash
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import type { Messages } from '@restatedev/agents';
import type { Move, Statement } from '@restatedev/sessions/test/bank';
import type { Audit } from '@restatedev/sessions/test/ledger';
import type { Order, Reservation } from '@restatedev/sessions/test/shop';
import { seeded, seedFromEnv } from '@restatedev/sessions/test/random';
import { RESTATE_SERVER as SERVER } from './restate-server.ts';

const INGRESS = 'http://127.0.0.1:8080';
const ADMIN = 'http://127.0.0.1:9070';
const PER_MILLE = Number(process.env.ABORT_PER_MILLE ?? 15);
const AGENT_PER_MILLE = Number(process.env.AGENT_ABORT_PER_MILLE ?? 3);
const OPENCODE_PER_MILLE = Number(process.env.OPENCODE_ABORT_PER_MILLE ?? 1);
/**
 * A service process: its name, the groups of serve.ts it serves, its port
 * and abort rate; the port of the proxy in front of it, if any; and its
 * environment beyond the run's.
 */
interface Process {
  name: string;
  groups: string[];
  port: number;
  perMille: number;
  behind?: number;
  env?: Record<string, string>;
}
const SHOP = ['ledger', 'shop', 'bank'];
const SHOP_PROXY = 9182;
const PROCESSES: Process[] = [
  { name: 'shop', groups: SHOP, port: 9180, perMille: PER_MILLE, behind: SHOP_PROXY },
  {
    name: 'shop-small',
    groups: SHOP,
    port: 9181,
    perMille: PER_MILLE,
    behind: SHOP_PROXY,
    env: { RESTATE_SQL_CACHE_MEMORY: '1MiB', RESTATE_SQL_CACHE_DISK: '8MiB' },
  },
  { name: 'agent', groups: ['agent'], port: 9183, perMille: AGENT_PER_MILLE },
  { name: 'langgraph', groups: ['langgraph'], port: 9186, perMille: AGENT_PER_MILLE },
  // A Claude prompt makes few state requests: it aborts as often as the shop.
  { name: 'claude', groups: ['claude'], port: 9187, perMille: PER_MILLE },
  { name: 'deepseek', groups: ['deepseek'], port: 9188, perMille: AGENT_PER_MILLE },
  { name: 'opencode', groups: ['opencode'], port: 9189, perMille: OPENCODE_PER_MILLE },
];
// The agents: the pi one, the LangGraph one, the Claude one, the DeepSeek
// Harness one and the OpenCode one, with the same prompts.
const AGENTS = ['Agent', 'GraphAgent', 'ClaudeAgent', 'DeepSeekAgent', 'OpenCodeAgent'];
const FAKES = fileURLToPath(import.meta.resolve('@restatedev/agents/test/fakes/fakes'));
const EXPIRY_MS = 1500;
const SKUS = ['apple', 'pear', 'plum'];
const STOCK = 20;
const ORDERS = Number(process.env.CRASH_ORDERS ?? 60); // per round
const SESSIONS = 4;
const PROMPTS = 8;
const ACCOUNTS = 8;
const OPENING = 1000;
// The bank: an Account object per key, and transfers between them.
const BANK_ACCOUNTS = Number(process.env.CRASH_ACCOUNTS ?? 12);
const MOVES = Number(process.env.CRASH_MOVES ?? 120); // per round
const RETENTION_MS = 2000; // the Account's idempotencyRetention (bank.ts)
// How often the proxy cuts the shop processes' connections.
const ROTATE_MS = 3000;
// A soak: rounds of the shop and the bank until SOAK_MINUTES passed.
const SOAK_MS = Number(process.env.SOAK_MINUTES ?? 0) * 60_000;
const KILL_EVERY_MS = Number(process.env.KILL_EVERY_MINUTES ?? 4) * 60_000;
const SOAK_RSS_MB = Number(process.env.SOAK_RSS_MB ?? 1536);

const SEED = seedFromEnv();
console.error(`seed ${SEED} (ABORT_SEED=${SEED} runs it again)`);
process.on('exit', (code) => {
  if (code !== 0) console.error(`failed with seed ${SEED}: ABORT_SEED=${SEED} pnpm --filter e2e crash`);
});

const dir = mkdtempSync(join(tmpdir(), 'restate-sessions-examples-'));
// One descriptor per log, however often its process restarts.
const logs = new Map<string, number>();
const log = (name: string) => logs.get(name) ?? logs.set(name, openSync(join(dir, name), 'a')).get(name)!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Wait until `done()`, which other tasks make true. */
const until = async (done: () => boolean) => {
  while (!done()) await sleep(20);
};
console.error(`logs in ${dir}`);

const startServer = () =>
  spawn(SERVER, ['--base-dir', join(dir, 'server')], {
    env: { ...process.env, RESTATE_BIND_IP: '127.0.0.1', RESTATE_LISTEN_MODE: 'tcp' },
    stdio: ['ignore', log('server.log'), log('server.log')],
  });

async function healthy() {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(200)) {
    if (
      await fetch(`${ADMIN}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
  }
  throw new Error('restate-server did not start');
}

/** A supervised process: how many times it started, and its current child. */
interface Supervised {
  starts: number;
  stopped: boolean;
  child: ChildProcess;
  stop(): Promise<void>;
}

/** Whether something listens on `port`. */
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

/**
 * Keep `process` running, restarting it whenever it aborts. An abort (of
 * faults.ts) is a SIGKILL; any other exit is a failure, such as a port taken
 * at startup, restarted after a pause, and ending the run if it repeats.
 */
function supervise({ name, groups, port, env }: Process, perMille: number): Supervised {
  let failures = 0;
  // The process's own random numbers, from the run's seed and its place in
  // PROCESSES: the order in which processes restart changes nothing it draws.
  const random = seeded(SEED + 1 + PROCESSES.findIndex((p) => p.name === name));
  // The first start aborts early, at a random request: every process aborts
  // at least once, however few requests its random aborts come to.
  const run = (first = false) => {
    // Each start of each process its own seed, from the run's.
    const seed = Math.floor(random() * 2 ** 32);
    return spawn(
      process.execPath,
      ['--import', FAKES, fileURLToPath(new URL('serve.ts', import.meta.url)), ...groups],
      {
        env: {
          ...process.env,
          // pi's and OpenCode's model: the teller (the others' are faked by name).
          ...(['agent', 'opencode'].includes(name) ? { MODEL: 'teller/teller' } : {}),
          PORT: String(port),
          ABORT_PER_MILLE: String(perMille),
          ABORT_SEED: String(seed),
          ...(first && perMille > 0 ? { ABORT_AT: String(20 + Math.floor(random() * 180)) } : {}),
          SHOP_EXPIRY_MS: String(EXPIRY_MS),
          RESTATE_SQL_CACHE_FILE: join(dir, `${name}.cache`),
          ...env,
        },
        stdio: ['ignore', 'ignore', log(`${name}.log`)],
      },
    );
  };
  const restart = () => {
    if (state.stopped) return;
    state.starts++;
    state.child = run();
    state.child.on('exit', exited);
  };
  const exited = (code: number | null, signal: NodeJS.Signals | null) => {
    if (state.stopped) return;
    if (signal === 'SIGKILL') {
      failures = 0;
      return restart();
    }
    if (++failures >= 5) {
      console.error(`${name} exited (${signal ?? code}) ${failures} times in a row; see ${join(dir, `${name}.log`)}`);
      process.exit(1);
    }
    setTimeout(restart, 500);
  };
  const state: Supervised = {
    starts: 1,
    stopped: false,
    child: run(true),
    stop: () =>
      new Promise((resolve) => {
        state.stopped = true;
        state.child.removeAllListeners('exit');
        state.child.on('exit', () => resolve());
        state.child.kill();
      }),
  };
  state.child.on('exit', exited);
  return state;
}

/** POST until answered with 200, through crashes of either side. */
async function call<T = unknown>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    let response;
    try {
      response = await fetch(`${INGRESS}/${path}`, {
        method: 'POST',
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      response = null;
    }
    if (response?.ok) {
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    if (response && response.status !== 404) {
      const text = await response.text();
      // A failed invocation, unlike an unavailable server, is final.
      if (response.status < 500 || text.includes('"source":"invocation"')) {
        throw new Error(`${path}: ${response.status} ${text}`);
      }
    }
    if (Date.now() > deadline) throw new Error(`${path}: no answer`);
    await sleep(100);
  }
}

/** Run `tasks` (functions) with at most `width` at a time. */
async function pool(width: number, tasks: (() => Promise<void>)[]) {
  const queue = [...tasks];
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let task = queue.shift(); task; task = queue.shift()) await task();
    }),
  );
}

/**
 * A TCP proxy on `port` that hands each connection to the next of
 * `backends` in turn, and cuts every connection each `rotateMs`: Restate
 * opens new ones, so the backends take turns. A backend that is down (as a
 * process restarts) fails the connection, and Restate retries.
 */
function rotate(port: number, backends: number[], rotateMs: number) {
  const open = new Set<Socket>();
  const served = backends.map(() => 0);
  let next = 0;
  const proxy = createServer((client) => {
    const at = next++ % backends.length;
    const upstream = connect(backends[at]!, '127.0.0.1', () => served[at]!++); // reached: it counts
    open.add(client);
    const close = () => {
      open.delete(client);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) socket.on('error', close).on('close', close);
    client.pipe(upstream).pipe(client);
  }).listen(port, '127.0.0.1');
  const cuts = setInterval(() => open.forEach((c) => c.destroy()), rotateMs);
  return {
    served,
    close: () => {
      clearInterval(cuts);
      proxy.close();
      open.forEach((c) => c.destroy());
    },
  };
}

/** A process's resident memory in MiB, where /proc tells. */
function rssMb(pid: number | undefined): number | undefined {
  if (pid === undefined || !existsSync(`/proc/${pid}/status`)) return undefined;
  const kb = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  return kb === undefined ? undefined : Number(kb) / 1024;
}

// A server left running (by a run that was killed) would serve this run its
// state, and services left running would take the ports and run old code:
// refuse to start against them.
if (
  await fetch(`${ADMIN}/health`).then(
    () => true,
    () => false,
  )
) {
  throw new Error(`a Restate server already listens at ${ADMIN}; stop it first`);
}
for (const { name, port } of [...PROCESSES, { name: 'shop proxy', port: SHOP_PROXY }]) {
  if (await listening(port))
    throw new Error(`port ${port} (${name}) is taken (by a run that was killed?): stop it first`);
}
let server = startServer();
const proxy = rotate(
  SHOP_PROXY,
  PROCESSES.filter((p) => p.behind === SHOP_PROXY).map((p) => p.port),
  ROTATE_MS,
);
let services = PROCESSES.map((p) => supervise(p, p.perMille));
// The most memory each process used, sampled every few seconds.
const rss = new Map<string, number>();
const memory = () => JSON.stringify(Object.fromEntries([...rss].map(([name, mb]) => [name, Math.round(mb)])));
const sampling = setInterval(() => {
  PROCESSES.forEach((p, i) => {
    const mb = rssMb(services[i]?.child.pid);
    if (mb !== undefined) rss.set(p.name, Math.max(rss.get(p.name) ?? 0, mb));
  });
}, 2000);
// On failure, or when interrupted or terminated, leave nothing running.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(1));
process.on('exit', () => {
  for (const service of services) {
    service.stopped = true;
    service.child.kill('SIGKILL');
  }
  server.kill('SIGKILL');
});
await healthy();
for (const port of new Set(PROCESSES.map((p) => p.behind ?? p.port))) {
  for (const deadline = Date.now() + 60_000; ; await sleep(200)) {
    const registered = await fetch(`${ADMIN}/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: `http://127.0.0.1:${port}`, force: true }),
    }).then(
      (r) => r.ok,
      () => false,
    );
    if (registered) break;
    if (Date.now() > deadline) throw new Error('registration failed');
  }
}

await call('Ledger/bank/init', [ACCOUNTS, OPENING]);

let progress = 0;
const total = ORDERS * 2 + MOVES + AGENTS.length * SESSIONS * (PROMPTS + 1);
const step = () => {
  if (++progress % 25 === 0) console.error(`${progress}/${total} requests answered`);
};

// The shop and the bank run in rounds: one, or as many as SOAK_MINUTES lasts.
// Order and transfer `n` are the same in every run, whichever round makes them.
let rounds = 0;
const working = new AbortController(); // aborted once the work is done

// Orders: each round restocks, places each order (some twice), then pays the
// even ones (which may have expired first).
const paid = new Map<string, string>();
const order = (n: number) => ({ id: `o${n}`, sku: SKUS[n % SKUS.length]!, qty: 1 + (n % 3) });
async function shopRound(round: number) {
  for (const sku of SKUS) {
    await call(`Warehouse/${sku}/restock`, { id: `round ${round}`, qty: STOCK });
    await call(`Warehouse/${sku}/restock`, { id: `round ${round}`, qty: STOCK }); // a resend
  }
  await pool(
    6,
    Array.from({ length: ORDERS }, (_, i) => async () => {
      const { id, sku, qty } = order(round * ORDERS + i);
      for (let n = 0; n < (i % 4 === 0 ? 2 : 1); n++) await call(`Orders/${id}/place`, { sku, qty });
      step();
      if (i % 2 === 0) paid.set(id, await call<string>(`Orders/${id}/pay`));
      step();
    }),
  );
}

// The bank: transfers between accounts, a key each. Some are sent twice at
// once, some again after the idempotency key expired (a new invocation,
// which the transfer id makes a no-op), some fail after their commit, and
// some are cancelled (only ones whose credit is a send of the debit's
// transaction: a cancellation can stop a handler anywhere).
const accountKey = (a: number) => `a${a}`;
const amountOf = (ts: { amount: number }[]) => ts.reduce((n, t) => n + t.amount, 0);
const move = (n: number): Move & { from: string; cancel: boolean } => {
  const from = n % BANK_ACCOUNTS;
  const to = (from + 1 + ((n * 5) % (BANK_ACCOUNTS - 1))) % BANK_ACCOUNTS;
  return {
    id: `t${n}`,
    from: accountKey(from),
    to: accountKey(to),
    amount: 1 + (n % 7),
    via: n % 2 === 0 ? 'tx.send' : 'ctx.send',
    failAfterCommit: n % 20 === 7,
    cancel: n % 10 === 6,
  };
};
for (let a = 0; a < BANK_ACCOUNTS; a++) await call(`Account/${accountKey(a)}/open`, OPENING);
const moved = new Map<string, string>();
/** Send transfer `m` with its idempotency key: its answer, or the terminal error it fails with. */
const transfer = async ({ from, ...m }: ReturnType<typeof move>) => {
  try {
    return await call<string>(`Account/${from}/transfer`, m, { 'idempotency-key': m.id });
  } catch (e) {
    if (m.failAfterCommit && /failed after its commit/.test((e as Error).message)) return 'failed after commit';
    throw e;
  }
};
/** The status of the invocation `id` as Restate has it, or undefined once it is gone. */
const invocationStatus = async (id: string) => {
  const r = await fetch(`${ADMIN}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: `SELECT status FROM sys_invocation WHERE id = '${id}'` }),
  }).catch(() => null);
  if (!r?.ok) return null; // the server is away
  return ((await r.json()) as { rows: { status: string }[] }).rows[0]?.status;
};
// What state the cancellations found their transfers in: only one `running`
// can interrupt a handler; the rest are of the inbox, or too late.
const cancelledWhile: Record<string, number> = {};
/** Send transfer `m`, cancel it soon after, and wait until it ended, however. */
const cancelled = async ({ from, ...m }: ReturnType<typeof move>) => {
  const { invocationId } = await call<{ invocationId: string }>(`Account/${from}/transfer/send`, m, {
    'idempotency-key': m.id,
  });
  await sleep(m.amount * 5);
  const found = (await invocationStatus(invocationId)) ?? 'gone';
  cancelledWhile[found] = (cancelledWhile[found] ?? 0) + 1;
  for (;;) {
    const r = await fetch(`${ADMIN}/invocations/${invocationId}/cancel`, { method: 'PATCH' }).catch(() => null);
    if (r && r.status < 500) break;
    await sleep(100);
  }
  // Ended once Restate no longer runs it: completed, or already gone (the
  // Account keeps finished invocations only as long as its idempotency keys).
  for (;;) {
    const status = await invocationStatus(invocationId);
    if (status === undefined || status === 'completed') return 'cancelled';
    await sleep(100);
  }
};
async function bankRound(round: number) {
  await pool(
    8,
    Array.from({ length: MOVES }, (_, i) => async () => {
      const m = move(round * MOVES + i);
      if (m.cancel) {
        moved.set(m.id, await cancelled(m));
        return step();
      }
      const answers = await Promise.all(Array.from({ length: i % 5 === 0 ? 2 : 1 }, () => transfer(m)));
      if (i % 10 === 3) {
        await sleep(RETENTION_MS + 1000);
        answers.push(await transfer(m)); // past the retention: a new invocation
      }
      assert.equal(new Set(answers).size, 1, `${m.id}: ${answers.join(', ')}`);
      moved.set(m.id, answers[0]!);
      step();
    }),
  );
}

const soakUntil = Date.now() + SOAK_MS;
const work = (async () => {
  do {
    await Promise.all([shopRound(rounds), bankRound(rounds)]);
    rounds++;
    if (SOAK_MS > 0) console.error(`round ${rounds} done; memory, most (MiB): ${memory()}`);
  } while (Date.now() < soakUntil);
})();

// Views, read all along: each read is one committed state.
const RANK: Record<string, number> = { reserved: 1, rejected: 2, paid: 2, expired: 2 };
const viewReads = { reports: 0, statuses: 0, slow: 0 };
const views = (async () => {
  const random = seeded(SEED); // which orders to read
  const last = new Map<string, string>();
  for (let n = 0; !working.signal.aborted; n++) {
    for (const sku of SKUS) {
      const { available, restocked, reservations } = await call<{
        available: number;
        restocked: number;
        reservations: Reservation[];
      }>(`Warehouse/${sku}/report`);
      const out = reservations
        .filter(([, , state]) => state === 'held' || state === 'sold')
        .reduce((sum, [, qty]) => sum + qty, 0);
      assert.equal(available + out, restocked, `${sku}, read ${n}: available ${available}, out ${out}`);
      viewReads.reports++;
    }
    for (let k = 0; k < 6; k++) {
      const { id } = order(Math.floor(random() * (rounds + 1) * ORDERS));
      const status = (await call<Order | null>(`Orders/${id}/status`))?.status;
      const before = last.get(id);
      if (before && status) {
        assert.ok((RANK[status] ?? 0) >= (RANK[before] ?? 0), `${id}: ${before}, then ${status}`);
        if (RANK[before] === 2) assert.equal(status, before, `${id}: ${before}, then ${status}`);
      }
      if (status) last.set(id, status);
      viewReads.statuses++;
    }
    if (n % 5 === 0) {
      // A view that waits between its reads, while the key commits.
      const key = accountKey(n % BANK_ACCOUNTS);
      const [first, second] = await call<[Statement, Statement]>(`Account/${key}/slowStatement`, 1500);
      assert.deepEqual(second, first, `${key}: a view's two reads`);
      assert.equal(
        first.balance,
        OPENING - amountOf(first.debits) + amountOf(first.credits),
        `${key}: a view's balance`,
      );
      viewReads.slow++;
    }
  }
})();

// Agents: transfers, then an audit, per session of each agent.
/** Session `s`'s prompt `p`: a transfer. */
function promptText(s: number, p: number) {
  const from = (s + p) % ACCOUNTS;
  const to = (s + 3 * p + 1) % ACCOUNTS;
  return `Please move ${1 + p} from ${from} to ${to === from ? (to + 1) % ACCOUNTS : to}`;
}
const sessions = AGENTS.flatMap((name) => Array.from({ length: SESSIONS }, (_, s) => [name, s] as const));
const agents = pool(
  sessions.length,
  sessions.map(([name, s]) => async () => {
    for (let p = 0; p < PROMPTS; p++) {
      const id = `s${s}-p${p}`;
      const text = promptText(s, p);
      // Sent again, by its idempotency key: the same invocation, and answer.
      for (let n = 0; n < (p % 3 === 0 ? 2 : 1); n++) {
        const answer = await call<string>(`${name}/s${s}/chat`, text, { 'idempotency-key': id });
        assert.match(answer, /^Done: moved/, `${name} ${id}: ${answer}`);
      }
      step();
    }
    const answer = await call<string>(`${name}/s${s}/chat`, 'audit the books', { 'idempotency-key': `s${s}-audit` });
    assert.match(answer, /"inconsistent":0/, answer);
    step();
  }),
);

/** Kill the server, and wait until it is back. */
async function killServer(why: string) {
  console.error(`killing the server ${why}`);
  const exited = new Promise((r) => server.on('exit', r));
  server.kill('SIGKILL');
  await exited;
  server = startServer();
  await healthy();
}
// Kill the server twice along the way, or in a soak every KILL_EVERY_MINUTES.
const kills = (async () => {
  if (SOAK_MS === 0) {
    for (const at of [total / 3, (2 * total) / 3]) {
      await until(() => progress >= at);
      await killServer(`after ${progress} requests`);
    }
    return;
  }
  for (let at = Date.now() + KILL_EVERY_MS; at < soakUntil; at += KILL_EVERY_MS) {
    await until(() => Date.now() >= at);
    await killServer(`after ${Math.round((at - soakUntil + SOAK_MS) / 60_000)} minutes`);
  }
})();
await Promise.all([work, agents, kills]);
working.abort();
await views;
clearInterval(sampling);
const starts = services.map((s) => s.starts);
await Promise.all(services.map((s) => s.stop()));
services = PROCESSES.map((p) => supervise(p, 0));

// Each agent's conversation has each prompt once, in order, however often
// its attempts crashed and its messages were sent again.
for (const [name, s] of sessions) {
  // A page at a time, from the latest back.
  const said: Messages['messages'] = [];
  for (let page: Messages | undefined; !page || page.more;) {
    page = await call<Messages>(`${name}/s${s}/messages`, { limit: 20, before: said[0]?.id });
    said.unshift(...page.messages);
  }
  const asked = said.filter((m) => m.role === 'user').map((m) => (m.parts[0] as { text: string }).text);
  assert.deepEqual(
    asked,
    [...Array.from({ length: PROMPTS }, (_, p) => promptText(s, p)), 'audit the books'],
    `${name}/s${s}`,
  );
}

// Unpaid orders expire.
const allOrders = Array.from({ length: rounds * ORDERS }, (_, n) => order(n));
const statuses = new Map<string, Order>();
for (const deadline = Date.now() + 120_000; ; await sleep(500)) {
  for (const { id } of allOrders) statuses.set(id, await call<Order>(`Orders/${id}/status`));
  if (![...statuses.values()].some((o) => o.status === 'reserved')) break;
  if (Date.now() > deadline) throw new Error('orders did not expire');
}
const expected: Record<string, string> = { paid: 'sold', expired: 'released', rejected: 'rejected' };
const counts: Record<string, number> = {};
for (const sku of SKUS) {
  const { available, restocked, reservations } = await call<{
    available: number;
    restocked: number;
    reservations: Reservation[];
  }>(`Warehouse/${sku}/report`);
  assert.equal(restocked, STOCK * rounds, sku);
  const sold = reservations.filter(([, , state]) => state === 'sold').reduce((sum, [, qty]) => sum + qty, 0);
  assert.equal(available + sold, restocked, `${sku}: available ${available}, sold ${sold}`);
  const mine = allOrders.filter((o) => o.sku === sku);
  assert.equal(reservations.length, mine.length, `${sku}: one reservation per order`);
  for (const [id, qty, state] of reservations) {
    const o = statuses.get(id)!;
    assert.equal(expected[o.status], state, `${id}: ${o.status} but ${state}`);
    assert.equal(o.qty, qty, id);
    counts[o.status] = (counts[o.status] ?? 0) + 1;
  }
}
for (const [id, answer] of paid) {
  if (answer === 'paid') assert.equal(statuses.get(id)?.status, 'paid', `${id} was paid`);
}

const audit = await call<Audit>('Ledger/bank/audit');
if (audit.transfers !== AGENTS.length * SESSIONS * PROMPTS) {
  // Which sessions moved money more often than they were asked to.
  const ids = await call<string[]>('Ledger/bank/transfers');
  const bySession = Map.groupBy(ids, (id) => id.split('/').slice(0, 2).join('/'));
  for (const [session, made] of bySession) {
    if (made.length !== PROMPTS) console.error(`${session}: ${made.length} transfers: ${made.join(', ')}`);
  }
}
assert.deepEqual(audit, {
  accounts: ACCOUNTS,
  total: ACCOUNTS * OPENING,
  transfers: AGENTS.length * SESSIONS * PROMPTS, // exactly one per prompt
  inconsistent: 0,
});

// The bank: once the credits in flight arrive, every transfer is on both of
// its keys or neither, and the money adds up.
const statements = new Map<string, Statement>();
for (const deadline = Date.now() + 120_000; ; await sleep(500)) {
  for (let a = 0; a < BANK_ACCOUNTS; a++) {
    statements.set(accountKey(a), await call<Statement>(`Account/${accountKey(a)}/statement`));
  }
  const all = [...statements.values()];
  if (all.flatMap((s) => s.debits).length === all.flatMap((s) => s.credits).length) break;
  if (Date.now() > deadline) throw new Error('credits did not arrive');
}
const debits = new Map<string, string>();
const credits = new Map<string, string>();
let money = 0;
for (const [key, { balance, debits: out, credits: into }] of statements) {
  assert.equal(balance, OPENING - amountOf(out) + amountOf(into), `${key}: its balance agrees with its transfers`);
  for (const t of out) debits.set(t.id, `${key}>${t.peer}:${t.amount}`);
  for (const t of into) credits.set(t.id, `${t.peer}>${key}:${t.amount}`);
  money += balance;
}
assert.equal(money, BANK_ACCOUNTS * OPENING, 'the bank neither made nor lost money');
const sorted = (m: Map<string, string>) => [...m].toSorted(([a], [b]) => a.localeCompare(b));
assert.deepEqual(sorted(credits), sorted(debits), 'each transfer on both keys or neither');
for (let n = 0; n < rounds * MOVES; n++) {
  const m = move(n);
  const answer = moved.get(m.id);
  const done = debits.get(m.id);
  if (answer === 'cancelled') continue; // moved or not: on both keys or neither, as checked above
  if (answer === 'refused') assert.equal(done, undefined, `${m.id} was refused`);
  else assert.equal(done, `${m.from}>${m.to}:${m.amount}`, `${m.id} (${answer}) moved once`);
}
const bankCounts = Map.groupBy(moved.values(), (a) => a);
console.error(`bank: ${[...bankCounts].map(([a, n]) => `${n.length} ${a}`).join(', ')}`);

// Retried attempts reached the invocations their first attempt started: one
// reserve and one ledger transfer per order and prompt, though attempts of
// Orders/place and Agent/chat ran many times.
const invocations = async (service: string, handler: string): Promise<number> => {
  const response = await fetch(`${ADMIN}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: `SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = '${service}' AND target_handler_name = '${handler}'`,
    }),
  });
  const { rows } = (await response.json()) as { rows: { n: number }[] };
  return rows[0]!.n;
};
assert.equal(await invocations('Warehouse', 'reserve'), rounds * ORDERS, 'reserve invocations');
assert.equal(await invocations('Ledger', 'transfer'), AGENTS.length * SESSIONS * PROMPTS, 'transfer invocations');

console.error(`rounds: ${rounds}; orders: ${JSON.stringify(counts)}`);
console.error(`views read: ${JSON.stringify(viewReads)}`);
console.error(`cancellations found their transfer: ${JSON.stringify(cancelledWhile)}`);
console.error(`shop processes served ${proxy.served.join(' and ')} connections`);
console.error(`memory, most (MiB): ${memory()}`);
proxy.served.forEach((n, i) => assert.ok(n > 1, `shop process ${i} took ${n} connections`));
if (SOAK_MS > 0) {
  for (const [name, mb] of rss) assert.ok(mb < SOAK_RSS_MB, `${name} used ${Math.round(mb)} MiB`);
}
console.error(`ledger: ${JSON.stringify(audit)}`);
PROCESSES.forEach((p, i) => console.error(`${p.name} process started ${starts[i]} times`));
PROCESSES.forEach((p, i) => assert.ok(p.perMille === 0 || (starts[i] ?? 0) > 1, `no abort happened in ${p.name}`));

await Promise.all(services.map((s) => s.stop()));
proxy.close();
server.kill('SIGKILL');
rmSync(dir, { recursive: true, force: true });
console.error('ok');
