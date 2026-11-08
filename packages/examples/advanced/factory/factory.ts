/**
 * A software factory: a new Linear issue, through a webhook, starts a triage
 * agent (pi), which has a planner (pi) plan it, a coder (pi) per part
 * build it and open its pull request, and a reviewer (pi) review each one.
 * GitHub's webhook brings people's comments and reviews, and failed CI
 * runs, to the coder of the pull request. See README.md.
 *
 *   node advanced/factory/linear.ts                                       # Linear (a stand-in), on port 3333
 *   OPENAI_API_KEY=… ANTHROPIC_API_KEY=… node advanced/factory/factory.ts
 *   npx @restatedev/restate-server                                        # Restate, in another terminal
 *   npx @restatedev/restate deployments register http://localhost:9080
 *   curl localhost:3333/issues --json '{"title": "A calculator CLI", "description": "calc.py, with tests"}'
 *   curl localhost:8080/triage/ENG-1/messages                             # triage's conversation
 *
 * The environment (the real Linear and GitHub, WORKSPACE): env.ts. Coders
 * run real commands, on this machine: use a sandbox.
 */
import { serve, sessionObject, subagent, webhook } from '@restatedev/agents';
import * as pi from '@restatedev/agents/pi';
import * as env from './env.ts';
import * as github from './github.ts';
import { Built, Plan, Review } from './answers.ts';
import * as prompts from './prompts.ts';
import { byAnAgent } from './signatures.ts';

const reviewer = pi.agent({
  name: 'reviewer',
  description: 'Reviews a pull request, as pushed, and posts its review on it: approved, or the changes to make',
  model: 'openai/gpt-6-astra',
  serviceTier: 'fast',
  tools: env.reviewTools('🔍 Reviewer'),
  system: prompts.REVIEWER,
  output: Review,
});

/** A coder's options: its workspace is a clone of the project, on a branch of its own, for its key. */
const coding = {
  model: 'anthropic/claude-sonnet-5-5',
  tools: [...env.linearTools('🛠️ Coder'), env.pullRequestTool('🛠️ Coder'), env.pullRequestCommentTool('🛠️ Coder')],
  system: prompts.CODER,
  output: Built,
};

const coder = sessionObject({
  name: 'coder',
  description: 'Builds a part of the plan, on a branch of its own, and opens its pull request; answers its reviews',
  handlers: {
    chat: pi.chat(async (ctx) => ({ ...coding, workspace: await env.coderWorkspace(ctx) })),
  },
  views: { messages: pi.messages() },
});

const planner = pi.agent({
  name: 'planner',
  description: 'Plans the work on an issue, from its title and description: a summary, and parts to build at once',
  model: 'openai/gpt-6.1-sol',
  serviceTier: 'fast',
  system: prompts.PLANNER,
  output: Plan,
});

const triage = pi.agent({
  name: 'triage',
  model: 'openai/gpt-6-sol',
  serviceTier: 'fast', // OpenAI's fast mode
  tools: [...env.linearTools('🧭 Triage'), subagent(planner), subagent(coder), subagent(reviewer)],
  system: prompts.TRIAGE,
});

const linearEvents = webhook({
  name: 'linear',
  description: "Linear's new issues, and comments on them, to triage",
  auth: env.linearWebhookAuth,
  idempotencyHeader: 'linear-delivery',
  route: [triage],
  // The event's shape: https://linear.app/developers/webhooks
  key: ({ type, action, data }) => {
    if (action !== 'create') return undefined;
    if (type === 'Issue' && !data.parentId) return data.identifier;
    if (type === 'Comment' && !byAnAgent(data.body)) return data.issue.identifier;
    return undefined;
  },
});

const githubEvents = webhook({
  name: 'github',
  description: "GitHub's comments, reviews and failed CI runs on the coders' pull requests, to their coders",
  auth: github.webhookAuth,
  idempotencyHeader: 'x-github-delivery',
  route: [coder],
  key: github.coderOf,
  message: github.whatHappened,
});

await serve(linearEvents, githubEvents, triage, planner, coder, reviewer);
