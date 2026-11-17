// A deployment that verifies request signatures, which every `connect` is:
// its key carries the signing key, and the SDK refuses a key that does not.
//
// The SDK verifies inside the handler that @restatedev/sessions routes a
// session object's invocation ahead of, so the verification has to happen
// there too, or it would not happen at all. That is what shared-core's own
// verifier does here: see `sessions/native/src/vm.rs` and
// `sessions/src/endpoint.ts`.
//
// Signing here as Restate signs, with a key made for the run, checks the two
// halves that matter: a signed invocation runs, and an unsigned one does not.
// Refusing is the half that passes for the wrong reason — it is answered
// before any signature is read — so a run that only refuses proves nothing.
//
// Not a vitest test: under vitest the request never answers, while under plain
// node it does, and the behaviour being checked is the deployment's.
//
//   pnpm --filter e2e identity
import * as crypto from 'node:crypto';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import * as restate from '@restatedev/sessions';
import { bytes, decode, frame, uint } from '@restatedev/sessions/test/wire';
import { messages, TYPE, V8, value } from '@restatedev/sessions/test/vm-support';

/** base58, as a `publickeyv1_` key is encoded: a leading zero byte is a `1`. */
function base58(input: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of input) n = n * 256n + BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = ALPHABET[Number(n % 58n)]! + out;
  for (const b of input) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const base64url = (input: Uint8Array | string) => Buffer.from(input).toString('base64url');

/** A signing key, and the `publickeyv1_…` key a deployment accepts it by. */
function identityKey(): { sign: (jwt: string) => Buffer; key: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // `x` of the JWK is the raw 32 bytes, which is what the key encodes.
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return {
    sign: (signed: string) => crypto.sign(null, Buffer.from(signed), privateKey),
    key: `publickeyv1_${base58(raw)}`,
  };
}

const signer = identityKey();

/** A JWT over `audience`, as Restate signs the path it invokes. */
function jwt(audience: string, { expired = false }: { expired?: boolean } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ aud: audience, iat: now - 1, nbf: now - 1, exp: expired ? now - 1 : now + 300 }),
  );
  return `${header}.${claims}.${base64url(signer.sign(`${header}.${claims}`))}`;
}

/** The headers Restate sends with a signed request. */
const signature = (audience: string, options?: { expired?: boolean }) => ({
  'x-restate-signature-scheme': 'v1',
  'x-restate-jwt-v1': jwt(audience, options),
});

let ran = 0;
const watched = restate.sessionObject({
  name: 'Watched',
  handlers: {
    touch: async (_ctx: restate.SessionContext, who: string) => {
      ran += 1;
      return `touched ${who}`;
    },
  },
});
/** Beside it, served by the SDK: these still need their signatures checked too. */
const plain = restate.object({
  name: 'Plain',
  handlers: { ping: async (_ctx: restate.ObjectContext) => 'pong' },
});

const server = http2.createServer(restate.endpoint().withIdentityV1(signer.key).bind(watched).bind(plain).handler());
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

/**
 * Whether the attempt has said it is over, reading only the frame headers of
 * `output` — a type and a length each — and stopping at the first frame the
 * stream has not finished delivering.
 */
function over(output: Buffer): boolean {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  for (let at = 0; at + 8 <= output.length;) {
    const type = view.getUint16(at);
    if (type === TYPE.end || type === TYPE.error) return true;
    at += 8 + view.getUint32(at + 4);
  }
  return false;
}

/**
 * One invocation of `path`, with `headers` on top of the request's own: the
 * start and input Restate sends, with the request kept open until the attempt
 * says it is over, as `endpoint.test.ts` drives one.
 */
async function invoke(path: string, headers: Record<string, string>, input: unknown) {
  const request = client.request({ ':method': 'POST', ':path': path, 'content-type': V8, ...headers });
  request.write(
    Buffer.from(frame(TYPE.start, [...bytes(1, [1, 2, 3, 4]), ...bytes(2, 'inv_id'), ...uint(3, 1), ...bytes(6, 'k')])),
  );
  request.write(Buffer.from(frame(TYPE.input, bytes(14, value(JSON.stringify(input))))));

  const chunks: Buffer[] = [];
  const status = Promise.withResolvers<number>();
  request.on('response', (head) => {
    const code = Number(head[':status']);
    // A refusal sends plain text and no end frame, so nothing below would
    // ever close the request: its head is the whole answer.
    if (code !== 200) request.end();
    status.resolve(code);
  });
  await new Promise<void>((resolve) => {
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // Only the headers of the whole frames so far: a chunk can cut a frame
      // in two, and decoding half of one is reading rubbish.
      if (over(Buffer.concat(chunks))) request.end();
    });
    request.on('end', () => resolve());
    request.on('close', () => resolve());
  });
  // A refusal answers in plain text, not in frames: there is nothing to read.
  const code = await status.promise;
  return { status: code, sent: code === 200 ? messages(Buffer.concat(chunks)) : [] };
}

/** What the handler answered, as its output message carries it. */
function answered(sent: Awaited<ReturnType<typeof invoke>>['sent']): unknown {
  const output = sent.find((m) => m.type === TYPE.output);
  if (output === undefined) return undefined;
  const carried = decode(output.fields.get(14)![0] as Uint8Array);
  const content = carried.get(1)?.[0] as Uint8Array | undefined;
  return content === undefined ? undefined : JSON.parse(Buffer.from(content).toString());
}

const failures: string[] = [];
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(what);
};

// A signed invocation runs. This is the half that fails if the path handed to
// the verifier is not the one Restate signed, or the crypto provider is absent.
{
  const was = ran;
  const { status, sent } = await invoke('/invoke/Watched/touch', signature('/invoke/Watched/touch'), 'once');
  check('a signed invocation of a session object is served', status === 200, `status ${status}`);
  check('its handler ran', ran === was + 1);
  check('and it answered', answered(sent) === 'touched once', `answered ${JSON.stringify(answered(sent))}`);
}

// Restate signs the path it invokes, which carries the deployment's prefix
// when it was registered under one; the verifier normalises it away.
{
  const was = ran;
  const { status } = await invoke('/pfx/invoke/Watched/touch', signature('/invoke/Watched/touch'), 'prefixed');
  check('a signed invocation under a deployment prefix is served', status === 200, `status ${status}`);
  check('its handler ran too', ran === was + 1);
}

// And the refusals: each has to leave the handler alone.
for (const [what, path, headers] of [
  ['unsigned', '/invoke/Watched/touch', {}],
  ['signed for another handler', '/invoke/Watched/touch', signature('/invoke/Watched/other')],
  ['signed by an expired token', '/invoke/Watched/touch', signature('/invoke/Watched/touch', { expired: true })],
] as const) {
  const was = ran;
  const { status } = await invoke(path, headers, 'no');
  check(`an invocation ${what} is refused`, status === 401, `status ${status}`);
  check(`and ${what}, the handler never ran`, ran === was);
}

// The SDK goes on verifying what it serves itself: this package hands a
// journaled object's invocation straight to it, signature and all.
{
  const refused = await invoke('/invoke/Plain/ping', {}, 'no');
  check(
    'an unsigned invocation of a journaled object is refused too',
    refused.status === 401,
    `status ${refused.status}`,
  );
}

client.close();
server.close();
console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} FAILED: ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
