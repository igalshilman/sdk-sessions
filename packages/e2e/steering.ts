// Steering against a real Restate server: a message sent to an agent's
// `steer` view while a turn runs, on pi agents with a scripted model whose
// tool waits for a signal, so that the message comes while the tool runs.
//
// Checks: the turn being answered takes the message as its round of tool
// calls ends, after their results, and answers it, with the message stored
// once in its turn, and its own queued `steered` doing nothing; a request
// sent again with its idempotency key is the same message; an agent whose
// turns take no steered messages answers it as a turn of its own, after the
// turn and before a message sent after it; with no turn running, it starts
// one; a turn stopped before its step leaves the message to be answered as a
// turn of its own.
//
//   pnpm --filter e2e steering   (RESTATE_SERVER=/path/to/restate-server to use another)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as restate from '@restatedev/restate-sdk';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  CANCELLED,
  chatHandler,
  sessionObject,
  signal,
  signals,
  type Messages,
  type Status,
  type Waiting,
} from '@restatedev/agents';
import type { Steered } from '@restatedev/agents/client';
import * as pi from '@restatedev/agents/pi';
import { z } from 'zod';
import { callTools, fakeProvider, say, textOf } from '@restatedev/agents/test/fakes/pi';
import { RESTATE_SERVER as SERVER } from './restate-server.ts';

const INGRESS = 'http://127.0.0.1:8080';
const ADMIN = 'http://127.0.0.1:9070';
const PORT = 9302;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The model: asked to plan, it waits for an approval; then it says what it
// planned with, and with the message steered after the approval's result, if
// any. Anything else it answers as it is (pi gives the message after a
// stopped turn with how that turn ended).
const models = createModels();
models.setProvider(
  fakeProvider('script', 'script', ({ messages }) => {
    const last = messages.at(-1)!;
    const before = messages.at(-2);
    if (last.role === 'toolResult') return say(`Planned with ${textOf(last.content)}`);
    const text = textOf(last.content);
    // After an approval's result: a message steered to the turn (a stopped turn's aborted call is no approval).
    if (before?.role === 'toolResult' && !before.isError) {
      return say(`Planned with ${textOf(before.content)}, and: ${text}`);
    }
    if (text.startsWith('Plan')) return callTools([['wait_for_approval', {}]]);
    return say(`Answered: ${text}`);
  }),
);
const options = {
  model: 'script/script',
  models,
  tools: [signal('approval', { description: 'Wait for a manager', input: z.object({}) })],
};

/** A pi agent, whose turns take steered messages at their steps. */
const planner = pi.agent({ name: 'planner', ...options });

/** An agent whose `chat` takes no steered messages: each is a turn of its own. */
const plain = sessionObject({
  name: 'plain',
  handlers: { chat: chatHandler((ctx, text) => pi.prompt(ctx, text, options)) },
  views: { messages: pi.messages() },
});

const lines = (messages: Messages['messages']) =>
  messages.map((m) => [m.role, ...m.parts.map((p) => (p.type === 'text' ? p.text : `${p.name}: ${p.output}`))]);

const dir = mkdtempSync(join(tmpdir(), 'restate-steering-'));
const server = spawn(SERVER, ['--base-dir', dir], {
  env: { ...process.env, RESTATE_BIND_IP: '127.0.0.1', RESTATE_LISTEN_MODE: 'tcp' },
  stdio: 'ignore',
});
try {
  await restate.serve({ services: [planner, plain, signals], port: PORT });
  for (
    let i = 0;
    !(await fetch(`${ADMIN}/health`).then(
      (r) => r.ok,
      () => false,
    ));
    i++
  ) {
    if (i > 300) throw new Error('restate-server did not start');
    await sleep(100);
  }
  const registered = await fetch(`${ADMIN}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: `http://127.0.0.1:${PORT}` }),
  });
  assert.ok(registered.ok, await registered.text());

  const post = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${INGRESS}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? null),
    });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}`);
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
  /** The answer of invocation `id`, once it ends. */
  const attach = async (id: string) => (await fetch(`${INGRESS}/restate/invocation/${id}/attach`)).json();
  /** The wait of `object` (such as `planner/alice`), once there is one. */
  const waiting = async (object: string) => {
    for (let i = 0; ; i++) {
      const [wait] = (await post(`${object}/pending`)) as Waiting[];
      if (wait) return wait;
      if (i > 300) throw new Error(`${object} does not wait for the approval`);
      await sleep(100);
    }
  };
  /** The conversation of `object`, once it has `count` messages. */
  const said = async (object: string, count: number) => {
    for (let i = 0; ; i++) {
      const { messages } = (await post(`${object}/messages`)) as Messages;
      if (messages.length >= count) return lines(messages);
      if (i > 300) throw new Error(`${object} has ${messages.length} messages: ${JSON.stringify(lines(messages))}`);
      await sleep(100);
    }
  };
  const steer = (object: string, text: string, key: string) =>
    post(`${object}/steer`, text, { 'idempotency-key': key }) as Promise<Steered>;

  // Taken at the next step: the turn's round ends with the approval, and the
  // message joins the turn after its result.
  const plan = (await post('planner/alice/chat/send', 'Plan my week')) as { invocationId: string };
  const wait = await waiting('planner/alice');
  const steered = await steer('planner/alice', 'Skip Friday', 'steer-alice-1');
  assert.equal(steered.turn, plan.invocationId);
  // Sent again with its key: the same message.
  assert.deepEqual(await steer('planner/alice', 'Skip Friday', 'steer-alice-1'), steered);
  const status = (await post('planner/alice/status')) as Status;
  assert.deepEqual(
    status.steering?.map((m) => m.id),
    [steered.id],
  );
  await post('planner/alice/signal', { id: wait.id, value: 'approved' });
  assert.equal(await attach(plan.invocationId), 'Planned with approved, and: Skip Friday');
  // The next message is answered after the message's own `steered`, which finds it taken, and does nothing.
  assert.equal(await post('planner/alice/chat', 'Thanks'), 'Answered: Thanks');
  assert.deepEqual(await said('planner/alice', 6), [
    ['user', 'Plan my week'],
    ['assistant', 'wait_for_approval: approved'],
    ['user', 'Skip Friday'],
    ['assistant', 'Planned with approved, and: Skip Friday'],
    ['user', 'Thanks'],
    ['assistant', 'Answered: Thanks'],
  ]);
  assert.deepEqual(await post('planner/alice/status'), { answering: null, waiting: [] });

  // An agent whose turns take none: the message is a turn of its own, after
  // the turn, and before a message sent after it.
  const planned = (await post('plain/bob/chat/send', 'Plan my week')) as { invocationId: string };
  const bobs = await waiting('plain/bob');
  assert.deepEqual((await steer('plain/bob', 'Skip Friday', 'steer-bob-1')).turn, null);
  const next = (await post('plain/bob/chat/send', 'And next week?')) as { invocationId: string };
  await post('plain/bob/signal', { id: bobs.id, value: 'approved' });
  assert.equal(await attach(planned.invocationId), 'Planned with approved');
  assert.equal(await attach(next.invocationId), 'Answered: And next week?');
  assert.deepEqual(await said('plain/bob', 7), [
    ['user', 'Plan my week'],
    ['assistant', 'wait_for_approval: approved'],
    ['assistant', 'Planned with approved'],
    ['user', 'Skip Friday'],
    ['assistant', 'Answered: Skip Friday'],
    ['user', 'And next week?'],
    ['assistant', 'Answered: And next week?'],
  ]);

  // No turn running: the message starts one.
  assert.deepEqual((await steer('planner/carol', 'Hello', 'steer-carol-1')).turn, null);
  assert.deepEqual(await said('planner/carol', 2), [
    ['user', 'Hello'],
    ['assistant', 'Answered: Hello'],
  ]);

  // Stopped before its step: the turn did not take the message, which is
  // answered as a turn of its own.
  const stopped = (await post('planner/dave/chat/send', 'Plan my week')) as { invocationId: string };
  await waiting('planner/dave');
  assert.equal((await steer('planner/dave', 'Skip Friday', 'steer-dave-1')).turn, stopped.invocationId);
  assert.deepEqual(await post('planner/dave/stop'), { stopped: stopped.invocationId });
  assert.deepEqual(await said('planner/dave', 5), [
    ['user', 'Plan my week'],
    ['assistant', `wait_for_approval: ${CANCELLED}`],
    ['assistant', CANCELLED],
    ['user', 'Skip Friday'],
    ['assistant', `Answered: (${CANCELLED})\n\nSkip Friday`],
  ]);
  console.log('ok');
} finally {
  server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
