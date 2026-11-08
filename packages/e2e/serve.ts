// Examples in one endpoint: every one, or the groups named on the command
// line (ledger, shop, bank, agent, langgraph, claude, deepseek), such as
// `node serve.ts ledger shop`; with the agents' `signals` object.
import * as restate from '@restatedev/restate-sdk';
import { signals } from '@restatedev/agents';
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
  agent: async () => [(await import('@restatedev/agents/test/pi')).agent],
  langgraph: async () => [(await import('@restatedev/agents/test/langgraph')).agent],
  claude: async () => [(await import('@restatedev/agents/test/claude')).agent],
  deepseek: async () => [(await import('@restatedev/agents/test/deepseek')).agent],
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
await restate.serve({ services: withFaults([...services, signals]), port: Number(process.env.PORT ?? 9080) });
