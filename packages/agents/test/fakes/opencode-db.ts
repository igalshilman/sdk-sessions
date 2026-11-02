// Test only: @restatedev/agents/opencode/db, whose OpenCode has the teller (see opencode.ts
// and fakes.ts).
import { openOpenCode as open } from '@restatedev/agents/opencode/db';
import { withTeller } from './opencode.ts';

export * from '@restatedev/agents/opencode/db';
export const openOpenCode = withTeller(open);
