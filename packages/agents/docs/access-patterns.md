# Access patterns: what a conversation asks of Restate

What a conversation of turns ([The conversation](conversation.md)) asks of
Restate state, turn after turn: what a turn reads and writes, warm and in a
new process, and what a client following the conversation reads. Measured
with [`scripts/access-patterns.ts`](../scripts/access-patterns.ts), a port
of the Python SDK's `scripts/access_patterns.py`. Both SDKs store a key's
database the same way (sdk-shared-core's state layer) in the same tables, so
the Python SDK's
[`access-patterns.md`](https://github.com/restatedev/sdk-python/blob/9ec3c6076db8a6b96cd84c74d481aa1644c88c97/docs/agents/access-patterns.md)
explains these numbers too: how a commit, a checkpoint and a cold open meet
Restate's state, and why a cold turn's reads spread over the file. The
numbers here are within a few percent of its.

## The method

The script answers prompts through `answerOnce` with the tests' made-up
framework ([`test/fakes/items.ts`](../test/fakes/items.ts)) over the tests'
attempt of a handler ([`test/support.ts`](../test/support.ts)), whose
object's state is a map that it meters: each `get` (and the round trips:
the gets issued together), `set`, `clear` and sync, by the storage's kind
of key (head, tail entry, manifest, pack). It meters each SQL statement too,
with the rows it read and the gets made while it ran.

- **A turn** is a prompt (150 characters), a reply with 2 tool calls, their
  results (1,500 characters each) and an answer (600 characters), in random
  words about as compressible as prose. Invocation ids, and so prompt ids,
  are as random as Restate's.
- **Warm:** every turn in one process, as a key that the same process
  answers turn after turn. After each, a client reads what changed (the
  `messages` view from its cursor).
- **Cold:** the turn after each of `--cold-at`'s, in a new process (its
  page cache empty), as a key's first invocation there; and a client
  reading that turn, the latest, from the cursor before it, the same way.
- The agent's defaults: `window` 1, `budget` 32,000, no summaries.

Not covered: the companion (`signals`), the call records (no tool here
makes Restate calls), and a real server (whether it sends a key's whole
state with each invocation).

## A default run

`node scripts/access-patterns.ts` (200 turns, cold after 10, 50, 100 and
200), on `2bd66aa`. Under a cold row, the statements whose gets read the
most (`open`: the gets before the first statement, the open and the
schema's record):

```
200 turns: ask, warm
 turn       gets     rounds   getBytes       sets   setBytes      syncs statements       rows   rowBytes  modelItems storedBytes
    1          1          1          0         16       4333          8         19          1          0            1        4172
    2          1          1         27         12       5130          6         12          6       4914            6        9125
   11          1          1         78         12       3711          6         12         15      12558           24       47211
   51          3          2        738         14      50873          7         12         55      46486          104      185227
  101          1          1        224         12       4834          6         13        105      88926          204      293181
  200          3          2       1528         14      58834          7         14        197     167073          344      508608
  sum        220        210      50741       2428    1377030       1212       2615      20868   17672502

200 turns: ask, cold (a new process)
 turn       gets     rounds   getBytes       sets   setBytes      syncs statements       rows   rowBytes  modelItems storedBytes
   11         10          3      27450         12       3712          6         12         15      12558           24       47212
        10 gets     27450 bytes  open
   51        131          6     135968         14      50886          7         12         55      46486          104      185235
       127 gets    104235 bytes  open
         2 gets     31242 bytes  SELECT n, prompt, item, status, answer, agent, carried, answered_at, answered_seq, asked_at FROM restate_agent_turns WHERE n >= ? AND n < ? ORDER BY n DESC LIMI
         2 gets       491 bytes  INSERT INTO restate_agent_turns (n, seq, prompt, item, asked_at) VALUES (?, ?, ?, ?, ?)
  101         52          8     218063         12       4826          6         13        105      88926          204      293173
         4 gets    103620 bytes  SELECT n, prompt, item, status, answer, agent, carried, answered_at, answered_seq, asked_at FROM restate_agent_turns WHERE n >= ? AND n < ? ORDER BY n DESC LIMI
        47 gets     70323 bytes  open
         1 gets     44120 bytes  SELECT n, seq, summary, summarized FROM restate_agent_conversation_start
  201         16         11     422899         12       4599          6         14        197     167067          344      512100
         6 gets    224942 bytes  SELECT n, prompt, item, status, answer, agent, carried, answered_at, answered_seq, asked_at FROM restate_agent_turns WHERE n >= ? AND n < ? ORDER BY n DESC LIMI
         8 gets    102544 bytes  open
         1 gets     50285 bytes  SELECT answer, status FROM restate_agent_turns WHERE prompt = ?

200 turns: follow, warm
 turn       gets     rounds   getBytes       sets   setBytes      syncs statements       rows   rowBytes
    1          9          2       4172          0          0          0          8          8       4290
    2         15          2       9125          0          0          0          6          7       4249
   11         13          2       6439          0          0          0          6          7       4251
   51          7          2       3418          0          0          0          6          7       4243
  101         51          2      27778          0          0          0          6          7       4254
  200          5          2       2639          0          0          0          6          7       4255
  sum      12038        400    6636662          0          0          0       1202       1401     850465

200 turns: follow, cold (a new process)
 turn       gets     rounds   getBytes       sets   setBytes      syncs statements       rows   rowBytes
   10         10          3      27450          0          0          0          6          7       4262
        10 gets     27450 bytes  open
   50        127          3     104235          0          0          0          6          7       4253
       127 gets    104235 bytes  open
  100         48          4     114443          0          0          0          6          7       4256
        47 gets     70323 bytes  open
         1 gets     44120 bytes  SELECT n, seq, summary, summarized FROM restate_agent_conversation_start
  200          9          4     147672          0          0          0          6          7       4255
         8 gets    102544 bytes  open
         1 gets     45128 bytes  SELECT n, seq, summary, summarized FROM restate_agent_conversation_start
```

What it shows:

- **A turn commits 6 times:** its prompt, the model's reply, each tool's
  result, the answer's reply, and the answer. Each commit writes a tail
  entry and the head, and syncs: 12 state writes and about 7 KB a turn;
  now and then a commit checkpoints too (a pack and a manifest, turns 51
  and 200 above).
- **A warm turn reads one get, the head** (three in a turn that
  checkpoints), and its SQL reads a bounded part of the conversation: 197
  rows (167 KB), and 344 items for the model, from turn 200 on, however
  long the conversation grows (the same at turn 1,000).
- **A cold turn reads its open and the pack parts its SQL touches.** The
  open gets the head, the manifest and each tail entry since the last
  checkpoint (127 after turn 50); then the transcript's page dominates
  (225 KB of 423 KB after turn 200), as the turns' rows are spread among
  their steps in the file.
- **A follower pays an open at every call:** a view never reuses the
  process's state of the key, so each of the 200 warm calls above gets the
  head, the manifest and the tail entries again (60 gets, 33 KB a call on
  average). Cold, it is mostly the open.

A rerun gives the same gets, round trips, statements and rows, and bytes
within a fraction of a percent (the names of packs are random).

## `lastOf`, before and after its fix

`lastOf` (the last position and seq, read at every turn and by the latest
page of `messages`) asked for its maxima in one `SELECT` per table: a
`SELECT` of several aggregates scans its table, which in a new process
reads the whole database. `2bd66aa` asks for each in a scalar subquery of
its own, which reads the end of its b-tree. The cold turn after turn _n_,
1,000 turns measured on `1371e59` (before) and `2bd66aa` (after):

|  Turn | Before           | After      | `lastOf`'s reads, before | after          |
| ----: | ---------------- | ---------- | ------------------------ | -------------- |
|   101 | 218 KB, 8 rounds | 218 KB, 8  | 4 gets, 104 KB           | none           |
|   501 | 1.18 MB, 26      | 546 KB, 11 | 21 gets, 943 KB          | 1 get, 54 KB   |
| 1,001 | 2.67 MB, 52      | 865 KB, 16 | 48 gets, 2.39 MB         | 3 gets, 142 KB |

After turn 100 the cold turn reads the same pages either way: those the scan
read are those the transcript's first page reads, after the fix by itself.
From there on the scan reads more of the file with every turn; the
fix takes 68% of the bytes and 69% of the round trips off the cold turn
after turn 1,000. Its test (`test/conversation.test.ts`, "the last
position and seq are read from the ends of the tables, without a scan")
counts the pack parts `lastOf` reads, and the mutant `lastof-scans` of
[Testing](testing.md) brings the scan back.

## Reproducing

From `packages/agents`; a run of 1,000 turns takes about two minutes:

```sh
node scripts/access-patterns.ts                     # the default run above
node scripts/access-patterns.ts --turns 1000 --cold-at 100,500,1000 --json > after.jsonl
# The same of another checkout, with this one's dependencies (its node_modules linked):
node scripts/access-patterns.ts --tree ../before --turns 1000 --cold-at 100,500,1000 --json > before.jsonl
node scripts/access-patterns.ts --report before.jsonl after.jsonl
# A statement alone, in a new process after turn 500: what it reads beyond the open.
node scripts/access-patterns.ts --turns 500 --cold-at 500 --probe "SELECT COUNT(*) FROM restate_agent_items"
```

`--calls` and `--result` set a turn's tool calls and their size,
`--window` and `--budget` the agent's; `RESTATE_SQL_CACHE=off` measures
without a page cache.
