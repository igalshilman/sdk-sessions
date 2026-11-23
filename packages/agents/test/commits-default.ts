// A setup file of the suite: PI_COMMITS=effects (or each) sets the default of
// pi's `commits` option, to run the pi suites in either mode. Nothing in
// src reads the environment.
import { commitsDefault } from '../src/pi/commits.ts';

const mode = process.env.PI_COMMITS;
if (mode !== undefined) {
  if (mode !== 'effects' && mode !== 'each') throw new Error(`PI_COMMITS is effects or each, not ${mode}`);
  commitsDefault.commits = mode;
}
