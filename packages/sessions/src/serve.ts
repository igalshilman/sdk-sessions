// `serve`: the services of a program, on PORT, with what they need beside
// them (a library's objects, such as each @restatedev/agents agent's companion).
import * as restate from '@restatedev/restate-sdk';
import { isRemote } from './calls.ts';

type Service = restate.ServeOptions['services'][number];

/** Where a definition keeps the services it needs served beside it: see {@link needing}. */
const NEEDS = Symbol.for('restate-sessions.needs');

/**
 * `definition`, which needs `services` served beside it: {@link serve}
 * serves them too. For a library whose objects call one of their own (an
 * agent's companion, say).
 */
export const needing = <D extends object>(definition: D, services: () => Service[]): D =>
  Object.defineProperty(definition, NEEDS, { value: services });

/**
 * Serve `services`, with the services they need beside them, each once:
 *
 *   await restate.serve(notes, orders);
 *
 * On PORT (default 9080), for a Restate server that calls in. With
 * RESTATE_CONNECT_KEY set, it connects out to Restate Cloud instead, under
 * RESTATE_CONNECT_NAME (the deployment you register,
 * `connect://<name>`): the same program, deployed either way, with nothing
 * to change in it.
 *
 * RESTATE_SERVE_ONLY, names separated by commas (`triage,planner`), serves
 * only those of them, each with what it needs beside it: one program (or
 * image), deployed in parts.
 */
export const serve = (...services: Service[]) => {
  const plan = serving(services);
  return plan.connect === undefined
    ? restate.serve({ services: plan.services, port: plan.port })
    : restate.connect({ services: plan.services, ...plan.connect });
};

/** What {@link serve} does with `services`, by the environment: see {@link serving}. */
export interface Serving {
  /** The services it binds, each with what it needs beside it. */
  services: Service[];
  /** Set when it connects out: the deployment name to register, if the environment names one. */
  connect?: { name?: string };
  /** The port it listens on, when it does not connect out. */
  port?: number;
}

/**
 * What {@link serve} does with `services` under `env`, decided and not done:
 * which services it binds, and whether it listens or connects out. A pure
 * function, so that a program (or a tool) can ask before anything is served.
 */
export function serving(services: Service[], env: Record<string, string | undefined> = process.env): Serving {
  const bound = served(services, env.RESTATE_SERVE_ONLY);
  // Blank counts as unset, as it does in the SDK (its `readEnv` maps '' to
  // undefined): `RESTATE_CONNECT_KEY=` in a .env, or `${RESTATE_CONNECT_KEY:-}`
  // in a compose file, would otherwise connect out and fail for want of a key.
  if (!env.RESTATE_CONNECT_KEY) return { services: bound, port: Number(env.PORT ?? 9080) };
  const name = env.RESTATE_CONNECT_NAME;
  return { services: bound, connect: name ? { name } : {} };
}

/**
 * What {@link serve} serves of `services`: each with what it needs beside
 * it, once; with `names` (separated by commas), only the services it names,
 * each with what it needs beside it. For an endpoint of your own:
 *
 *   const endpoint = restate.endpoint();
 *   for (const service of restate.served([notes, orders])) endpoint.bind(service);
 */
export function served(services: Service[], names?: string): Service[] {
  // A handle names what another deployment serves. Binding one would register a
  // service with no handlers, over the real one: the collision, from inside.
  const handles = services.filter(isRemote).map((s) => s.name);
  if (handles.length > 0) {
    throw new Error(
      `${handles.join(', ')}: a remote handle names what another deployment serves, so it cannot be served here`,
    );
  }
  const all = withNeeds(services);
  const wanted = (names ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (wanted.length === 0) return all;
  const known = all.map((s) => s.name);
  const unknown = wanted.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new Error(`RESTATE_SERVE_ONLY names ${unknown.join(', ')}: the services are ${known.join(', ')}`);
  }
  return withNeeds(all.filter((s) => wanted.includes(s.name)));
}

/** `services`, each with what it needs beside it, once. */
function withNeeds(services: Service[]): Service[] {
  const all = new Map<string, Service>();
  const add = (service: Service) => {
    if (all.has(service.name)) return;
    all.set(service.name, service);
    for (const needed of (service as { [NEEDS]?: () => Service[] })[NEEDS]?.() ?? []) add(needed);
  };
  services.forEach(add);
  return [...all.values()];
}
