// A made-up framework's items, as the Python SDK's tests have them: `{ role,
// text }` messages, a reply's `calls`, and `{ result, output }` results.
import type { Call, Items, Parsed } from '../../src/conversation.ts';

export interface Item {
  role?: 'user' | 'assistant';
  text?: string;
  calls?: { id: string; name: string; input: unknown }[];
  result?: string;
  output?: string;
}

export class FakeItems implements Items<Item> {
  dump(item: Item) {
    return JSON.stringify(item);
  }
  load(stored: string): Item {
    return JSON.parse(stored) as Item;
  }
  prompt(text: string): Item {
    return { role: 'user', text };
  }
  reply(text: string): Item {
    return { role: 'assistant', text };
  }
  results(results: [Call, string][]): Item[] {
    return results.map(([call, output]) => ({ result: call.id, output }));
  }
  read(item: Item): Parsed {
    return {
      said: item.role ? [item.role, item.text ?? ''] : undefined,
      calls: (item.calls ?? []).map(({ id, name, input }) => ({ id, name, input })),
      results: item.result !== undefined ? [{ id: item.result, output: item.output ?? '' }] : [],
    };
  }
}

export const ITEMS = new FakeItems();

/** A reply of the assistant that calls `lookup` with each of `ids`. */
export const calling = (...ids: string[]): Item => ({
  role: 'assistant',
  text: '',
  calls: ids.map((id) => ({ id, name: 'lookup', input: {} })),
});
