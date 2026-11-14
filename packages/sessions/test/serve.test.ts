// oxlint-disable eslint/no-underscore-dangle -- the SDK's names, as `remote` carries them
// What `restate.serve` serves: the services given, each with what it needs
// beside it (a library's own objects), once, or those RESTATE_SERVE_ONLY names.
import * as restate from '@restatedev/sessions';
import { needing, served, serving } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';

const helper = restate.service({ name: 'helper', handlers: { help: async (_ctx: restate.Context) => 'ok' } });
const notes = needing(restate.sessionObject({ name: 'notes', handlers: { add: async () => {} } }), () => [helper]);
const lists = needing(restate.sessionObject({ name: 'lists', handlers: { add: async () => {} } }), () => [helper]);

const names = (services: { name: string }[]) => services.map((s) => s.name);

describe('restate.serve', () => {
  it('serves each service with what it needs beside it, once', () => {
    expect(names(served([notes, lists]))).toEqual(['notes', 'helper', 'lists']);
    expect(names(served([helper, notes]))).toEqual(['helper', 'notes']);
  });

  it('serves only the services RESTATE_SERVE_ONLY names, and refuses a name of none', () => {
    expect(names(served([notes, lists], 'lists, helper'))).toEqual(['helper', 'lists']);
    expect(() => served([notes], 'notes,nobody')).toThrow(/RESTATE_SERVE_ONLY names nobody/);
  });

  it('serves what a service RESTATE_SERVE_ONLY names needs beside it, unnamed', () => {
    expect(names(served([notes, lists], 'lists'))).toEqual(['lists', 'helper']);
  });
});

describe('serving', () => {
  const companion = restate.object({ name: 'notes.prebuilt.restate', handlers: {} });
  const agent = needing(restate.sessionObject({ name: 'notes', handlers: { add: async () => {} } }), () => [companion]);

  it('listens on PORT when nothing names a connect key', () => {
    const plan = serving([agent], { PORT: '9090' });
    expect(plan.port).toBe(9090);
    expect(plan.connect).toBeUndefined();
    expect(names(plan.services)).toEqual(['notes', 'notes.prebuilt.restate']);
  });

  it('connects out with a connect key, under the name the environment gives', () => {
    const plan = serving([agent], { RESTATE_CONNECT_KEY: 'a-key', RESTATE_CONNECT_NAME: 'notes-v1' });
    expect(plan.connect).toEqual({ name: 'notes-v1' });
    expect(plan.port).toBeUndefined();
    // The gap this closes: connecting out used to skip `served`, which is what
    // brings each agent's companion, so the first tool that waited had nothing to wait on.
    expect(names(plan.services)).toEqual(['notes', 'notes.prebuilt.restate']);
  });

  it('connects out without a name, which the SDK takes from its own environment', () => {
    expect(serving([agent], { RESTATE_CONNECT_KEY: 'a-key' }).connect).toEqual({});
  });

  it('counts a blank key as none, as the SDK does, so a .env template still listens', () => {
    const plan = serving([agent], { RESTATE_CONNECT_KEY: '', PORT: '9090' });
    expect(plan.connect).toBeUndefined();
    expect(plan.port).toBe(9090);
  });

  it('counts a blank name as none, leaving the SDK its own fallbacks', () => {
    expect(serving([agent], { RESTATE_CONNECT_KEY: 'a-key', RESTATE_CONNECT_NAME: '' }).connect).toEqual({});
  });

  it('serves only what RESTATE_SERVE_ONLY names when it connects out, too', () => {
    const other = restate.sessionObject({ name: 'lists', handlers: { add: async () => {} } });
    const plan = serving([agent, other], { RESTATE_CONNECT_KEY: 'a-key', RESTATE_SERVE_ONLY: 'notes' });
    expect(names(plan.services)).toEqual(['notes', 'notes.prebuilt.restate']);
  });
});

describe('remote', () => {
  const workspace = restate.remote.object<restate.VirtualObjectDefinition<'workspace', unknown>>('workspace');

  it('carries what a client reads of a definition: its name, and its kind both ways', () => {
    expect(workspace.name).toBe('workspace');
    // `_kind` is what this package's clients read; the key is what the agents' tools read.
    expect((workspace as unknown as { _kind: string })._kind).toBe('object');
    expect('object' in workspace).toBe(true);
  });

  it('is refused where services are served: nothing here implements it', () => {
    expect(() => served([workspace])).toThrow(/workspace: a remote handle/);
  });
});
