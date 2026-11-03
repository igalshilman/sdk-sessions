// A bank with one Account object per account, each with its own SQL database:
// a transfer debits one key and credits another, so it spans two databases
// and can be cut by a crash between them. Two ways of reaching the other key,
// both exactly once:
// - `tx.send`: the credit is a send of the transaction that debits, made once
//   it commits and only then.
// - A keyed `ctx.send` after the debit commits, made on every attempt: a rerun
//   that finds the debit done still sends, and the idempotency key, or else
//   the credit's own record of the transfer id, makes the repeat a no-op.
//
// The view `slowStatement` reads, waits (a call to the journaled `BankClock`),
// and reads again, in one snapshot: commits and checkpoints of its key
// meanwhile change neither read, and a view that outlives the checkpoints
// its snapshot needs fails with "is gone" and is retried.
//
// Idempotency keys are kept 2 seconds (`idempotencyRetention`), so a resend
// after that is a new invocation: the transfer's id, recorded on both keys,
// is what makes it a no-op then. A transfer with `failAfterCommit` throws a
// TerminalError once its debit committed: the debit stays, and so does its
// credit.
//
// Environment: PORT (default 9080) and ABORT_PER_MILLE (see faults.ts).
import * as restate from '@restatedev/sessions';
import { serveIfMain } from './faults.ts';

/** A transfer of `amount` to the account `to`, by its unique `id`. */
export interface Move {
  id: string;
  to: string;
  amount: number;
  /** How the credit reaches `to`: with the debit's transaction, or after it. */
  via: 'tx.send' | 'ctx.send';
  /** Throw a TerminalError once the debit committed. */
  failAfterCommit?: boolean;
}

/** What an account holds: its balance, and the transfers on each side of it. */
export interface Statement {
  balance: number;
  debits: { id: string; peer: string; amount: number }[];
  credits: { id: string; peer: string; amount: number }[];
}

/** A journaled service that waits: what a view awaits to outlive its key's commits. */
export const clock = restate.service({
  name: 'BankClock',
  handlers: {
    wait: async (ctx: restate.Context, ms: number) => ctx.sleep(ms),
  },
});

const statement = async (db: restate.DatabaseReader): Promise<Statement> => ({
  balance: (await db.get<{ amount: number }>('SELECT amount FROM balance'))?.amount ?? 0,
  debits: await db.query('SELECT id, peer, amount FROM debits ORDER BY id'),
  credits: await db.query('SELECT id, peer, amount FROM credits ORDER BY id'),
});

export const account = restate.sessionObject({
  name: 'Account',
  schema: [
    'CREATE TABLE balance (id INTEGER PRIMARY KEY CHECK (id = 0), opening INTEGER NOT NULL, amount INTEGER NOT NULL)',
    'CREATE TABLE debits (id TEXT PRIMARY KEY, peer TEXT NOT NULL, amount INTEGER NOT NULL)',
    'CREATE TABLE credits (id TEXT PRIMARY KEY, peer TEXT NOT NULL, amount INTEGER NOT NULL)',
  ],
  handlers: {
    /** Open the account with `amount`, once. */
    open: async (ctx, amount: number) => {
      await ctx.db.execute('INSERT OR IGNORE INTO balance VALUES (0, ?, ?)', [amount, amount]);
    },

    /**
     * Move `amount` to `to`, once per transfer `id`: 'moved' (now or by an
     * earlier attempt or request), or 'refused' without the money.
     */
    transfer: async (ctx, move: Move): Promise<'moved' | 'refused'> => {
      if (move.to === ctx.key) throw new restate.TerminalError(`transfer ${move.id}: to the same account`);
      const outcome = await ctx.db.transaction(async (tx) => {
        if (await tx.get('SELECT 1 FROM debits WHERE id = ?', [move.id])) return 'moved' as const;
        const { amount } = (await tx.get<{ amount: number }>('SELECT amount FROM balance'))!;
        if (amount < move.amount) return 'refused' as const;
        await tx.execute('UPDATE balance SET amount = amount - ?', [move.amount]);
        await tx.execute('INSERT INTO debits VALUES (?, ?, ?)', [move.id, move.to, move.amount]);
        if (move.via === 'tx.send')
          tx.send(account, move.to).credit({ id: move.id, from: ctx.key, amount: move.amount });
        return 'moved' as const;
      });
      // Not inside the early return: a rerun after the commit sends again,
      // and the key (or the credit's record of the id) drops the repeat.
      if (outcome === 'moved' && move.via === 'ctx.send') {
        ctx
          .send(account, move.to, { idempotencyKey: `${move.id}:credit` })
          .credit({ id: move.id, from: ctx.key, amount: move.amount });
      }
      if (move.failAfterCommit) throw new restate.TerminalError(`transfer ${move.id}: failed after its commit`);
      return outcome;
    },

    /** Receive a transfer, once per `id`. */
    credit: (ctx, { id, from, amount }: { id: string; from: string; amount: number }) =>
      ctx.db.transaction(async (tx) => {
        if (await tx.get('SELECT 1 FROM credits WHERE id = ?', [id])) return;
        await tx.execute('INSERT INTO credits VALUES (?, ?, ?)', [id, from, amount]);
        await tx.execute('UPDATE balance SET amount = amount + ?', [amount]);
      }),
  },
  views: {
    statement: async (ctx) => statement(ctx.db),
    /** The statement read twice, `ms` apart: the same both times. */
    slowStatement: async (ctx, ms: number): Promise<[Statement, Statement]> => {
      const before = await statement(ctx.db);
      await ctx.rpc(clock, { idempotencyKey: `${ctx.request.id}:wait` }).wait(ms);
      return [before, await statement(ctx.db)];
    },
  },
  options: {
    // Retried soon and without end, as the ledger's (see shop.ts).
    retryPolicy: { initialInterval: 50, maxInterval: 500, maxAttempts: 100_000 },
    idempotencyRetention: { seconds: 2 },
  },
});

serveIfMain(import.meta, [account, clock]);
