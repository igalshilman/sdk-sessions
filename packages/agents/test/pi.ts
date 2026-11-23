// The bank agent on pi (@restatedev/agents/pi): an Agent object per session.
//
// Its tools move money in the ledger (../../sessions/test/ledger.ts), with the tool call
// id as the transfer id (prefixed with the agent's key: the ledger is shared,
// and a model's call ids need not be unique beyond its session), so a tool
// call run again after a crash moves the money once. Each call to the ledger has an idempotency key made from the
// request id (`ctx.request().id`, the same on every attempt) and the tool
// call id, so a retried attempt reaches the call the first one made.
//
// Environment: PORT (default 9080), MODEL with its provider's API key,
// and ABORT_PER_MILLE (see ../faults.ts).
import type * as restate from '@restatedev/sessions';
import { sessionObject } from '@restatedev/agents';
import { int, obj } from '@earendil-works/pi-schema';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { serveIfMain } from '@restatedev/sessions/test/faults';
import { ledger } from '@restatedev/sessions/test/ledger';
import * as pi from '@restatedev/agents/pi';
import { commitsDefault } from '../src/pi/commits.ts';

/** The bank tools of an invocation: they reach the ledger through `ctx`. */
const transfer = (ctx: restate.SessionContext) =>
  defineTool({
    name: 'transfer',
    description: 'Move an amount of money from one account to another.',
    parameters: obj({
      from: int({ description: 'Account to take the money from' }),
      to: int({ description: 'Account to put the money in' }),
      amount: int({ minimum: 1 }),
    }),
    replay: 'safe', // runs again after a crash, with the same call id
    execute: async ({ from, to, amount }, api) => {
      // One key per tool call: an invocation makes many.
      const idempotencyKey = `${ctx.request.id}:${api.callId}`;
      const applied = await ctx
        .rpc(ledger, 'bank', { idempotencyKey })
        .transfer({ id: `Agent/${ctx.key}/${api.callId}`, from, to, amount }); // unique in the ledger
      return {
        output: [
          { type: 'text', text: `moved ${applied.amount} from account ${applied.from} to account ${applied.to}` },
        ],
      };
    },
  });

const audit = (ctx: restate.SessionContext) =>
  defineTool({
    name: 'audit',
    description: 'Check the books: accounts, total money, transfers, and inconsistent accounts.',
    parameters: obj({}),
    replay: 'safe',
    execute: async (_params, api) => {
      const idempotencyKey = `${ctx.request.id}:${api.callId}`;
      const books = await ctx.rpc(ledger, 'bank', { idempotencyKey }).audit();
      return { output: [{ type: 'text', text: JSON.stringify(books) }] };
    },
  });

/** The bank tools of an invocation. */
export const tools = (ctx: restate.SessionContext): [ToolRegistration, ToolRegistration] => [transfer(ctx), audit(ctx)];

/** Answer a message, once per invocation. */
// PI_COMMITS=effects serves it with batched commits (the tests against a Restate server, ../../e2e).
const chosen = process.env.PI_COMMITS === 'effects' ? 'effects' : undefined;
/** The mode the agent runs in, which the tests against a server log once as they serve it (../../e2e/serve.ts). */
export const commits = chosen ?? commitsDefault.commits;
export const prompt = pi.chat((ctx) => ({ tools: tools(ctx), commits: chosen }));

export const agent = sessionObject({ name: 'Agent', handlers: { chat: prompt }, views: { messages: pi.messages() } });

serveIfMain(import.meta, [agent, ledger]);
