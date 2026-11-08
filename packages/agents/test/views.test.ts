// The `messages` view of each framework's items: what a client sees of a
// turn, rendered from the conversation of turns (messages.ts).
import { describe, expect, it } from 'vitest';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { freezeMessage, type Message as DeepSeekMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';
import type Anthropic from '@anthropic-ai/sdk';
import { items as claudeItems } from '../src/claude/index.ts';
import { items as deepseekItems } from '../src/deepseek/index.ts';
import { items as langgraphItems } from '../src/langgraph/index.ts';
import { type Item as PiItem, items as piItems } from '../src/pi/index.ts';
import { Conversation, type Items } from '../src/conversation.ts';
import { page } from '../src/messages.ts';
import { sqlAttempt } from './support.ts';

/** A framework's items, and a reply of the model that only calls tool `id`. */
interface Framework<I> {
  name: string;
  items: Items<I>;
  calling: (id: string) => I;
}

const frameworks: Framework<never>[] = [
  {
    name: 'claude',
    items: claudeItems,
    calling: (id: string): Anthropic.Beta.Messages.BetaMessageParam => ({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'lookup', input: {} }],
    }),
  },
  {
    name: 'langgraph',
    items: langgraphItems,
    calling: (id: string): BaseMessage =>
      new AIMessage({ content: '', tool_calls: [{ id, name: 'lookup', args: {} }] }),
  },
  {
    name: 'deepseek',
    items: deepseekItems,
    calling: (id: string): DeepSeekMessage =>
      freezeMessage({
        id: MessageId(`reply-${id}`),
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId(id), name: 'lookup', arguments: '{}' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      }),
  },
  {
    name: 'pi',
    items: piItems,
    calling: (id: string): PiItem => ({
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id, name: 'lookup', arguments: {} }],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 0,
      },
    }),
  },
] as Framework<never>[];

describe.each(frameworks)('the messages of $name', ({ items, calling }) => {
  it('give each reply of the model its own message, one of tool calls only too', async () => {
    const sql = sqlAttempt({ map: new Map(), key: 'k', id: 'inv1' });
    const parts = await sql.end(async () => {
      const conversation = await Conversation.load(sql.ctx.db, items);
      const turn = await conversation.ask('inv1', 'Refund order 103');
      for (const id of ['c1', 'c2']) {
        await turn.appendReply([calling(id)]);
        await turn.append(...items.results([[{ id, name: 'lookup', input: {} }, `${id} done`]]));
      }
      return (await page(sql.ctx.db, items as Items<unknown>)).messages.map((m) => [
        m.role,
        m.parts.map((p) => (p.type === 'tool' ? `${p.id}: ${p.output}` : p.text)),
      ]);
    });
    expect(parts).toEqual([
      ['user', ['Refund order 103']],
      ['assistant', ['c1: c1 done']],
      ['assistant', ['c2: c2 done']],
    ]);
  });
});
