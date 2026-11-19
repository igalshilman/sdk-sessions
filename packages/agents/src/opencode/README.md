# OpenCode

[OpenCode](https://opencode.ai) 2.2 can run embedded: `@opencode/sdk` hosts
the whole OpenCode server in your process, with no HTTP listener. Here it
runs in the agent's virtual object, and OpenCode's database (its session,
messages, inbox and events) is an SQL database of the key's own, in the
object's state beside `ctx.db` (`database` of @restatedev/sessions): OpenCode
boots only on a database that is empty or its own, so its tables are alone
there, and `ctx.db` keeps the conversation of turns and the tables of yours
([SQL in Restate virtual objects](../../../sessions/README.md)). The
integration pins OpenCode 2.2.6 exactly (`@opencode/core`, `sdk`, `server`
and `plugin`), with the Effect release it is built on (4.1.0); OpenCode
needs Node 24.

## Use

```ts
import { serve } from '@restatedev/agents';
import * as opencode from '@restatedev/agents/opencode';

const coder = opencode.agent({ name: 'coder', workspace: (ctx) => `/work/${ctx.key}` });
await serve(coder);
```

| Option      | What                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`     | `provider/model-id`, of any provider OpenCode serves; or else `MODEL`, or else `openai/gpt-6-sol` (`OPENAI_API_KEY`). A key's session keeps the model it was created with (see [Not yet](#not-yet))                                                                                |
| `system`    | Added to OpenCode's own system prompt, on each model request                                                                                                                                                                                                                       |
| `tools`     | `tool()`s and Restate's tools of `@restatedev/agents`, or OpenCode tools of your own (`OpenCodeTool`: `execute(input, callId)`)                                                                                                                                                    |
| `output`    | A zod object: the answer as data, which the agent replies with as JSON, and `chat` answers with (see [Structured answers](../../README.md#structured-answers))                                                                                                                     |
| `workspace` | A directory of the local machine, made if missing, for OpenCode's own tools (read, write, edit, shell, glob, grep...), or a function of the context that gives one (`(ctx) => \`/work/${ctx.key}\``); use a sandbox. Without one, the agent has only `tools`                       |
| `plugins`   | OpenCode plugins of your own (`@opencode/plugin`)                                                                                                                                                                                                                                  |
| `retry`     | How OpenCode asks the model again after a request failed for a reason that passes (an outage, a rate limit), as pi's `retry`: by default without limit, 2 s to a minute apart (`baseDelayMs`, `maxAgentDelayMs`, `maxRetries`, `enabled`; see [Through crashes](#through-crashes)) |
| `approval`  | With a workspace, `true` has what OpenCode's permission rules ask about wait for a person's approval, the signal `approval`; without it, such an ask is denied ([Permissions](#permissions))                                                                                       |

With a workspace, OpenCode's tools of background work are left out: its
subagent and question tools are removed, and its shell runs a command in
the tool call, never as a background job (one asked for is refused, and the
model told to run it in the foreground). Restate's `subagent` tool is the
way to delegate: its calls are made once.

For a session object of your own, `opencode.chat(options)` is the handler and
`opencode.messages()` the view (with it, the agent's `clear` empties
OpenCode's database too); `options` may be a function of the invocation's
context, such as a directory for each key:

```ts
chat: opencode.chat((ctx) => ({ workspace: `/work/${ctx.key}` })),
```

`opencode.prompt(ctx, text, options)` answers a prompt in a handler of your
own. For more than a prompt, `withOpenCode(ctx, options, work)` runs `work`
with OpenCode: `prompt(text)` answers a prompt once, and `host()` boots
OpenCode (once) and gives its client.

## Through crashes

[`db.ts`](db.ts) (`@restatedev/agents/opencode/db`) boots OpenCode's embedded
host on its database: an Effect `SqlClient` through
`Database.configuredClient`, OpenCode's seam for an injected client, each
OpenCode transaction an SQL transaction. The handler is not replayed: a
retried attempt boots OpenCode again, on the stored database. OpenCode
records an execution claim when a turn starts, and every boot sweeps the
claims left behind. Whose claim it is comes from `ctx.db`: the prompt last
submitted to OpenCode is recorded there before it is submitted
(`restate_agents_opencode`). So:

- **A message is answered once per invocation** (`answerOnce`): the prompt's
  id is its OpenCode message id (`msg_<id>`), and a retried attempt of an
  answered prompt returns its answer without booting OpenCode. So does one
  whose turn holds its final reply, copied before the attempt died. A
  retried attempt of the recorded prompt boots OpenCode twice: first
  without its sweep, to copy what OpenCode stored of the turn; a final
  reply stored before the attempt died (before its copy, or before
  OpenCode's turn ended) is then the answer, and the second boot closes
  OpenCode's claim without the model, rather than resume the turn, which
  would ask it again; without one, the second boot resumes the turn.
- **A tool runs only once its call is stored.** OpenCode stores the model's
  reply, with its tool calls, before the tools run.
- **A crashed attempt's turn goes on.** A boot for the recorded prompt
  resumes its turn, as OpenCode does: a tool call that was running gets an
  "interrupted" result, and the model makes it again under a new id. OpenCode
  gives up on a turn after ten resumes; here the object's retry policy
  decides. A tool that must not run twice needs a way for a retry to name
  the call it retries (the bank agent's `transfer` takes `retryOf`).
  Restate's own tools (`call`, `send`, `workflow`, `subagent`, `signal`)
  need none: made again with the same input, the call is the one the
  cut-off call made.
- **A tool's error fails the attempt**, and Restate retries it; a
  `restate.TerminalError` of a `@restatedev/agents` tool is its answer to the
  model. The failed attempt stores nothing more, so its retry finds the call
  interrupted, as above.
- **A killed invocation's turn is closed, never finished.** A boot for any
  other prompt (the next message, or the companion's `settle`) closes the
  claim without asking the model, through OpenCode's own resume budget
  (`maxAttempts: 0`), and waits for that before anything is submitted; then
  the turn's copy catches up, and the conversation closes the turn
  (`ended`). The next prompt tells the model how the turn before it ended,
  and which of its calls did happen (OpenCode's history says only that they
  were interrupted). A final reply OpenCode stored before the kill is kept
  in the turn, then its `Ended` note. A prompt killed once OpenCode queued
  it, before its turn began, never runs: what waits in OpenCode's inbox is
  cancelled.
- **A stopped turn** (`stop`) is interrupted in OpenCode, and closed
  cancelled, also when a tool's error ended the attempt as it stopped;
  the next prompt tells the model.
- **A provider's outage never ends the turn.** OpenCode asks the model
  again as its `session.retry` hook decides, with pi's backoff (`retry`):
  2 s after the first failure, twice as long each time, a minute apart at
  most, but never before the provider's `retry-after` (up to 15 minutes, as
  OpenCode takes it, which `maxAgentDelayMs` does not shorten). Unlike pi,
  OpenCode retries a step 10 times at most, and not after its 4th timeout:
  an outage it would retry for the last time, or no longer retries, fails
  the attempt instead (not terminal), as a tool's error does, and the next
  attempt resumes the turn, its retries afresh. With a finite `maxRetries`,
  a failure past that many retries of a step ends the turn instead, as
  does one OpenCode no longer retries; `enabled: false` retries nothing.
- **A refused prompt** (a wrong API key, an unknown model) is never asked
  again: it fails at once with a terminal error, 424, and closes its turn;
  any other turn OpenCode ends unanswered fails with a terminal error.

OpenCode keeps its own history, and compacts it itself: `window`, `budget`
and summaries do not apply. What OpenCode stores of a turn (the model's
replies, the tools' results) is copied into the turn after each of
OpenCode's commits, in a `ctx.db` transaction of its own, by OpenCode's
message and part ids, so a copy a crash missed is caught up, before a tool
call runs, the answer, and any close of the turn. A copy of a reply with
tool calls, or of tools' results, is published once it is committed, in a
`chat` turn (a `prompt()` in a handler of your own publishes nothing), and
nothing else is: a tool call's start publishes nothing. That is what `messages`
shows ([docs/conversation.md](../../docs/conversation.md)); OpenCode's own
"Continue" after a restart, its idle markers and its compactions are not
copied. A reply with tool calls is copied as its stream ends, before the
calls run; one without, once OpenCode stored how its step ended, and never
if the step failed or the model's output limit cut it off (OpenCode asks
the model again, or to go on). A step a crash left without its end is
never a reply either: a retry of such a turn resumes it, and the model is
asked again. The two databases share no transaction: a follower may see a
step late after a crash, never the model.

**A message steered to the turn** (`steer`) is submitted to OpenCode as a
tool call of a round returns, as a steered prompt (`delivery: 'steer'`,
once, by its id), which OpenCode places at the round's next step, after its
results; the copy stores it in the turn, in its place. One sent while the
model writes its final answer is answered as a turn of its own. One
OpenCode placed as the turn was stopped is the stopped turn's: the turn
holds it, and it is not answered again as a turn of its own.

The files of a `workspace` are not in the database: they last as long as the
disk does.

## Permissions

With a workspace, OpenCode's permission rules allow its tools everything
but a few asks (by default, a read of a `*.env` file). OpenCode alone would
keep an ask in memory, waiting for a reply nothing gives, and its turn
would never end. Here each ask is settled through OpenCode's
`permission.evaluate` hook:

- **Without `approval`**, it is denied, as OpenCode denies an ask nobody is
  present for: the model gets the denial as the tool's error. So is an ask
  of no tool call, with `approval` too.
- **With `approval: true`**, the tool call waits for the signal `approval`
  (`opencode.APPROVAL`) to the agent, as a `signal()` tool waits
  ([Signals](../../README.md#signals)). `pending` shows the wait with the
  call's tool and arguments, and the permission asked (`action`,
  `resources`). `true`, `{"approved": true}`, or a text such as `approved`,
  `yes` or `ok` allows the call; anything else denies it, and the model is
  told why (`The user denied tool "shell": <the text, or the reason>`).

```ts
opencode.agent({ name: 'coder', workspace: (ctx) => `/work/${ctx.key}`, approval: true });
```

The wait outlasts a crash, or a suspension: the resumed turn gives the call
OpenCode's "interrupted" result, the model makes it again under a new id,
and the call, with the same tool and arguments, joins the wait. The person
is asked once, and the tool runs once, after the decision. A turn stopped
while the call waits ends cancelled, and the tool never runs.

The wait is the tool call's: a call that asks more than once (a directory,
then the file) has each ask answered by the first's answer. OpenCode's hook
does not tell an ask from a probe (an edit's hint on a miss), so a probe
that would ask waits too.

## Keeping alive

Restate shuts an attempt down after its inactivity timeout (a minute) and starts it again, unless
something keeps it alive. The adapter keeps it alive (`ctx.working`) while OpenCode's turn runs:
while the model streams its requests, and while OpenCode's own tools (shell, read, write, edit,
glob, grep) work on the machine, a command that runs for minutes included. But not:

- while a tool of your own runs, unless it says so itself (`tool({ keepalive: true })`): it may
  wait on Restate (a call, a signal), and such a wait suspends.
- while it waits for an approval, even of the shell: a wait on Restate suspends.

OpenCode has no hook at the end of a model's request, so this is the turn's scope with a gap for
each tool that runs (tools may overlap: the scope reopens once none runs). A request OpenCode
makes outside a turn (a session's title, say) is not kept alive.

## Not yet

- **A change of `model`** for a key that has a session already: the session
  keeps the model it was created with.

## Notes

- **Embedded.** OpenCode runs in the handler's own process, on OpenCode's
  workerd profile (the one it boots in a Cloudflare Durable Object), with
  the object's database for its own. Without a `workspace` it has no
  filesystem, shell or terminal; with one, its own tools run on the local
  machine. The only other traffic out is the model's, to its provider's API.
- **Boots lazily**: OpenCode boots as a turn runs, once per attempt.
  Booting takes about 100 ms, after a one-time import of about 2 s per
  process; a prompt makes some hundreds of SQL statements.
- **A turn that neither runs nor ends** for 5 s fails the attempt: the
  retry boots OpenCode again, which resumes it.

## Run

```sh
cd packages/examples && OPENAI_API_KEY=… node basic/opencode.ts
```

With a Restate server, and the agent registered with it: see
[Run an example](../../../examples/README.md#run-an-example).
[`examples/advanced/foreman`](../../../examples/advanced/foreman/README.md) has
OpenCode agents, a worker and a senior with a workspace and a reviewer
without one, under a pi boss.

## Tests

The tests run on a scripted model, [`test/fakes/opencode.ts`](../../test/fakes/opencode.ts),
an AI SDK language model that OpenCode calls through a plugin's `language`
hook, and makes a fresh tool call id for every call
(`pnpm --filter @restatedev/agents test opencode`, from the repository root,
on Node 24: on older Node the suites are skipped):

- [`test/opencode.test.ts`](../../test/opencode.test.ts):
  each point above, with crashes that stop an attempt in a tool call, or
  at any of its state requests, and kills, at a turn's end too; a stop, a
  refusal, an outage, asking again for `output`, the system prompt,
  `messages`, `clear`, steering, and permission asks, denied or approved.
- [`test/opencode-spike.test.ts`](../../test/opencode-spike.test.ts): `db.ts`
  alone, a killed turn closed at boot without the model (by OpenCode's
  budget, or by a closer of our own), and a crashed one resumed.
- [`test/opencode.ts`](../../test/opencode.ts): the bank agent, through
  crashes and kills in [the crash test](../../../e2e/crash.ts)
  (`pnpm --filter e2e crash`).
