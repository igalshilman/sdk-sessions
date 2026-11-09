// An agent's answer as data, with `output` (every framework's option): a zod
// object schema. The agent's reply is its answer, as JSON: the system prompt
// asks for it, with the schema, and each prompt again, at its end; the reply
// is checked against it. The
// prompt (and so `chat`) then answers with the value, as an RPC answers.
//
//   const planner = claude.agent({ name: 'planner', output: Plan });   // chat answers with a Plan
//
// The JSON may be in a code fence, or after a sentence. A reply that is not
// such JSON is answered with what is wrong with it, once, for the agent to
// answer again; then the prompt fails (a terminal error), saying how the
// reply starts. The ask again is a step of the turn (`answerOnce`'s
// `check`), and a retried attempt resumes the turn, so it reads the same
// reply.
import * as restate from '@restatedev/sessions';
import { z } from 'zod';

/** What a prompt answers: its text, or with `output`, the value of the agent's reply. */
export type Answer<O> = O extends z.ZodObject ? z.infer<O> : string;

/** What the system prompt asks for, with `output`: JSON of its schema, and nothing else. */
const format = (output: z.ZodObject) =>
  'Your final reply is your answer, as JSON only (no other text): an object of this JSON schema.\n' +
  JSON.stringify(z.toJSONSchema(output));

/**
 * What the model is told after each prompt, with `output`: the system
 * prompt's ask, again, where an agent reads it last (after a long run of tool
 * calls, it may have drifted from its system prompt to a summary in prose).
 * It is not stored: clients read the prompt as it was asked.
 */
const reminder =
  '\n\nWhen you are done, reply with your answer as JSON only, of the schema you were given: no other text.';

/**
 * The JSON `reply` holds: all of it, what a code fence (```json) holds, or
 * else its object, from its first `{` to its last `}` (a model that ends a
 * long run often says a sentence first: "Done. Here is the summary: {...}").
 */
function jsonOf(reply: string): unknown {
  const fenced = /```(?:json)?\s*\n([^]*?)\n?```/.exec(reply)?.[1];
  const object = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  for (const text of [reply, fenced, object]) {
    try {
      if (text?.trim()) return JSON.parse(text);
    } catch {
      // the next
    }
  }
  return undefined;
}

/** The start of `reply`, for an error. */
const excerpt = (reply: string) => (reply.length > 300 ? `${reply.slice(0, 300)}…` : reply);

/** `reply` as a value of `output`, or what is wrong with it. */
function parsed<O extends z.ZodObject>(output: O, reply: string): { value: z.infer<O> } | { wrong: string } {
  if (!reply.trim()) return { wrong: 'it is empty' };
  const json = jsonOf(reply);
  if (json === undefined) return { wrong: `it is not JSON: ${JSON.stringify(excerpt(reply))}` };
  const result = output.safeParse(json);
  return result.success ? { value: result.data } : { wrong: z.prettifyError(result.error) };
}

/** The error of a prompt whose answer is not a value of its `output`, `wrong` saying why. */
const notAsked = (wrong: string) =>
  new restate.TerminalError(`The agent's reply is not the answer asked for: ${wrong}`);

/**
 * The check of an answer that must be a value of `output`: what asks again
 * for one, if it is not (`answerOnce`'s `check`, which asks within the
 * turn), or, once it asked (`last`), the error that fails the turn.
 */
export const recheck =
  (output: z.ZodObject) =>
  (reply: string, last?: boolean): string | undefined => {
    const answer = parsed(output, reply);
    if (!('wrong' in answer)) return undefined;
    if (last) throw notAsked(answer.wrong);
    return `Your reply is not the answer asked for: ${answer.wrong}\nReply again, with the JSON only.`;
  };

/**
 * `prompt` (a framework's on the conversation of turns, of `options`),
 * answering with a value of `options.output` if it has one, or else with the
 * agent's text. A reply that is not the value is asked again within its
 * turn, once (`check`), and the reply to that must be one, or the prompt
 * fails, terminal, and its turn is closed failed. The model is told
 * `reminder` after the prompt, which the conversation keeps as it was asked
 * (`answerOnce`'s `reminder`).
 */
export const withChecked = async <T extends { system?: string; output?: z.ZodObject }>(
  text: string,
  options: T,
  prompt: (
    text: string,
    options: T,
    check?: (answer: string) => string | undefined,
    reminder?: string,
  ) => Promise<string>,
): Promise<Answer<T['output']>> => {
  const { output } = options;
  if (!output) return prompt(text, options) as Promise<Answer<T['output']>>;
  const asked = { ...options, system: [options.system, format(output)].filter(Boolean).join('\n\n') };
  const answer = parsed(output, await prompt(text, asked, recheck(output), reminder));
  if ('wrong' in answer) throw notAsked(answer.wrong);
  return answer.value as Answer<T['output']>;
};
