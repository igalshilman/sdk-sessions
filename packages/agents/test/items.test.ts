// Each framework's items, as the conversation of turns stores them: an agent
// reads its own framework's rows, and fails for good on another's (an agent of
// another framework under the same name), never retried forever nor read as
// an empty message.
import * as restate from '@restatedev/sessions';
import { describe, expect, it } from 'vitest';
import { items as claude } from '../src/claude/index.ts';
import { type Items, loadItem } from '../src/conversation.ts';
import { items as deepseek } from '../src/deepseek/index.ts';
import { items as langgraph } from '../src/langgraph/index.ts';
import { items as pi } from '../src/pi/index.ts';

const frameworks = { claude, deepseek, langgraph, pi } as unknown as Record<string, Items<unknown>>;

/** The rows `items` stores for a prompt, a reply, and a tool call's result. */
const rowsOf = (items: Items<unknown>) =>
  [
    items.prompt('hello'),
    items.reply('hi there'),
    ...items.results([[{ id: 'c1', name: 'lookup', input: {} }, 'found']]),
  ].map((item) => items.dump(item));

describe("each framework's items", () => {
  for (const [name, items] of Object.entries(frameworks)) {
    it(`${name} reads its own rows back`, () => {
      for (const row of rowsOf(items)) expect(items.dump(loadItem(items, row))).toEqual(row);
    });
    for (const [otherName, other] of Object.entries(frameworks)) {
      if (otherName === name) continue;
      it(`${name} fails for good on ${otherName}'s rows`, () => {
        for (const row of rowsOf(other)) {
          expect(() => loadItem(items, row)).toThrow(restate.TerminalError);
        }
      });
    }
  }
});
