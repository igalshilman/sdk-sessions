// For tests: an attempt's session over a context of their own, the store's
// fault injection, and a database over a store of their own. For this
// repository's libraries: the schemas their tables are in,
// databases of their own, and the Restate SDK as @restatedev/sessions runs it (its
// own copy, so that a library's journaled handlers serve beside its objects).
export * as sdk from '@restatedev/restate-sdk';
export { ensureSchemas, Schema } from './schema.ts';
export {
  asDatabase,
  lazyDatabase,
  database,
  reset,
  deferSql,
  undeferSql,
  rideCommit,
  flushRiders,
  Attempt,
  withAttempt,
} from './session.ts';
export type { ObjectConfig, SqlHost } from './session.ts';
export { Link } from './link.ts';
export { ScopeKey } from './scope.ts';
export { open, type Connection, type Store, type ConnectionTransaction, type Working } from './database.ts';
// The attempt on the explicit recovery VM, for the tests that drive one.
export { AttemptDriver, AttemptFailed, AttemptShutDown } from './driver.ts';
export { Vm, isShutDown } from './vm.ts';
export { serveSession, servedHere, type Stream } from './handler.ts';
export { needing, served } from './serve.ts';
export { invokeRoute, patchEndpoint } from './endpoint.ts';
export {
  attach,
  cancelCalls,
  cancelled,
  configOf,
  contextOf,
  definitionOf,
  HEAD_KEY,
  invoke,
  start,
  withStoreWrapper,
  type AttemptContext,
} from './object.ts';
