// Runs the scenarios of `hand-over-scenarios.ts` in this process, for `hand-over.test.ts`, which sets the environment.
import { closedWhilePending, scenarios } from './hand-over-scenarios.ts';

const transcript = await scenarios();
const closed = await closedWhilePending();
process.stdout.write(JSON.stringify({ transcript, closed }));
