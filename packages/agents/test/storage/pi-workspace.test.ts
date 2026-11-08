// withPi over an SQL database in memory, without a Restate server: the
// coding tools of a workspace write to the local file system.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { describe, expect, it } from 'vitest';
import { sqlAttempt } from '@restatedev/sessions/test/support';
import { callTools, fakeProvider, say } from '../fakes/pi.ts';
import { withPi } from '@restatedev/agents/pi';

describe('withPi', () => {
  it('gives a workspace the coding tools, over the local file system', async () => {
    const root = await mkdtemp(join(tmpdir(), 'with-pi-'));
    const workspace = join(root, 'Assistant', 'acme.alice');
    const models = createModels();
    models.setProvider(
      fakeProvider('scribe', 'scribe', (context) => {
        const last = context.messages.at(-1)!;
        if (last.role === 'toolResult') return say(last.isError ? 'failed' : 'written');
        return callTools([['write', { path: 'notes.md', content: 'crushed' }]]);
      }),
    );
    try {
      // An attempt over a key of its own: the log starts afresh.
      const attempt = sqlAttempt({ map: new Map(), id: 'inv' });
      const { answer, agent } = await attempt.end(() =>
        withPi(attempt.ctx, { models, model: 'scribe/scribe', workspace }, async (pi) => ({
          answer: await pi.prompt('take a note'),
          agent: await (await pi.harness.root(pi.context)).agent(pi.context),
        })),
      );
      expect(answer).toBe('written');
      expect(agent.tools.map((t) => t.name)).toEqual(['read', 'write', 'edit', 'bash']);
      expect(agent.sections.map((s) => s.key)).toContain('cwd');
      expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('crushed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
