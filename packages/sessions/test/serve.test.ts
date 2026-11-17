// oxlint-disable eslint/no-underscore-dangle -- the SDK's names, as `remote` carries them
// What `restate.serve` serves: the services given, each with what it needs
// beside it (a library's own objects), once, or those RESTATE_SERVE_ONLY names.
import * as restate from '@restatedev/sessions';
import { invokeRoute, needing, sdk, served } from '@restatedev/sessions/internal';
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

describe('restate.connect', () => {
  const companion = restate.object({ name: 'notes.prebuilt.restate', handlers: {} });
  const agent = needing(restate.sessionObject({ name: 'notes', handlers: { add: async () => {} } }), () => [companion]);

  it("is this module's own, so `export *` of the SDK does not shadow it", () => {
    expect(restate.connect).not.toBe(sdk.connect);
  });

  it("binds what `served` lists, the companion included: the SDK's own leaves it out", () => {
    expect(names(served([agent]))).toEqual(['notes', 'notes.prebuilt.restate']);
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

describe('the path of an invocation', () => {
  it('is the last three fragments, as the SDK reads it', () => {
    expect(invokeRoute('/invoke/Notes/add')).toEqual({ service: 'Notes', handler: 'add' });
    // A deployment registered under a prefix: the SDK matches these, and
    // matching only a bare `/invoke/...` would hand them to it without a
    // word, so a session object would be refused on a path that should work.
    expect(invokeRoute('/behind/a/prefix/invoke/Notes/add')).toEqual({ service: 'Notes', handler: 'add' });
    expect(invokeRoute('/invoke/Notes/add?x=1')).toEqual({ service: 'Notes', handler: 'add' });
  });

  it('is nothing for what is not an invocation', () => {
    // Listed in the message so a failure says which path broke.
    // A bare `//` is a URL with an empty host, which `URL` refuses outright:
    // it has to be nothing here, not a throw in the request listener.
    for (const path of ['/discover', '/health', '/invoke/Notes', '/invoke//add', '/invoke/Notes/', '/', '', '//']) {
      expect(invokeRoute(path)).toBeUndefined();
    }
  });
});
