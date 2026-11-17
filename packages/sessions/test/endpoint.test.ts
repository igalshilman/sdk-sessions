// Every way the SDK hands out a request handler runs a session object's
// invocations on the explicit recovery VM: `endpoint.ts` wraps the class that
// `restate.endpoint()`, `restate.serve` and the tunnel behind `connect` all
// build theirs from.
//
// Over a real HTTP/2 server and client, which is what each of them has: the
// tunnel runs an `http2.createServer` of its own and hands the handler the
// request and response it makes (`tunnel/connection.js`).
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import { bytes, decode, frame, uint } from './wire.ts';
import { messages, TYPE, V8, value } from './vm-support.ts';

const probe = restate.sessionObject({
  name: 'Probe',
  handlers: {
    greet: async (_ctx: restate.SessionContext, who: string) => `hello ${who}`,
  },
});

/** A journaled object beside it: the SDK goes on serving these. */
const plain = restate.object({
  name: 'Plain',
  handlers: { ping: async (_ctx: restate.ObjectContext) => 'pong' },
});

let server: http2.Http2Server;
let client: http2.ClientHttp2Session;

beforeAll(async () => {
  server = http2.createServer(restate.endpoint().bind(probe).bind(plain).handler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterAll(async () => {
  client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * One invocation: the start and input Restate sends, then whatever it is told
 * to send next, with the request kept open — as Restate keeps it — until the
 * attempt says it is over. Answers the messages the attempt wrote.
 */
async function invoke(path: string, key: string, input: unknown) {
  const request = client.request({
    ':method': 'POST',
    ':path': path,
    'content-type': V8,
  });
  request.write(
    Buffer.from(frame(TYPE.start, [...bytes(1, [1, 2, 3, 4]), ...bytes(2, 'inv_e'), ...uint(3, 1), ...bytes(6, key)])),
  );
  request.write(Buffer.from(frame(TYPE.input, bytes(14, value(JSON.stringify(input))))));

  const chunks: Buffer[] = [];
  const status = Promise.withResolvers<number>();
  request.on('response', (headers) => status.resolve(Number(headers[':status'])));
  const done = new Promise<void>((resolve) => {
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // The attempt has said it is over: Restate closes its side, and so the
      // input pump of a handler that is done sees the end it waits for.
      if (messages(Buffer.concat(chunks)).some((m) => m.type === TYPE.end || m.type === TYPE.error)) request.end();
    });
    request.on('end', () => resolve());
    request.on('close', () => resolve());
  });
  await done;
  return { status: await status.promise, sent: messages(Buffer.concat(chunks)) };
}

/** What the handler answered, as its output message carries it. */
const answered = (sent: ReturnType<typeof messages>) => {
  const output = sent.find((m) => m.type === TYPE.output);
  expect(output, 'the attempt wrote no output').toBeDefined();
  const carried = decode(output!.fields.get(14)![0] as Uint8Array);
  return Buffer.from(carried.get(1)![0] as Uint8Array).toString();
};

describe('an endpoint the SDK built', () => {
  it('runs a session object on the explicit recovery VM', async () => {
    const { status, sent } = await invoke('/invoke/Probe/greet', 'k1', 'world');
    expect(status).toBe(200);
    expect(answered(sent)).toBe('"hello world"');
    expect(sent.at(-1)?.type).toBe(TYPE.end);
    // Only the VM's path leaves no run: the SDK's journals one for a
    // commit's sync.
    expect(sent.some((m) => m.type === 0x0411)).toBe(false);
  }, 30_000);

  it('leaves everything else to the SDK: a journaled object still answers', async () => {
    const { status, sent } = await invoke('/invoke/Plain/ping', 'k1', null);
    expect(status).toBe(200);
    expect(answered(sent)).toBe('"pong"');
  }, 30_000);

  it('runs a session object behind a prefixed deployment path', async () => {
    // The SDK matches the last three fragments, so these reach it too.
    const { status, sent } = await invoke('/behind/a/prefix/invoke/Probe/greet', 'k2', 'again');
    expect(status).toBe(200);
    expect(answered(sent)).toBe('"hello again"');
  }, 30_000);

  it('tells a Restate too old for the VM which it is, and refuses', async () => {
    // Below V7 the invocation used to go to the SDK, which ran it on the
    // selector. With that gone the SDK would refuse it for the wrong reason —
    // naming endpoint types to someone whose endpoint is fine — so this
    // answers it instead.
    const request = client.request({
      ':method': 'POST',
      ':path': '/invoke/Probe/greet',
      'content-type': 'application/vnd.restate.invocation.v6',
    });
    const status = Promise.withResolvers<number>();
    request.on('response', (head) => status.resolve(Number(head[':status'])));
    const body: Buffer[] = [];
    request.on('data', (chunk: Buffer) => body.push(chunk));
    request.end();
    await new Promise<void>((resolve) => request.on('close', () => resolve()));
    expect(await status.promise).toBe(415);
    const said = Buffer.concat(body).toString();
    expect(said).toContain('service protocol v7 or later');
    expect(said).toContain('negotiated v6');
  }, 30_000);

  it('refuses a session object on an endpoint the patch does not reach', async () => {
    // A fetch endpoint is not built from `NodeEndpoint`, so nothing routes
    // its invocations to the VM. A session object cannot run on the SDK's
    // journaled VM, so it is refused rather than half-served.
    const { createEndpointHandler } = await import('@restatedev/restate-sdk/fetch');
    const handle = createEndpointHandler({ services: [probe], bidirectional: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          frame(TYPE.start, [...bytes(1, [9, 9, 9, 9]), ...bytes(2, 'inv_fetch'), ...uint(3, 1), ...bytes(6, 'k')]),
        );
        controller.enqueue(frame(TYPE.input, bytes(14, value(JSON.stringify('world')))));
        // Nothing more will be sent: the handler is refused at once, and the
        // response ends rather than streaming.
        controller.close();
      },
    });
    const response = await handle(
      new Request('http://restate.test/invoke/Probe/greet', {
        method: 'POST',
        headers: { 'content-type': V8 },
        body,
        duplex: 'half',
      }),
    );
    const sent = messages(Buffer.from(await response.arrayBuffer()));
    // It answered, and what it answered is the refusal, not a greeting.
    const output = sent.find((m) => m.type === TYPE.output);
    expect(output, 'the attempt wrote no output').toBeDefined();
    const failure = decode(output!.fields.get(15)![0] as Uint8Array);
    expect(new TextDecoder().decode(failure.get(2)![0] as Uint8Array)).toMatch(/runs on the explicit recovery VM/);
  }, 30_000);
});
