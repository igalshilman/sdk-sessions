// Steering: a message sent while a turn is answered joins it, at the turn's
// next step.
//
// A client sends the message to the agent's `steer` view. The companion
// queues it at once as a turn of its own (the agent's private `steered`), in
// order with the messages sent after it, and, if the turn being answered
// takes steered messages, holds it for that turn too (`steer` of
// signals.ts).
//
// The turn learns of it from its next `publish`, which it makes at each tool
// call's start and end anyway (`Inbox` of common.ts). At its next step, once
// the model's reply has a result for each of its tool calls and before the
// next model request, the framework's integration calls `takeSteers`: the
// turn stores each message once, as a message of the user that is a step of
// the turn, and the integration puts it in the request about to go out. The
// transaction that stores them tells the companion they are taken (`taken`),
// once.
//
// Once the turn ends, the queued `steered` of a message it took does
// nothing; one it did not take (it came after the turn's last step, say) is
// answered as a turn of its own. So each message is answered once.
import type * as restate from '@restatedev/sessions';
import type { Transaction } from '@restatedev/sessions';
import { inboxOf, stopSignalOf } from './common.ts';
import type { Conversation } from './conversation.ts';
import { signals, signalsOf } from './signals.ts';

/**
 * Take the messages steered to the turn being answered, at a step: store
 * each once, and return their items.
 *
 * Call it right before a model request that follows the model's reply and
 * its tools' results (or before the turn's first request): the integration
 * then puts the returned items in the request, after what it already holds;
 * one that builds each request from `conversation.history()` finds them
 * there. They are messages of the user, as the framework's `Items` makes them
 * (`steered`, or else `prompt`). It returns nothing, at no cost, unless the
 * turn runs in a `chat` handler whose framework takes steered messages, a
 * message it has not taken is waiting, the turn is not stopping, and each of
 * its tool calls has a result.
 *
 * The messages are steps of the turn from then on: a retried attempt finds
 * them stored, in `history()`, and never takes them again. They share the
 * turn's fate: stopped, refused or failed with it, they are not answered
 * again.
 */
export async function takeSteers<I>(ctx: restate.SessionContext, conversation: Conversation<I>): Promise<I[]> {
  const inbox = inboxOf(ctx);
  if (!inbox || inbox.messages.length === 0) return [];
  const stop = stopSignalOf(ctx);
  // A turn stopped while it waited to store them takes none: each is then answered as a turn of its own.
  const going = () => stop?.aborted !== true;
  const turn = conversation.running();
  if (!going() || !turn || turn.openCalls().length > 0) return [];
  return turn.steer(inbox.messages, (tx, ids) => tookSteers(ctx, tx, ids), going);
}

/**
 * Tell the companion that the turn of `ctx` took the steered messages `ids`,
 * with `tx`, the transaction that stores them: so they are marked taken once
 * stored, and once. A framework that places steered messages itself (pi,
 * DeepSeek) calls it as it copies them into the turn.
 */
export function tookSteers(ctx: restate.SessionContext, tx: Transaction, ids: string[]) {
  if (ids.length === 0) return;
  tx.send(signals, signalsOf(ctx), { idempotencyKey: `taken:${ids[0]}` }).taken(ids);
}
