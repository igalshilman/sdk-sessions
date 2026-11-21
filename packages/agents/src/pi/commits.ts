// The default of the pi option `commits` (index.ts), in one place: the tests
// of the whole suite set it (test/commits-default.ts) to run the pi suites in
// both modes.
import type { Commits } from './storage.ts';

/** What `commits` is when an agent does not say. */
export const commitsDefault: { commits: Commits } = { commits: 'each' };
