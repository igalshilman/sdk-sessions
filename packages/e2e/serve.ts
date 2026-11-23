// Examples in one endpoint: every one, or the groups named on the command
// line (ledger, shop, bank, agent, langgraph, claude, deepseek, opencode), such as
// `node serve.ts ledger shop`; each agent with its companion (`withFaults` serves it).
import * as restate from '@restatedev/restate-sdk';
import { withFaults } from '@restatedev/sessions/test/faults';

type Services = restate.ServeOptions['services'];

const groups: Record<string, () => Promise<Services>> = {
  ledger: async () => [(await import('@restatedev/sessions/test/ledger')).ledger],
  shop: async () => {
    const { warehouse, orders } = await import('@restatedev/sessions/test/shop');
    return [warehouse, orders];
  },
  bank: async () => {
    const { account, clock } = await import('@restatedev/sessions/test/bank');
    return [account, clock];
  },
  agent: async () => {
    const pi = await import('@restatedev/agents/test/pi');
    // The service's log says which mode its pi agent runs in (PI_COMMITS=effects batches pi's commits).
    console.error(`pi agent: commits '${pi.commits}'`);
    return [pi.agent];
  },
  langgraph: async () => [(await import('@restatedev/agents/test/langgraph')).agent],
  claude: async () => [(await import('@restatedev/agents/test/claude')).agent],
  deepseek: async () => [(await import('@restatedev/agents/test/deepseek')).agent],
  opencode: async () => [(await import('@restatedev/agents/test/opencode')).agent],
};
const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(groups);
const services = (
  await Promise.all(
    names.map((name) => {
      const group = groups[name];
      if (!group) throw new Error(`no group ${name}: ${Object.keys(groups).join(', ')}`);
      return group();
    }),
  )
).flat();
await restate.serve({ services: withFaults(services), port: Number(process.env.PORT ?? 9080) });
