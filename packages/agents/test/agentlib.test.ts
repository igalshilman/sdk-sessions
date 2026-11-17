// The agentlib agent's pure parts (messages.ts, model.ts, tools.ts), without a Restate
// server: a turn's messages as clients read them, the tools' schemas as
// Anthropic takes them, a provider's refusals, and what approves a call.
// The agent itself runs against a real server: e2e/agentlib.ts.
import type { Message } from '@restatedev/agentlib';
import { sdk, sdk as restate } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import * as agentlib from '../src/agentlib/index.ts';
import { render } from '../src/agentlib/messages.ts';
import { refused, withoutBounds } from '../src/agentlib/model.ts';
import { approves } from '../src/common.ts';
import { toolsOf } from '../src/agentlib/tools.ts';
import { call, signal, subagent, tool } from '../src/index.ts';
import { asyncTool } from '@restatedev/agentlib';
import { z } from 'zod';

const steering = (message: string) =>
  JSON.stringify({ source: 'agent-runtime', type: 'steering', message });

describe('render', () => {
  it('gives each reply its tool calls and their results, and marks prompt and answer', () => {
    const turn: Message[] = [
      { role: 'user', content: 'Plan my week' },
      {
        role: 'assistant',
        content: 'Let me look',
        calls: [
          { id: 'c1', name: 'calendar', input: { week: 1 } },
          { id: 'c2', name: 'weather', input: {} },
        ],
      },
      {
        role: 'tool',
        callId: 'c1',
        name: 'calendar',
        result: { status: 'success', output: { free: ['Mon'] } },
      },
      {
        role: 'tool',
        callId: 'c2',
        name: 'weather',
        result: { status: 'error', code: 'down', message: 'no data' },
      },
      { role: 'user', content: steering('Skip Friday') },
      { role: 'assistant', content: 'Monday it is' },
    ];
    expect(render(turn)).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'Plan my week' }], prompt: true },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me look' },
          {
            type: 'tool',
            id: 'c1',
            name: 'calendar',
            input: { week: 1 },
            output: '{"free":["Mon"]}',
          },
          {
            type: 'tool',
            id: 'c2',
            name: 'weather',
            input: {},
            output: 'Error: no data',
            error: true,
          },
        ],
      },
      { role: 'user', parts: [{ type: 'text', text: 'Skip Friday' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Monday it is' }], answer: true },
    ]);
  });

  it('says how a call was denied or cancelled, and leaves a pending one without output', () => {
    const [, reply] = render([
      { role: 'user', content: 'Go' },
      {
        role: 'assistant',
        content: '',
        calls: [
          { id: 'a', name: 'transfer', input: {} },
          { id: 'b', name: 'slow', input: {} },
          { id: 'c', name: 'job', input: {} },
        ],
      },
      {
        role: 'tool',
        callId: 'a',
        name: 'transfer',
        result: { status: 'denied', message: 'not approved' },
      },
      {
        role: 'tool',
        callId: 'b',
        name: 'slow',
        result: { status: 'cancelled', message: 'stopped' },
      },
      { role: 'tool', callId: 'c', name: 'job', result: { status: 'pending', operationId: 'op' } },
    ]);
    expect(reply!.parts).toEqual([
      {
        type: 'tool',
        id: 'a',
        name: 'transfer',
        input: {},
        output: 'Denied: not approved',
        error: true,
      },
      { type: 'tool', id: 'b', name: 'slow', input: {}, output: 'Cancelled: stopped', error: true },
      { type: 'tool', id: 'c', name: 'job', input: {} },
    ]);
  });

  it("keeps a user's text that looks like JSON, and an empty answer", () => {
    expect(
      render([
        { role: 'user', content: '{"order": 103}' },
        { role: 'assistant', content: '' },
      ]),
    ).toEqual([
      { role: 'user', parts: [{ type: 'text', text: '{"order": 103}' }], prompt: true },
      { role: 'assistant', parts: [{ type: 'text', text: '' }], answer: true },
    ]);
  });
});

describe('withoutBounds', () => {
  it('drops the bounds of numbers, at any depth, and keeps every other keyword', () => {
    const schema = {
      type: 'object',
      properties: {
        offset: { type: ['integer', 'null'], minimum: 0 },
        limit: {
          type: 'integer',
          exclusiveMinimum: 0,
          maximum: 100,
          multipleOf: 5,
          description: 'how many',
        },
        ref: { type: 'string', minLength: 1 },
        items: { type: 'array', items: { type: 'number', maximum: 1 }, maxItems: 3 },
      },
      required: ['ref'],
    };
    expect(withoutBounds(schema)).toEqual({
      type: 'object',
      properties: {
        offset: { type: ['integer', 'null'] },
        limit: { type: 'integer', description: 'how many' },
        ref: { type: 'string', minLength: 1 },
        items: { type: 'array', items: { type: 'number' }, maxItems: 3 },
      },
      required: ['ref'],
    });
  });
});

describe('refused', () => {
  it("is a model's own terminal error for a 4xx, or a missing API key", () => {
    expect(
      refused(new restate.TerminalError('Incorrect API key provided', { errorCode: 401 })),
    ).toBe(true);
    expect(refused(new restate.TerminalError('model not found', { errorCode: 404 }))).toBe(true);
    expect(refused(new restate.TerminalError('OpenAI API key is missing.'))).toBe(true);
  });

  it('is not an outage, a cancellation, a subclass of its own, or a retryable error', () => {
    expect(refused(new restate.TerminalError('503 Service Unavailable'))).toBe(false);
    expect(refused(new restate.CancelledError())).toBe(false);
    class Overflow extends restate.TerminalError {}
    expect(refused(new Overflow('too long', { errorCode: 413 }))).toBe(false);
    // A journaled overflow, as replay restores it: a plain TerminalError, 413.
    expect(refused(new restate.TerminalError('too long', { errorCode: 413 }))).toBe(false);
    expect(refused(new Error('fetch failed'))).toBe(false);
  });
});

describe('approves', () => {
  it('takes true, { approved: true }, or a text that says so; anything else denies', () => {
    for (const value of [true, { approved: true }, 'approved', ' Yes ', 'ok', 'allow'])
      expect(approves(value)).toBe(true);
    for (const value of [false, null, undefined, 'no', 'approved later', { approved: 'yes' }, 1]) {
      expect(approves(value)).toBe(false);
    }
  });
});

describe('toolsOf', () => {
  const planner = agentlib.agent({
    name: 'planner',
    description: 'Plans work',
    model: 'openai/gpt-6-sol',
  });
  const orders = sdk.service({
    name: 'orders',
    handlers: { status: async (_ctx: sdk.Context, _input: unknown) => 'ok' },
  });
  const weather = tool({
    name: 'get_weather',
    description: 'The weather in a city.',
    input: z.object({ city: z.string() }),
    run: ({ city }) => `Sunny in ${city}`,
  });
  const own = {
    echo: asyncTool({ description: 'Echo', input: z.object({}), execute: async () => 'echo' }),
  };

  it("names Restate's tools as every agent does, beside agentlib's own", () => {
    const tools = toolsOf('a', [
      weather,
      call(orders, 'status', { description: 'An order', input: z.object({ order: z.string() }) }),
      signal('approval', { description: 'Wait for a manager' }),
      subagent(planner),
      own,
    ]);
    expect(Object.keys(tools)).toEqual([
      'get_weather',
      'orders_status',
      'wait_for_approval',
      'planner',
      'echo',
    ]);
    expect(tools.echo).toBe(own.echo);
    expect(tools.planner!.description).toBe(
      'Hand a task to the planner agent (Plans work), and get its answer. ' +
        'Tasks of different names run at once; the same name continues the same task.',
    );
    expect(tools.orders_status!.inputSchema).toMatchObject({
      type: 'object',
      properties: { order: { type: 'string' } },
      required: ['order'],
    });
    expect(Object.keys(toolsOf('a', { weather, ...own }))).toEqual(['weather', 'echo']);
  });

  it("refuses an approval of a tool that is none of the agent's own of @restatedev/agents", () => {
    expect(() => toolsOf('a', [weather, own], ['get_weather'])).not.toThrow();
    expect(() => toolsOf('a', [weather, own], ['echo'])).toThrow('a: approval names echo');
    expect(() => toolsOf('a', [weather], ['nope'])).toThrow('a: approval names nope');
    const noTools = { name: 'a', model: 'openai/gpt-6-sol', approval: ['transfer'] };
    expect(() => agentlib.agent(noTools)).toThrow('a: approval names transfer');
  });

  it('refuses two tools of one name', () => {
    expect(() => toolsOf('a', [weather, { get_weather: own.echo }])).toThrow(
      'a: two tools are named get_weather',
    );
  });
});

describe('agent', () => {
  it('refuses a model it cannot take, as it is defined', () => {
    expect(() => agentlib.agent({ name: 'a', model: 'gpt' })).toThrow('is not provider/model-id');
    expect(() => agentlib.agent({ name: 'a', model: 'deepseek/deepseek-flash' })).toThrow(
      'takes openai/… and anthropic/… models by name',
    );
  });

  it('refuses history bounds that are no positive integers, as it is defined', () => {
    expect(() =>
      agentlib.agent({ name: 'a', model: 'openai/gpt-6-sol', history: { retainMessages: 0 } }),
    ).toThrow('a: history.retainMessages must be a positive integer, not 0');
    expect(() =>
      agentlib.agent({ name: 'a', model: 'openai/gpt-6-sol', history: { maxChars: 1.5 } }),
    ).toThrow('a: history.maxChars must be a positive integer, not 1.5');
    expect(() =>
      agentlib.agent({ name: 'a', model: 'openai/gpt-6-sol', history: { maxMessages: 200 } }),
    ).not.toThrow();
  });

  it('is a virtual object with the handlers and views of every agent, and its companion', () => {
    const assistant = agentlib.agent({ name: 'assistant', model: 'openai/gpt-6-sol' });
    expect(assistant.name).toBe('assistant');
    expect(Object.keys((assistant as unknown as { object: object }).object).toSorted()).toEqual(
      [
        'chat',
        'clear',
        'erase',
        'messages',
        'notifications',
        'pending',
        'signal',
        'status',
        'steer',
        'steered',
        'stop',
        'sync',
        'watch',
      ].toSorted(),
    );
  });
});
