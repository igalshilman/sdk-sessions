// Bring back bugs that @restatedev/agents had, one at a time, and see which
// tests notice.
//
// Each mutant is a small edit of today's code (one text, found once in one
// file, replaced) that brings back a bug a fix of the history describes: the
// fixes after review of #10 and the follow-ups of #11, each a commit of its
// own on their branch (claude/sdk-sessions-conversation-store-son85g), the
// fixes of v0.3.0's bugs that steps 1 and 2 of the plan port from the Python
// SDK, and those since; or a bug that would break the contract of a turn, of
// no fix (a durability mutant: the Python SDK's that apply here). For each,
// the runner applies the edit, runs the test files that use the code it
// changes, restores the code, and says what failed:
//
// - killed: the tests that guard it (`own`, those its fix added) failed; with
//   "and N more", other tests too, so the suite would see it without them;
// - hung: a run of the tests did not end within `--timeout`;
// - not by its own: other tests failed, but not those it names;
// - SURVIVED: no test failed. The bug can come back unnoticed.
//
// The tests that fail without any edit (the baseline) are left out of every
// verdict. A mutant whose text is not found exactly once in its file no longer
// matches the code: the run fails before it edits anything, and says which.
// The code is restored after each mutant, also on Ctrl-C or SIGTERM.
//
//   node scripts/resurrect.ts                   # every mutant (from packages/agents)
//   node scripts/resurrect.ts lastof-scans pi-outage-ends-turn
//   node scripts/resurrect.ts --list
//   node scripts/resurrect.ts --check           # only that each mutant's text matches
//   node scripts/resurrect.ts --unit            # not the mutants only a Restate server sees
//   node scripts/resurrect.ts --timeout 600     # seconds for each run of the tests (default 900)
//
// A mutant marked `e2e` is seen only against a Restate server: its test is a
// script of packages/e2e, run with the server @restatedev/restate-server
// installs (`RESTATE_SERVER` names another), on ports 8080, 9070 and 9301.
// Exits 1 if a mutant no longer matches, survives, or is killed by other tests
// than its own.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/agents: the mutants' files and tests are relative to it. */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const E2E = join(PACKAGE, '..', 'e2e');
const VITEST = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

/** Every test file: a mutant of code that every framework uses runs them all. */
const ALL: string[] = [];
const CLAUDE = ['test/claude.test.ts', 'test/output.test.ts', 'test/views.test.ts'];
const LANGGRAPH = ['test/langgraph.test.ts', 'test/models.test.ts', 'test/views.test.ts', 'test/storage/'];
const CHECKPOINTER = [
  'test/storage/langgraph-latest.test.ts',
  'test/storage/langgraph.test.ts',
  'test/langgraph.test.ts',
];
const DEEPSEEK = ['test/deepseek.test.ts', 'test/models.test.ts', 'test/output.test.ts', 'test/views.test.ts'];
const PI = [
  'test/pi.test.ts',
  'test/pi-bank.test.ts',
  'test/models.test.ts',
  'test/output.test.ts',
  'test/views.test.ts',
  'test/harness.test.ts',
  'test/memory.test.ts',
  'test/storage/pi.test.ts',
];

interface Mutant {
  name: string;
  /** The commit of the fix that removed the bug; none for a durability mutant, of a bug no fix describes. */
  fix: string;
  /** The bug it brings back, as its fix describes it. */
  bug: string;
  file: string;
  /** Text of today's code, found exactly once in `file`. */
  old: string;
  /** What `old` becomes: the bug, back. */
  new: string;
  /** The test files that run against it (`ALL` for every one): those that use the code it changes. */
  tests: string[];
  /**
   * The tests that must fail: those of its fix, each matched against a
   * failing test's file and full name (`test/pi.test.ts > the pi agent
   * answers ...`), of which it is a part.
   */
  own: string[];
  /** A script of packages/e2e that must fail instead, for a bug only a Restate server shows. */
  e2e?: string;
}

const lines = (...text: string[]) => text.join('\n');

const MUTANTS: Mutant[] = [
  // --- Step 1 of the plan (3b4af36): the call records, as the Python SDK's _calls.py ---
  {
    name: 'call-matched-by-id-alone',
    fix: '3b4af36',
    bug: "an approval and its tool call's own Restate call share one record, and the call's outcome is lost",
    file: 'src/calls.ts',
    old: '    ours.find((c) => c.ids.includes(callId) && c.tool === tool) ??',
    new: '    ours.find((c) => c.ids.includes(callId)) ??',
    tests: ALL,
    own: ["are found by the call's id and its tool"],
  },
  {
    name: 'wait-rejoins-another-call',
    fix: '3b4af36',
    bug: "a framework's new call with the input of an earlier attempt's joins its wait, and gets its answer unasked",
    file: 'src/tools.ts',
    old: '{ approval = false, rejoin = false }',
    new: '{ approval = false, rejoin = true }',
    tests: ALL,
    own: ['waits for a signal for its own tool call once'],
  },
  {
    name: 'approval-is-the-calls-outcome',
    fix: '3b4af36',
    bug: 'an approval that returned is reported as its tool call done, a denied one too',
    file: 'src/calls.ts',
    old: '    if (!call.done || call.approval) continue;',
    new: '    if (!call.done) continue;',
    tests: ALL,
    own: ["never reports an approval that returned as its call's outcome"],
  },
  {
    name: 'input-keys-in-order',
    fix: '3b4af36',
    bug: 'an input is matched as its JSON: the same input with its keys in another order is another call',
    file: 'src/calls.ts',
    old: lines('function canonical(value: unknown): string {', '  return JSON.stringify(value, (_key, v: unknown) =>'),
    new: lines(
      'function canonical(value: unknown): string {',
      '  return JSON.stringify(value);',
      '  return JSON.stringify(value, (_key, v: unknown) =>',
    ),
    tests: ALL,
    own: ['match an input whatever the order of its keys'],
  },
  // --- Step 2 of the plan (57cf2d9): LangGraph's checkpointer, as the Python SDK's _checkpointer.py ---
  {
    name: 'langgraph-values-or-chain',
    fix: '57cf2d9',
    bug: "a checkpoint's values are read with an OR of each channel: a graph of about 95 channels or more can't be read",
    file: 'src/langgraph/checkpointer.ts',
    old: '`SELECT channel, type, value FROM restate_langgraph_channel_values WHERE thread_id = ? AND checkpoint_ns = ? AND (channel, version) IN ${pairsOf}`,',
    new: "`SELECT channel, type, value FROM restate_langgraph_channel_values WHERE thread_id = ? AND checkpoint_ns = ? AND (${versions.map(() => '(channel = ? AND version = ?)').join(' OR ')})`,",
    tests: CHECKPOINTER,
    own: ['a graph of more channels than an expression can be deep is read'],
  },
  {
    name: 'langgraph-prune-or-chain',
    fix: '57cf2d9',
    bug: "history 'latest' prunes with an OR of each kept version: a graph of about 95 channels or more fails each turn",
    file: 'src/langgraph/checkpointer.ts',
    old: '`DELETE FROM restate_langgraph_channel_values WHERE thread_id = ? AND checkpoint_ns = ? AND (channel, version) NOT IN ${rows}`,',
    new: "`DELETE FROM restate_langgraph_channel_values WHERE thread_id = ? AND checkpoint_ns = ? AND NOT (${[...versions.values()].map(() => '(channel = ? AND version = ?)').join(' OR ')})`,",
    tests: CHECKPOINTER,
    own: ['a graph of more channels than an expression can be deep is read and pruned'],
  },
  {
    name: 'langgraph-delta-history-dropped',
    fix: '57cf2d9',
    bug: "history 'latest' keeps only the latest checkpoint: a delta channel's graph loses its messages at every run",
    file: 'src/langgraph/checkpointer.ts',
    old: '      if (waiting.size === 0 || next.parent === null) break;',
    new: '      break;',
    tests: CHECKPOINTER,
    own: ['keeps what a delta channel is rebuilt from, across runs'],
  },
  // --- #10, after review: each fix a commit of its own ---
  {
    name: 'claude-tool-calls-say-nothing',
    fix: 'e10c084',
    bug: "a reply of Claude's of tool calls only is no message of its own: the view puts its calls in the one before",
    file: 'src/claude/index.ts',
    old: "    const said = role === 'assistant' || texts.length > 0;",
    new: "    const said = texts.length > 0 || (role === 'assistant' && calls.length === 0 && results.length === 0);",
    tests: CLAUDE,
    own: ['the messages of claude give each reply of the model its own message'],
  },
  {
    name: 'langgraph-tool-calls-say-nothing',
    fix: 'e10c084',
    bug: "a reply of LangGraph's of tool calls only is no message of its own",
    file: 'src/langgraph/index.ts',
    old: "      return { said: ['assistant', message.text], calls };",
    new: "      return message.text || calls.length === 0 ? { said: ['assistant', message.text], calls } : { calls };",
    tests: LANGGRAPH,
    own: ['the messages of langgraph give each reply of the model its own message'],
  },
  {
    name: 'deepseek-tool-calls-say-nothing',
    fix: 'e10c084',
    bug: "a reply of DeepSeek's of tool calls only is no message of its own",
    file: 'src/deepseek/index.ts',
    old: "      return { said: ['assistant', textOf(m)], calls };",
    new: "      return textOf(m) || calls.length === 0 ? { said: ['assistant', textOf(m)], calls } : { calls };",
    tests: DEEPSEEK,
    own: ['the messages of deepseek give each reply of the model its own message'],
  },
  {
    name: 'pi-tool-calls-say-nothing',
    fix: 'e10c084',
    bug: "a reply of pi's of tool calls only is no message of its own",
    file: 'src/pi/index.ts',
    old: "      return { said: ['assistant', textOf(m.content)], calls };",
    new: "      return textOf(m.content) || calls.length === 0 ? { said: ['assistant', textOf(m.content)], calls } : { calls };",
    tests: PI,
    own: ['the messages of pi give each reply of the model its own message'],
  },
  {
    name: 'close-unfenced',
    fix: 'ebfd4f9',
    bug: "a stopped turn's run, left running, stores a tool's result after the close's note, and copies in its steps",
    file: 'src/conversation.ts',
    old: '    this.#fenced = true;\n',
    new: '',
    tests: ALL,
    own: ['stores nothing after the close', 'takes no copy of a framework into a turn being closed'],
  },
  {
    name: 'close-before-writes-under-way',
    fix: 'ebfd4f9',
    bug: "a stop while the model's reply is being stored closes the turn without a result for the reply's calls",
    file: 'src/conversation.ts',
    old: lines('    await ledger.lock.run(async () => {});', '    if (this.status !== undefined) return;\n'),
    new: '',
    tests: ALL,
    own: ['closes the calls of a reply whose write was under way as the stop came'],
  },
  {
    name: 'close-in-two-commits',
    fix: 'ebfd4f9',
    bug: 'a close stores its results and note, then its answer: a crash between them closes the turn again, a second note',
    file: 'src/conversation.ts',
    old: lines(
      '          await tx.execute(INSERT_STEP, [e.n, this.n, seq + i + 1, items.dump(e.item), null, null]);',
      '        }\n',
    ),
    new: lines(
      '          await tx.execute(INSERT_STEP, [e.n, this.n, seq + i + 1, items.dump(e.item), null, null]);',
      '        }',
      '      });',
      '      await ledger.db.transaction(async (tx) => {\n',
    ),
    tests: ALL,
    own: ['closes a dead turn once, however a crash cuts it'],
  },
  {
    name: 'copy-into-closing-turn',
    fix: 'ebfd4f9',
    bug: "a framework's copy into a turn being closed takes the close's positions: UNIQUE fails, a 500 and the turn open",
    file: 'src/conversation.ts',
    old: '    if (!this.writable) return false;\n',
    new: '',
    tests: ALL,
    own: ['takes no copy of a framework into a turn being closed'],
  },
  {
    name: 'framework-refusal-closed-failed',
    fix: 'b517f54',
    bug: "a framework's own 424 (pi's refusal) closes its turn failed with the raw error, and a retry answers it",
    file: 'src/conversation.ts',
    old: '      error instanceof restate.TerminalError ? (error.code === REFUSED ? error : undefined) : refusalOf(ctx, error);',
    new: '      error instanceof restate.TerminalError ? undefined : refusalOf(ctx, error);',
    tests: ALL,
    own: ["without its provider's API key fails the invocation, for pi's agent"],
  },
  {
    name: 'retry-answers-closed-turn',
    fix: 'b517f54',
    bug: 'a retry of a turn closed failed, cancelled or ended answers its note as a success',
    file: 'src/conversation.ts',
    old: '  if (stored !== undefined) return storedAnswer(stored.answer, stored.status);',
    new: "  if (stored !== undefined) return storedAnswer(stored.answer, stored.status === 'refused' ? 'refused' : 'answered');",
    tests: ALL,
    own: ['a retry of a closed turn fails as the prompt did'],
  },
  {
    name: 'calls-of-another-prompt',
    fix: '457f5a8',
    bug: "an invocation's second prompt rejoins the call its first made (same tool and input), and never makes its own",
    file: 'src/calls.ts',
    old: '  const ours = state.calls.filter((c) => c.prompt === prompt);',
    new: '  const ours = state.calls;',
    tests: ALL,
    own: ["makes each prompt's call, the same tool and input, as its own"],
  },
  {
    name: 'outcomes-of-another-prompt',
    fix: '457f5a8',
    bug: 'a closing turn reports a call another prompt of its invocation made, with the same id, as its own',
    file: 'src/calls.ts',
    old: '    if (prompt !== undefined && call.prompt !== undefined && call.prompt !== prompt) continue;\n',
    new: '',
    tests: ALL,
    own: ['do not report a call another prompt of the invocation made, with the same id, as theirs'],
  },
  {
    name: 'another-frameworks-items',
    fix: 'd7331b4',
    bug: "an agent answers with another framework's items than its view's, which it then reads as its own",
    file: 'src/conversation.ts',
    old: '  if (settings.items !== undefined && settings.items !== items) {',
    new: '  if (false) {',
    tests: ALL,
    own: ["refuses to answer with items other than its `messages` view's"],
  },
  {
    name: 'claude-paused-reply-ends-turn',
    fix: '2e79f25',
    bug: 'a reply the API paused (pause_turn) is stored as a reply, and ends the turn with its partial text',
    file: 'src/claude/index.ts',
    old: lines('          await turn.append(said);', '          paused = true;'),
    new: lines('          await turn.appendReply([said]);', '          paused = true;'),
    tests: CLAUDE,
    own: ['goes on from a reply the API paused'],
  },
  {
    name: 'deepseek-asks-the-prompt-again',
    fix: 'abff4c4',
    bug: "a DeepSeek turn that asks again answers with the harness's first reply: the model is never asked again",
    file: 'src/deepseek/index.ts',
    old: '    const again = asked !== turn.prompt;',
    new: '    const again = false;',
    tests: DEEPSEEK,
    own: ["is DeepSeek's too, asked once more with what is wrong"],
  },
  {
    name: 'pi-dead-run-resumed',
    fix: '994a23c',
    bug: "a withPi handler that is no prompt has pi resume a gone invocation's run: its transfer is made again",
    file: 'src/pi/index.ts',
    old: '    await abortLeft((r) => invocationOf(r) === ctx.request.id);\n',
    new: '',
    tests: PI,
    own: ["aborts a gone invocation's run whatever the next handler does with pi"],
  },
  {
    name: 'pi-aborts-its-own-run',
    fix: '994a23c',
    bug: "a prompt aborts its own retried run beside a write of pi's (a compaction's): the turn fails unanswered",
    file: 'src/pi/index.ts',
    old: "    const left = submissions.filter((s) => s.type === 'input' && s.requestId !== undefined && !kept(s.requestId));",
    new: "    const left = submissions.filter((s) => !kept(s.requestId ?? ''));",
    tests: PI,
    own: ["goes on with its own run after a crash, beside a write of pi's that waits for it"],
  },
  {
    name: 'pi-cancelled-work-succeeds',
    fix: '2234efe',
    bug: 'a cancelled withPi whose work is no prompt (a wait for pi) succeeds',
    file: 'src/pi/index.ts',
    old: lines('    if (cancelled) throw cancelled;', '    return done;'),
    new: '    return done;',
    tests: PI,
    own: ['fails with the cancellation of work that is not a prompt'],
  },
  {
    name: 'pi-tool-error-refusal',
    fix: '8d28383',
    bug: "a pi tool that fails as a provider does is taken for the model's provider refusing: the turn ends refused",
    file: 'src/pi/index.ts',
    old: lines('        fromTool(ctx, error);', '        return stopped(error, task);'),
    new: '        return stopped(error, task);',
    tests: PI,
    own: ["never takes a pi tool's error for the provider refusing the model"],
  },
  {
    name: 'claude-empty-reply-sent',
    fix: 'd5d2191',
    bug: "Claude's empty reply is sent back as it came, which the API refuses: later prompts end refused",
    file: 'src/claude/index.ts',
    old: '          messages: sendable(conversation.history()),',
    new: '          messages: conversation.history(),',
    tests: CLAUDE,
    own: ['sends a reply of the model with nothing in it back as one that says so'],
  },
  {
    name: 'langgraph-empty-reply-sent',
    fix: 'd5d2191',
    bug: "LangGraph's empty reply is sent back as it came, which a provider may refuse",
    file: 'src/langgraph/index.ts',
    old: '        { messages: sendable(conversation.history()) },',
    new: '        { messages: conversation.history() },',
    tests: LANGGRAPH,
    own: ['sends a reply of the model with nothing in it back as one that says so'],
  },
  {
    name: 'sync-page-before-revision',
    fix: '7542b07',
    bug: '`sync` reads its page in its own invocation, as the database was before its wait: it misses the change',
    file: 'src/object.ts',
    old: lines(
      '      const page = (await ctx.rpc({',
      '        service: ctx.request.target.service,',
      '        key: ctx.key,',
      "        handler: 'messages',",
      '        input: request,',
      '      })) as Messages;',
    ),
    new: lines(
      "      const { page: read } = await import('./messages.ts');",
      "      const { settingsOf } = await import('./common.ts');",
      '      const page = await read(ctx.db, settingsOf(ctx as never).items as never, request);',
    ),
    tests: ['test/tools.test.ts', 'test/views.test.ts'],
    own: [],
    e2e: 'restate-tools.ts',
  },
  {
    name: 'limit-zero-reads-all',
    fix: '9643d05',
    bug: '`messages({ limit: 0 })` gives the latest messages (`slice(-0)`), not none',
    file: 'src/messages.ts',
    old: '(limit > 0 ? messages.slice(-limit) : [])',
    new: 'messages.slice(-limit)',
    tests: ALL,
    own: ['reads no messages with a limit of 0'],
  },
  {
    name: 'summarize-without-turns',
    fix: '48ce18e',
    bug: '`summarize` without the conversation of turns is taken, and each turn sends `compact` to no handler',
    file: 'src/object.ts',
    old: '  if (summarize && !items) {',
    new: '  if (false) {',
    tests: ALL,
    own: ['refuses `summarize` without the conversation of turns'],
  },
  {
    name: 'positions-taken-before-commit',
    fix: 'c73249c',
    bug: "a turn's write takes its position before it waits for the database: a framework's copy takes it too",
    file: 'src/conversation.ts',
    old: lines(
      '      await ledger.db.transaction(async (tx) => {',
      '        n = ledger.next;',
      '        added = made(n);\n',
    ),
    new: lines('      added = made(n);', '      await ledger.db.transaction(async (tx) => {\n'),
    tests: ALL,
    own: ["takes positions of its own beside a write of the turn's that waits for the copy's transaction"],
  },
  {
    name: 'answer-seq-taken-before-commit',
    fix: 'c73249c',
    bug: "a turn's answer takes its seq before it waits for the database: a framework's copy takes it too",
    file: 'src/conversation.ts',
    old: lines('        seq = ledger.seq + 1;', '        await tx.execute(ANSWER,'),
    new: '        await tx.execute(ANSWER,',
    tests: ALL,
    own: ["gives the turn's answer a seq after the copy's, when the answer waits for the copy's transaction"],
  },
  // --- #11, the follow-ups: each fix a commit of its own ---
  {
    name: 'pi-outage-ends-turn',
    fix: 'ecd0d00',
    bug: "pi gives up after 3 retries of a provider's outage, about 14 s, and ends the turn for good",
    file: 'src/pi/index.ts',
    old: '    retry: { maxRetries: Infinity, ...retry },',
    new: '    retry: { ...retry },',
    tests: PI,
    own: ["answers through a provider's outage, however many times its requests fail"],
  },
  {
    name: 'deepseek-no-compaction',
    fix: '535ee64',
    bug: "DeepSeek's input is the whole session, growing until a request overflows the model's window",
    file: 'src/deepseek/index.ts',
    old: lines(
      '  await harness.plugin(TokenMeter);',
      '  await harness.plugin(ToolResultPruner);',
      '  await harness.plugin(BasicCompactionEngine, compaction);\n',
    ),
    new: '',
    tests: DEEPSEEK,
    own: ["condenses the model's input as it nears the context window", 'condenses through a crash'],
  },
  {
    name: 'pi-tool-end-before-stored',
    fix: '08a9bd6',
    bug: "pi publishes a tool call's end as it returns, before its result is stored: a follower reads no output",
    file: 'src/pi/index.ts',
    old: '        returned.add(api.callId);',
    new: '        await toolCallEnded(ctx);',
    tests: PI,
    own: ['pi.test.ts > pi.chat publishes the conversation as a turn and its tool calls start and end'],
  },
  {
    name: 'deepseek-tool-end-before-stored',
    fix: '08a9bd6',
    bug: "DeepSeek publishes a tool call's end as it returns, before its result is stored",
    file: 'src/deepseek/index.ts',
    old: '      returned.add(exec.callId);',
    new: '      await toolCallEnded(ctx);',
    tests: DEEPSEEK,
    own: [
      'deepseek.test.ts > the DeepSeek Harness agent publishes the conversation as a turn and its tool calls start',
    ],
  },
  {
    name: 'pi-prompt-id-retried',
    fix: 'de77173',
    bug: "pi's prompt(text, id), as 0.3.0 took it, fails with a TypeError, retried forever",
    file: 'src/pi/index.ts',
    old: "    if (check !== undefined && typeof check !== 'function') {",
    new: '    if (false) {',
    tests: PI,
    own: ["fails for good, saying why, given a prompt's id"],
  },
  {
    name: 'reminder-stored',
    fix: '3573fda',
    bug: "`output`'s reminder is stored with the prompt: `messages` shows it after every message a client sends",
    file: 'src/output.ts',
    old: 'await prompt(text, asked, recheck(output), native ? undefined : reminder)',
    new: 'await prompt(native ? text : text + reminder, asked, recheck(output))',
    tests: ALL,
    own: ['is asked for after the prompt, which the conversation keeps as it was asked'],
  },
  {
    name: 'wrong-again-stored-answered',
    fix: 'db2ea3d',
    bug: '`output`: a reply still wrong after asking again fails the prompt, but its turn is stored answered with it',
    file: 'src/conversation.ts',
    old: '      check?.(answered, true);\n',
    new: '',
    tests: ALL,
    own: ['closes its turn failed when the reply asked again is not it either'],
  },
  {
    name: 'page-back-reads-to-the-end',
    fix: 'd71b790',
    bug: 'a `messages` page back reads every turn from its first to the end of the conversation',
    file: 'src/messages.ts',
    old: '  const until = before === undefined ? undefined : await one(db, `SELECT MIN(n) FROM ${TURNS} WHERE n >= ?`, [end]);',
    new: '  const until = undefined;',
    tests: ALL,
    own: ['reads a page back from its own turns, not from every turn after it'],
  },
  {
    name: 'pi-reads-whole-history',
    fix: '2b2adf5',
    bug: "pi's prompts read the window's and the budget's turns, which pi, keeping its own history, never uses",
    file: 'src/pi/index.ts',
    old: '      { check, reminder, ownHistory: true },',
    new: '      { check, reminder },',
    tests: PI,
    own: ["reads only the latest turns of a long conversation, as pi keeps the model's history"],
  },
  {
    name: 'deepseek-reads-whole-history',
    fix: '2b2adf5',
    bug: "DeepSeek's prompts read the window's and the budget's turns, which the harness never uses",
    file: 'src/deepseek/index.ts',
    old: '{ check, reminder, ownHistory: true }),',
    new: '{ check, reminder }),',
    tests: DEEPSEEK,
    own: ["reads only the latest turns of a long conversation, as the harness keeps the model's history"],
  },
  {
    name: 'langgraph-latest-reads-back',
    fix: '67a8122',
    bug: "history 'latest' reads back, and deserializes, the checkpoints a delta channel needs at every step",
    file: 'src/langgraph/checkpointer.ts',
    old: '    const ancestors = cached?.[0]?.id === latest.parent ? cached : undefined;',
    new: '    const ancestors = undefined;',
    tests: CHECKPOINTER,
    own: ['reads the checkpoints a delta channel needs from the step before'],
  },
  // --- Since (2bd66aa): what the Python SDK's measurement of access patterns found ---
  {
    name: 'lastof-scans',
    fix: '2bd66aa',
    bug: 'lastOf asks for several maxima in one SELECT per table: every turn scans both, a cold one reads the database',
    file: 'src/conversation.ts',
    old: lines(
      '  const [[turn, turnSeq, answeredSeq, step, stepSeq]] = (await db.values(',
      '    `SELECT (SELECT MAX(n) FROM ${TURNS}), (SELECT MAX(seq) FROM ${TURNS}), (SELECT MAX(answered_seq) FROM ${TURNS}), ` +',
      '      `(SELECT MAX(n) FROM ${STEPS}), (SELECT MAX(seq) FROM ${STEPS})`,',
      '  )) as unknown[][] as [[unknown, unknown, unknown, unknown, unknown]];',
    ),
    new: lines(
      '  const [[turn, turnSeq, answeredSeq]] = (await db.values(`SELECT MAX(n), MAX(seq), MAX(answered_seq) FROM ${TURNS}`)) as unknown[][] as [[unknown, unknown, unknown]];',
      '  const [[step, stepSeq]] = (await db.values(`SELECT MAX(n), MAX(seq) FROM ${STEPS}`)) as unknown[][] as [[unknown, unknown]];',
    ),
    tests: ['test/conversation.test.ts', 'test/messages.test.ts', 'test/turns.test.ts'],
    own: ['the last position and seq are read from the ends of the tables, without a scan'],
  },
  // --- The port of the Python SDK's later work: each fix a commit of its own ---
  {
    name: 'unreadable-row-retried',
    fix: '9d49193',
    bug: "a row the agent's framework cannot load (another framework's) fails with the framework's error, retried forever",
    file: 'src/conversation.ts',
    old: lines('  try {', '    return items.load(stored);', '  } catch (error) {'),
    new: lines('  try {', '    return items.load(stored);', '  } catch (error) {', '    if (error) throw error;'),
    tests: ['test/conversation.test.ts', 'test/items.test.ts'],
    own: ['fails for good: a retry would read the same row', 'is the error of loadItem, whatever the framework throws'],
  },
  {
    name: 'claude-loads-any-row',
    fix: '9d49193',
    bug: "Claude's load takes another framework's row with a role and content (DeepSeek's) for a message of its own",
    file: 'src/claude/index.ts',
    old: lines(
      '    if (Object.keys(rest).length > 0)',
      "      throw new Error(`not a message of the Claude API: ${Object.keys(rest).join(', ')}`);",
      '',
    ),
    new: '',
    tests: ['test/items.test.ts', ...CLAUDE],
    own: ["claude fails for good on deepseek's rows"],
  },
  {
    name: 'pi-loads-any-row',
    fix: '9d49193',
    bug: "pi's load takes another framework's row, which fails later with a TypeError, retried forever",
    file: 'src/pi/index.ts',
    old: lines(
      "    if (typeof message !== 'object' || message === null || typeof message.role !== 'string')",
      '      throw new Error("not a pi item (a pi-ai message, with its entry\'s id)");',
      "    if (Object.keys(rest).length > 0 || (entry !== undefined && typeof entry !== 'number'))",
      "      throw new Error(`not a pi item: ${Object.keys(item).join(', ')}`);",
      '',
    ),
    new: '',
    tests: ['test/items.test.ts', ...PI],
    own: ["pi fails for good on claude's rows", "pi fails for good on langgraph's rows"],
  },
  {
    name: 'deepseek-loads-any-row',
    fix: '9d49193',
    bug: "DeepSeek's load takes another framework's row: LangGraph's and pi's are read as empty messages",
    file: 'src/deepseek/index.ts',
    old: lines(
      "    if (typeof m.id !== 'string' || typeof m.role !== 'string' || !Array.isArray(m.content))",
      '      throw new Error("not a DeepSeek harness\'s message (an id, a role and a list of content parts)");',
      '',
    ),
    new: '',
    tests: ['test/items.test.ts', ...DEEPSEEK],
    own: ["deepseek fails for good on langgraph's rows", "deepseek fails for good on pi's rows"],
  },
  {
    name: 'langgraph-invalid-update-retried',
    fix: '8a389b5',
    bug: "a graph run that failed with LangGraph's InvalidUpdateError is retried, to the same update, forever",
    file: 'src/langgraph/errors.ts',
    old: "  else if (error instanceof InvalidUpdateError) why = 'the graph made an invalid state update';\n",
    new: '',
    tests: ['test/langgraph.test.ts', 'test/langgraph-graph.test.ts'],
    own: ["ends a turn on LangGraph's own errors, which a retry would meet again"],
  },
  {
    name: 'graph-run-unnamed',
    fix: '0ef2c47',
    bug: "a graph's checkpoints do not name their run's prompt (LangGraph's JavaScript loop drops config metadata): a retried attempt starts the run again",
    file: 'src/langgraph/graph.ts',
    old: '  const saver = new SqlCheckpointSaver(ctx.db, { metadata: { [PROMPT]: promptId, [STRUCTURED_BEFORE]: before } });',
    new: '  const saver = new SqlCheckpointSaver(ctx.db);',
    tests: ['test/langgraph-graph.test.ts'],
    own: ['resumes a run a crash cut off from its last checkpoint', 'joins the same wait in a retried attempt'],
  },
  {
    name: 'graph-interrupts-share-a-wait',
    fix: '0ef2c47',
    bug: "a node's second interrupt() has its first's id, and gets the first's answer without a wait of its own",
    file: 'src/langgraph/graph.ts',
    old: '      const waitId = `${ctx.request.id}:interrupt:${id}:${resumes}`;',
    new: '      const waitId = `${ctx.request.id}:interrupt:${id}`;',
    tests: ['test/langgraph-graph.test.ts'],
    own: ['waits anew for each interrupt() of a node that interrupts twice'],
  },
  {
    name: 'approval-asked-again-after-crash',
    fix: '70cc121',
    bug: "DeepSeek's call made again after a crash, under a new id, opens a wait of its own: the person is asked twice",
    file: 'src/deepseek/index.ts',
    old: '{ approval: true, rejoin: true }',
    new: '{ approval: true }',
    tests: DEEPSEEK,
    own: ['waits for an approval through a crash: the person is asked once'],
  },
  {
    name: 'approval-is-a-done-call',
    fix: 'd710936',
    bug: "DeepSeek's approval is taken for its call's outcome: a turn cancelled while the approved tool runs reports it done",
    file: 'src/deepseek/index.ts',
    old: '{ approval: true, rejoin: true }',
    new: '{ rejoin: true }',
    tests: DEEPSEEK,
    own: ['ends a turn cancelled while an approved tool runs with the call cancelled, not done'],
  },
  // --- Durability: the Python SDK's mutants of no fix that apply here (docs/plan.md, "Past bugs") ---
  {
    name: 'calls-new-id-not-matched',
    fix: '',
    bug: 'a Restate call cut off by a crash and asked again under a new call id is made again',
    file: 'src/calls.ts',
    old: '(rejoin ? ours.find((c) => c.attempt !== attempt.id && c.tool === tool && c.input === json) : undefined)',
    new: 'undefined',
    tests: ALL,
    own: ['rejoin, for a Restate tool, the call another attempt made with the same input, under a new id'],
  },
  {
    name: 'calls-settled-early',
    fix: '',
    bug: 'a returned call is forgotten before its result is stored: asked again under a new id after a crash, it is made again',
    file: 'src/conversation.ts',
    old: '    return result !== undefined && (!failed(result) || result.output === failedWith);',
    new: '    return true;',
    tests: ALL,
    own: ['keep a returned call until its result is stored, and forget it once it is'],
  },
  {
    name: 'calls-never-settled',
    fix: '',
    bug: "a call's record is never forgotten once its result is stored: the key's state grows with every call",
    file: 'src/conversation.ts',
    old: '    return result !== undefined && (!failed(result) || result.output === failedWith);',
    new: '    return false;',
    tests: ALL,
    own: ['keep a returned call until its result is stored, and forget it once it is'],
  },
  {
    name: 'claude-reask-stored-reply',
    fix: '',
    bug: 'after a crash, Claude is asked again for a final reply that was stored',
    file: 'src/claude/index.ts',
    old: lines(
      '      const final = turn.finalReply();',
      '      if (final !== undefined) return final;',
      '      const { tools, check }',
    ),
    new: '      const { tools, check }',
    tests: CLAUDE,
    own: ['claude.test.ts > the Claude agent answers a stored final reply without asking the model again'],
  },
  {
    name: 'langgraph-reask-stored-reply',
    fix: '',
    bug: "after a crash, LangGraph's model is asked again for a final reply that was stored",
    file: 'src/langgraph/index.ts',
    old: lines('    const final = turn.finalReply();', '    if (final !== undefined) return final;', '    const app ='),
    new: '    const app =',
    tests: LANGGRAPH,
    own: ['langgraph.test.ts > the LangGraph agent answers a stored final reply without asking the model again'],
  },
];

/** The child process running, to stop with the run. */
let running: ChildProcess | undefined;

/** Run `args` (in `cwd`) to its end, or for `timeout` ms at most: its exit code, or `undefined` if it timed out. */
function run(args: string[], cwd: string, timeout: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    // A process group of its own: a timeout stops the workers it started too.
    const child = spawn(process.execPath, args, { cwd, stdio: 'ignore', detached: true });
    running = child;
    const timer = setTimeout(() => {
      stop(child);
      resolve(undefined);
    }, timeout);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      running = undefined;
      resolve(code ?? 1);
    });
  });
}

function stop(child: ChildProcess) {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Ended already.
  }
}

interface Report {
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { fullName: string; status: string }[];
  }[];
}

/** Run the tests of `files` (every one, if none): the tests that failed, each as `file > full name`; `undefined` if the run timed out. */
async function failures(files: string[], timeout: number): Promise<Set<string> | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'resurrect-'));
  try {
    const report = join(dir, 'report.json');
    const code = await run([VITEST, 'run', ...files, '--reporter=json', `--outputFile=${report}`], PACKAGE, timeout);
    if (code === undefined) return undefined;
    if (!existsSync(report)) return new Set(['<the run did not report>']);
    const { testResults } = JSON.parse(readFileSync(report, 'utf8')) as Report;
    const failed = new Set<string>();
    for (const file of testResults) {
      const name = relative(PACKAGE, file.name);
      const tests = file.assertionResults.filter((t) => t.status === 'failed');
      for (const test of tests) failed.add(`${name} > ${test.fullName}`);
      // A file that failed outside its tests (it did not load, say).
      if (file.status === 'failed' && tests.length === 0) failed.add(`${name} > <the file failed>`);
    }
    return failed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the e2e script `script`: whether it failed, or `undefined` if it timed out. */
async function e2eFails(script: string, timeout: number): Promise<boolean | undefined> {
  const code = await run([script], E2E, timeout);
  return code === undefined ? undefined : code !== 0;
}

/** The file a mutant changes, and its text before: restored after each mutant, and if the run is stopped. */
let applied: { path: string; original: string } | undefined;

function restore() {
  if (applied === undefined) return;
  writeFileSync(applied.path, applied.original);
  applied = undefined;
}

process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (running) stop(running);
    restore();
    console.error(`\nstopped (${signal}): the code is restored`);
    process.exit(130);
  });
}

function occurrences(text: string, of: string) {
  let count = 0;
  for (let at = text.indexOf(of); at !== -1; at = text.indexOf(of, at + of.length)) count += 1;
  return count;
}

const seconds = (since: number) => `${Math.round((performance.now() - since) / 1000)}s`;

type Verdict = 'killed' | 'not by its own' | 'SURVIVED' | 'hung' | 'skipped';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const timeoutAt = args.indexOf('--timeout');
  const timeout = timeoutAt === -1 ? 900_000 : Number(args[timeoutAt + 1]) * 1000;
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--timeout');
  const unknown = names.filter((name) => !MUTANTS.some((m) => m.name === name));
  if (flag('--list') || unknown.length > 0) {
    for (const m of MUTANTS)
      console.log(`${m.name.padEnd(34)} ${(m.fix || '-').padEnd(7)}${m.e2e ? ' e2e' : '    '} ${m.bug}`);
    if (unknown.length > 0) console.error(`no mutant ${unknown.join(', ')}`);
    return unknown.length > 0 ? 1 : 0;
  }
  const chosen = MUTANTS.filter((m) => names.length === 0 || names.includes(m.name));

  // Each edit must find its text exactly once, or the mutant no longer matches the code.
  const stale = chosen.flatMap((m) => {
    const count = occurrences(readFileSync(join(PACKAGE, m.file), 'utf8'), m.old);
    return count === 1 ? [] : [`${m.name}: its text is found ${count} times in ${m.file}; update the mutant`];
  });
  for (const line of stale) console.error(line);
  if (stale.length > 0) return 1;
  if (flag('--check')) {
    console.log(`${chosen.length} mutants, each text found once`);
    return 0;
  }

  const unit = flag('--unit');
  const runs = chosen.filter((m) => !(unit && m.e2e));
  const files = runs.some((m) => m.tests.length === 0) ? [] : [...new Set(runs.flatMap((m) => m.tests))].toSorted();
  let started = performance.now();
  console.log(`baseline: ${files.length === 0 ? 'every test file' : `${files.length} test files`} ...`);
  const baseline = await failures(files, timeout);
  if (baseline === undefined) {
    // Without a baseline, every test that fails anyway would count against each mutant.
    console.error(`baseline: timed out after ${timeout / 1000}s; raise --timeout`);
    return 1;
  }
  console.log(`baseline: ${baseline.size} failing, left out (${seconds(started)})`);
  for (const name of [...baseline].toSorted()) console.log(`  ${name}`);
  for (const script of new Set(runs.flatMap((m) => (m.e2e ? [m.e2e] : [])))) {
    started = performance.now();
    if ((await e2eFails(script, timeout)) !== false) {
      console.error(`baseline: e2e ${script} does not pass without a mutant; or run with --unit`);
      return 1;
    }
    console.log(`baseline: e2e ${script} passes (${seconds(started)})`);
  }

  const rows: { m: Mutant; verdict: Verdict; others: number }[] = [];
  for (const m of chosen) {
    if (unit && m.e2e) {
      rows.push({ m, verdict: 'skipped', others: 0 });
      console.log(`${m.name}: skipped (e2e)`);
      continue;
    }
    const path = join(PACKAGE, m.file);
    const original = readFileSync(path, 'utf8');
    started = performance.now();
    let failed: Set<string> | undefined;
    let e2e: boolean | undefined = false;
    try {
      applied = { path, original };
      writeFileSync(
        path,
        original.replace(m.old, () => m.new),
      );
      failed = await failures(m.tests, timeout);
      if (m.e2e && failed !== undefined) e2e = await e2eFails(m.e2e, timeout);
    } finally {
      restore();
    }
    const seen = failed === undefined ? [] : [...failed].filter((name) => !baseline.has(name)).toSorted();
    const own = seen.filter((name) => m.own.some((test) => name.includes(test)));
    const others = seen.length - own.length;
    const killed = own.length > 0 || e2e === true;
    const verdict: Verdict =
      failed === undefined || e2e === undefined
        ? 'hung'
        : killed
          ? 'killed'
          : seen.length > 0
            ? 'not by its own'
            : 'SURVIVED';
    rows.push({ m, verdict, others });
    const by = m.e2e && e2e ? `e2e ${m.e2e}` : `${own.length} of its own`;
    const detail =
      verdict === 'killed' ? `by ${by}${others > 0 ? ` and ${others} more` : ''}` : `${seen.length} failing`;
    console.log(`${m.name}: ${verdict}, ${detail} (${seconds(started)})`);
    for (const name of seen) console.log(`    ${name}`);
  }

  console.log('\n| Mutant | Fix | Bug brought back | Verdict |\n| --- | --- | --- | --- |');
  for (const { m, verdict, others } of rows) {
    const also = verdict === 'killed' && others > 0 ? `, and ${others} more` : '';
    console.log(`| \`${m.name}\` | ${m.fix || 'durability'} | ${m.bug} | ${verdict}${also} |`);
  }
  const bad = rows.filter((r) => r.verdict === 'SURVIVED' || r.verdict === 'not by its own');
  for (const { m, verdict } of bad) console.error(`${m.name}: ${verdict}`);
  return bad.length > 0 ? 1 : 0;
}

process.exitCode = await main();
