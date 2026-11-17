// Every invocation of a session object runs on the explicit recovery VM
// (`handler.ts`), whichever way its deployment is served.
//
// The SDK builds its own VM per invocation, and the dispatch that does it is
// module-private: there is no supported seam. What every transport does share
// is one class — `restate.endpoint()` returns a `NodeEndpoint`, and the tunnel
// behind `connect` builds `new NodeEndpoint()` of its own — and the request
// handler it hands out. So this wraps that class's four ways of producing one.
//
// It is a patch on another package's prototype, which is worth naming plainly.
// It touches four methods whose contract is "give me a request handler", and
// the handler it returns is the SDK's own for everything but a session
// object. The alternative it replaced was larger: reaching into five private
// fields of the SDK's promise executor to drive its VM by hand.
import * as http2 from 'node:http2';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as restate from '@restatedev/restate-sdk';
import { MIN_PROTOCOL, servedHere, serveSession, type Stream } from './handler.ts';
import { isSessionObject } from './object.ts';
import { Identity, type VmHeader } from './vm.ts';

/** Marks the prototype this package has already wrapped. */
const PATCHED = Symbol.for('restate-sessions.endpoint-patched') as unknown as string;

/** What this package needs of the SDK's endpoint, which its types do not say. */
interface Endpoint {
  builder: {
    serviceDefinitions: Map<string, object>;
    keySet: string[];
    journalValueCodecProvider?: unknown;
  };
  handler(options?: { bidirectional?: boolean }): (request: never, response: never) => void;
  http2Handler(options?: { bidirectional?: boolean }): (request: never, response: never) => void;
  http1Handler(options?: { bidirectional?: boolean }): (request: never, response: never) => void;
  listen(port?: number): Promise<number>;
}

/** The session objects bound to `endpoint`, by name. */
function sessionsOf(endpoint: Endpoint): Map<string, { name: string }> {
  const bound = new Map<string, { name: string }>();
  for (const [name, definition] of endpoint.builder.serviceDefinitions) {
    if (isSessionObject(definition)) bound.set(name, definition as { name: string });
  }
  return bound;
}

/**
 * What an endpoint with session objects cannot also have. Each would need a
 * second way of running an attempt, and there is none any more.
 */
function refuseWhatTheVmCannotServe(endpoint: Endpoint, sessions: Map<string, unknown>): void {
  if (sessions.size === 0) return;
  if (endpoint.builder.journalValueCodecProvider !== undefined) {
    throw new Error(
      '@restatedev/sessions: a journal value codec is not supported for session objects: ' +
        'their attempts are never replayed, and nothing of theirs is journaled to encode',
    );
  }
}

/** The request's headers, as the verifier takes them. */
function headersOf(headers: Readonly<Record<string, string | string[] | undefined>>): VmHeader[] {
  return Object.entries(headers).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value: Array.isArray(value) ? (value[0] ?? '') : value }],
  );
}

/** One invocation over HTTP/2, as {@link Stream}. */
function streamOf(request: Http2ServerRequest, response: Http2ServerResponse): Stream {
  return {
    headers: request.headers,
    body: request,
    writeHead: (status, headers) => void response.writeHead(status, headers),
    write: (chunk) => void response.write(chunk),
    close: () => void response.end(),
  };
}

/**
 * The path of `url` and the route it names, as the SDK reads it: the last
 * three fragments. Nothing if it names no invocation, or is no path at all —
 * `//` is a URL with an empty host, which `URL` refuses. Restate sends none
 * of those, but anything that reaches the port can, and this runs in the
 * request listener, where a throw is an `uncaughtException`.
 */
function parse(url: string): { path: string; service: string; handler: string } | undefined {
  let path;
  try {
    path = new URL(url, 'http://invoke').pathname;
  } catch {
    return undefined;
  }
  const parts = path.split('/');
  if (parts.length < 3 || parts[parts.length - 3] !== 'invoke') return undefined;
  const service = parts[parts.length - 2]!;
  const handler = parts[parts.length - 1]!;
  return service === '' || handler === '' ? undefined : { path, service, handler };
}

/** The route of an invocation's path, as the SDK reads it. */
export function invokeRoute(url: string): { service: string; handler: string } | undefined {
  const route = parse(url);
  return route === undefined ? undefined : { service: route.service, handler: route.handler };
}

/**
 * `sdk`, with a session object's invocations run on the VM instead. A request
 * that is not one — discovery, the health check, a library's journaled objects
 * — is the SDK's, unchanged.
 */
function routing(
  endpoint: Endpoint,
  sdk: (request: never, response: never) => void,
  bidirectional: (request: { httpVersionMajor?: number }) => boolean,
): (request: Http2ServerRequest | IncomingMessage, response: Http2ServerResponse | ServerResponse) => void {
  const sessions = sessionsOf(endpoint);
  refuseWhatTheVmCannotServe(endpoint, sessions);
  // The SDK verifies a request's signature in the handler this routes ahead
  // of, so an invocation that goes to the VM is verified here instead. Every
  // `connect` has keys: its key carries the signing key, and the SDK refuses
  // one that does not.
  const identity = endpoint.builder.keySet.length > 0 ? new Identity(endpoint.builder.keySet) : undefined;
  return (request, response) => {
    const route = sessions.size === 0 ? undefined : parse(request.url ?? '');
    const definition = route === undefined ? undefined : sessions.get(route.service);
    if (definition === undefined || route === undefined) {
      sdk(request as never, response as never);
      return;
    }
    const { path } = route;
    // `null` is a verified request, as the addon answers `None` with: a
    // deployment without keys verifies nothing, and stands for the same.
    const unsigned = identity === undefined ? null : identity.verify(path, headersOf(request.headers));
    if (unsigned !== null) {
      // What the SDK answers, and the handler never runs.
      (response as Http2ServerResponse).writeHead(401, { 'content-type': 'text/plain' });
      response.end('Unauthorized');
      return;
    }
    // After the signature check, so that an unsigned request learns nothing
    // about what is bound here: the SDK answers one 401 for anything.
    if (!servedHere(request.headers)) {
      // A session object on a Restate too old for the VM. Handing it to the
      // SDK would run it on a VM that replays, which such a handler cannot
      // use; it would be refused there for the wrong reason, naming endpoint
      // types to someone whose endpoint is fine. Say which it is.
      const type = request.headers['content-type'];
      const spoken = /\.invocation\.(v\d+)/.exec((Array.isArray(type) ? type[0] : type) ?? '')?.[1] ?? 'none';
      (response as Http2ServerResponse).writeHead(415, { 'content-type': 'text/plain' });
      response.end(
        `@restatedev/sessions: ${route.service}/${route.handler} is a session object, which runs on the ` +
          `explicit recovery VM and needs Restate's service protocol v${MIN_PROTOCOL} or later; this ` +
          `invocation negotiated ${spoken}. Upgrade the Restate server.`,
      );
      return;
    }
    serveSession(definition, route.handler, streamOf(request as Http2ServerRequest, response as Http2ServerResponse), {
      bidirectional: bidirectional(request),
    }).catch((error: unknown) => {
      // The attempt could not be served at all: the VM wrote nothing.
      if (!response.headersSent) (response as Http2ServerResponse).writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  };
}

/**
 * Wrap the SDK's endpoint class, once per process, so that every request
 * handler it hands out routes a session object's invocations to the VM.
 * Called by {@link sessionObject}: the package declares `sideEffects: false`,
 * so this cannot be the work of an import.
 */
export function patchEndpoint(): void {
  const prototype = Object.getPrototypeOf(restate.endpoint()) as Record<string, unknown>;
  if (prototype[PATCHED] === true) return;
  const missing = (['handler', 'http2Handler', 'http1Handler', 'listen'] as const).filter(
    (method) => typeof prototype[method] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `@restatedev/sessions runs a session object's invocations by wrapping the SDK's endpoint, which this SDK ` +
        `version does not have (${missing.join(', ')}): use the @restatedev/restate-sdk that @restatedev/sessions pins`,
    );
  }

  // The SDK's own defaults: HTTP/2 is bidirectional unless told otherwise,
  // HTTP/1.1 only when asked.
  const wrap = (
    method: 'handler' | 'http2Handler' | 'http1Handler',
    mode: (set: boolean | undefined, request: { httpVersionMajor?: number }) => boolean,
  ) => {
    const original = prototype[method] as Endpoint['handler'];
    prototype[method] = function (this: Endpoint, options?: { bidirectional?: boolean }) {
      const sdk = original.call(this, options);
      return routing(this, sdk, (request) => mode(options?.bidirectional, request)) as never;
    };
  };
  // `handler` dispatches per request, so the rule is the one for that
  // request's protocol; a handler built for one protocol knows it already.
  wrap('handler', (set, request) => ((request.httpVersionMajor ?? 2) >= 2 ? set !== false : set === true));
  wrap('http2Handler', (set) => set !== false);
  wrap('http1Handler', (set) => set === true);

  // `listen` builds its server from the module's own handler, not from
  // `http2Handler`, so wrapping it is building the server here.
  prototype.listen = function (this: Endpoint, port?: number): Promise<number> {
    const chosen = port ?? Number(process.env.PORT ?? 9080);
    const server = http2.createServer(this.http2Handler() as never);
    return new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(chosen, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') reject(new TypeError('listen binds to a port'));
        else resolve(address.port);
      });
    });
  };
  prototype[PATCHED] = true;
}
