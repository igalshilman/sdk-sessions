// The addon (`native/`), loaded once: the database of a session
// (`database.ts`) and the VM of an attempt (`vm.ts`) both come from it.
import { createRequire } from 'node:module';
import { PLATFORMS, platform } from './platform.ts';

/** What the addon exports. Its types live with what uses them. */
interface Addon {
  open(namespace: string, store: unknown, reader: boolean): Promise<unknown>;
  Vm: unknown;
  Identity: unknown;
}

/** The addon of this machine's platform, from its package (see platform.ts). */
function load(): Addon {
  const machine = platform();
  const name = `@restatedev/sessions-${machine}`;
  try {
    return createRequire(import.meta.url)(name) as Addon;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error(
      `@restatedev/sessions found no addon for ${machine}, the package ${name}: it ships them for ` +
        `${PLATFORMS.join(', ')}. In its repository, \`pnpm build\` builds this machine's.`,
      { cause: error },
    );
  }
}

export const addon = load();
