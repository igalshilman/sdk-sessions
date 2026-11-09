// An agent's answer as data (`output`): its reply, as JSON of the schema,
// is what `chat` answers with; a reply that is not is answered with what is
// wrong, once, then the invocation fails; a crash at any point still answers
// with it. On pi's chat, with a fake model (../fakes/pi.ts), Claude's (the
// teller's client, ../fakes/claude.ts) and DeepSeek's (../fakes/deepseek.ts);
// the others share the same code (output.ts).
import * as restate from '@restatedev/sessions';
import * as claude from '@restatedev/agents/claude';
import * as deepseek from '@restatedev/agents/deepseek';
import * as pi from '@restatedev/agents/pi';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { teller } from './fakes/claude.ts';
import { teller as deepseekTeller } from './fakes/deepseek.ts';
import { fakeProvider, say, textOf } from './fakes/pi.ts';
import type { Messages, MessagesRequest } from '../src/common.ts';
import { conversation, type PromptHandler } from './support.ts';

const PLAN = { summary: 'A calculator', parts: ['parser', 'history'] };

// Asked to plan, it answers with the plan, as JSON; if reminded at the end of
// the prompt, only then; chattily, with a sentence
// around it; asked lazily, in prose, then in a code fence once told; asked to
// refuse, in prose always.
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  builtinProviders: () => [
    fakeProvider('openai', 'gpt-6-sol', ({ messages }) => {
      const asked = textOf(messages.at(-1)!.content);
      const prompted = textOf(messages.find((m) => m.role === 'user')!.content);
      const [first] = prompted.split('\n'); // the task, before the reminder of the JSON asked for
      if (first === 'Plan it') return say(JSON.stringify(PLAN));
      if (first === 'Plan chattily') return say(`Done! Here is the plan:\n${JSON.stringify(PLAN)}\nAll set.`);
      if (first === 'Plan lazily' && asked.startsWith('Your reply is not')) {
        return say('```json\n' + JSON.stringify(PLAN) + '\n```');
      }
      if (first === 'Plan if reminded') {
        return say(
          prompted.endsWith('as JSON only, of the schema you were given: no other text.')
            ? JSON.stringify(PLAN)
            : 'Done!',
        );
      }
      if (first === 'Plan wrongly') return say(JSON.stringify({ summary: 1 }));
      return say('A plan, in prose');
    }),
  ],
}));

vi.mock('@anthropic-ai/sdk', () => import('./fakes/claude.ts'));
vi.mock('@deepseek-ai/dsh-llm-deepseek-api-key', () => import('./fakes/deepseek.ts'));

const Plan = z.object({ summary: z.string(), parts: z.array(z.string()) });

/** The user's messages of a conversation, as clients read it with `view` (a framework's `messages()`). */
async function promptsIn(
  c: ReturnType<typeof conversation>,
  view: (ctx: restate.ViewContext, request?: MessagesRequest) => Promise<Messages>,
): Promise<string[]> {
  const { messages } = await c.read(view);
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
}
const chat = pi.chat({ output: Plan }) as unknown as PromptHandler;

describe("an agent's output", () => {
  it('is what chat answers with: the value of the reply, not its text', async () => {
    expect(await conversation(chat, 'a').attempt('inv1', 'Plan it')).toEqual(PLAN);
  });

  it('is asked for at the end of each prompt, too, not only in the system prompt', async () => {
    expect(await conversation(chat, 'reminded').attempt('inv1', 'Plan if reminded')).toEqual(PLAN);
  });

  it('is taken from a reply with a sentence around it', async () => {
    expect(await conversation(chat, 'chatty').attempt('inv1', 'Plan chattily')).toEqual(PLAN);
  });

  it('is asked for once more, with what is wrong, if the reply is not it (a code fence is taken)', async () => {
    expect(await conversation(chat, 'b').attempt('inv1', 'Plan lazily')).toEqual(PLAN);
  });

  it('fails the invocation if the reply is never it', async () => {
    const refused = conversation(chat, 'c').attempt('inv1', 'Refuse');
    await expect(refused).rejects.toBeInstanceOf(restate.TerminalError);
    await expect(refused).rejects.toThrow(/not the answer asked for: it is not JSON: "A plan, in prose"/);
    await expect(conversation(chat, 'd').attempt('inv1', 'Plan wrongly')).rejects.toThrow(/summary/);
  });

  it('closes its turn failed when the reply asked again is not it either, as the invocation fails', async () => {
    const c = conversation(chat, 'never');
    const notIt = /^The agent's reply is not the answer asked for: it is not JSON: "A plan, in prose"$/;
    await expect(c.attempt('inv1', 'Refuse')).rejects.toThrow(notIt);
    // The conversation says the turn failed, and why: not with the reply, as if it were the answer.
    const { messages } = await c.read(pi.messages(), { view: 'summary' });
    const [, answer] = messages;
    expect(answer!.parts).toEqual([{ type: 'text', text: expect.stringMatching(/^Error: The agent's reply is not/) }]);
    // Retried (a crash right after the close), it fails as it did.
    await expect(c.attempt('inv1', 'Refuse')).rejects.toThrow(notIt);
  });

  it('survives a crash at any point: the retry answers with the same reply', async () => {
    for (let crashAt = 1; ; crashAt++) {
      const c = conversation(chat, `crash-${crashAt}`);
      if ((await c.attempt('inv1', 'Plan it', crashAt)) !== 'crashed') break;
      expect(await c.attempt('inv1', 'Plan it')).toEqual(PLAN);
    }
  }, 60_000);

  it("is Claude's too", async () => {
    // It answers with the plan, as JSON.
    teller.reply = (messages) => {
      return {
        id: `msg_${messages.length}`,
        type: 'message',
        role: 'assistant',
        model: 'teller',
        content: [{ type: 'text', text: JSON.stringify(PLAN) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as ReturnType<typeof teller.reply>;
    };
    const planner = claude.chat({ output: Plan }) as unknown as PromptHandler;
    expect(await conversation(planner, 'claude').attempt('inv1', 'Plan it')).toEqual(PLAN);
  });

  it("is DeepSeek's too, asked once more with what is wrong, however a crash cuts it", async () => {
    // In prose, then in a code fence once told; asked to continue (after a crash), it answers the request it continues.
    const asked: string[] = [];
    deepseekTeller.reply = (messages) => {
      const requests = messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(''))
        .filter((text) => !text.startsWith('Continue: '));
      const request = requests.at(-1)!;
      asked.push(request);
      return {
        text: request.startsWith('Your reply is not') ? '```json\n' + JSON.stringify(PLAN) + '\n```' : 'A plan',
      };
    };
    const planner = deepseek.chat({ output: Plan }) as unknown as PromptHandler;
    expect(await conversation(planner, 'deepseek').attempt('inv1', 'Plan lazily')).toEqual(PLAN);
    expect(asked).toHaveLength(2);
    for (let crashAt = 1; ; crashAt++) {
      const c = conversation(planner, `deepseek-${crashAt}`);
      if ((await c.attempt('inv1', 'Plan lazily', crashAt)) !== 'crashed') break;
      expect([crashAt, await c.attempt('inv1', 'Plan lazily')]).toEqual([crashAt, PLAN]);
    }
  }, 60_000);

  it('is asked for after the prompt, which the conversation keeps as it was asked', async () => {
    // pi: the model is reminded (it answers with JSON only if it is), the conversation is not.
    const c = conversation(chat, 'kept');
    expect(await c.attempt('inv1', 'Plan if reminded')).toEqual(PLAN);
    expect(await promptsIn(c, pi.messages())).toEqual(['Plan if reminded']);
    // Claude (asked in the prompt, not natively) and DeepSeek: the model's request ends the prompt with the reminder.
    const prompted: string[] = [];
    const { reply } = teller;
    teller.reply = (messages) => {
      const { content } = messages.find((m) => m.role === 'user')!;
      prompted.push(typeof content === 'string' ? content : content.map((b) => ('text' in b ? b.text : '')).join(''));
      return {
        id: `msg_${messages.length}`,
        type: 'message',
        role: 'assistant',
        model: 'teller',
        content: [{ type: 'text', text: JSON.stringify(PLAN) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as ReturnType<typeof teller.reply>;
    };
    const { reply: deepseekReply } = deepseekTeller;
    deepseekTeller.reply = (messages) => {
      const user = messages.find((m) => m.role === 'user')!;
      prompted.push(user.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''));
      return { text: JSON.stringify(PLAN) };
    };
    try {
      for (const [planner, view] of [
        [claude.chat({ output: Plan, nativeOutput: false }), claude.messages()],
        [deepseek.chat({ output: Plan }), deepseek.messages()],
      ] as const) {
        const k = conversation(planner as unknown as PromptHandler, `kept-${prompted.length}`);
        expect(await k.attempt('inv1', 'Plan it')).toEqual(PLAN);
        expect(prompted.at(-1)).toMatch(/^Plan it\n\nWhen you are done, reply with your answer as JSON only/);
        expect(await promptsIn(k, view)).toEqual(['Plan it']);
      }
    } finally {
      teller.reply = reply;
      deepseekTeller.reply = deepseekReply;
    }
  });

  it('types what prompt answers: the output, or else text', () => {
    expectTypeOf<Awaited<ReturnType<typeof pi.prompt<typeof Plan>>>>().toEqualTypeOf<z.infer<typeof Plan>>();
    expectTypeOf<Awaited<ReturnType<typeof pi.prompt<undefined>>>>().toEqualTypeOf<string>();
  });

  it("types what an agent's chat answers its callers", () => {
    const planner = claude.agent({ name: 'planner', output: Plan });
    const writer = claude.agent({ name: 'writer' });
    const plan = (ctx: restate.Context) => ctx.objectClient(planner, 'k').chat('Plan it');
    const write = (ctx: restate.Context) => ctx.objectClient(writer, 'k').chat('Write it');
    expectTypeOf<Awaited<ReturnType<typeof plan>>>().toEqualTypeOf<z.infer<typeof Plan>>();
    expectTypeOf<Awaited<ReturnType<typeof write>>>().toEqualTypeOf<string>();
  });
});
