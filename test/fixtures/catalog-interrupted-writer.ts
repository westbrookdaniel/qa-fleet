import { mock } from 'bun:test';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';

const [workspaceArgument, incoming, boundary = 'partial-write'] = process.argv.slice(2);
if (!workspaceArgument || !incoming)
  throw new Error('Workspace and incoming contract are required.');
const workspace = await filesystem.realpath(workspaceArgument);

const write = filesystem.writeFile;
const createDirectory = filesystem.mkdir;
const resolvePath = filesystem.realpath;
const inspect = filesystem.stat;
const catalogPrefix = `${path.join(workspace, 'catalog')}${path.sep}`;
let intercepted = false;
mock.module('node:fs/promises', () => ({
  ...filesystem,
  realpath: async (...args: Parameters<typeof filesystem.realpath>) => {
    const [filename] = args;
    if (
      boundary === 'before-contract-read' &&
      typeof filename === 'string' &&
      filename.startsWith(catalogPrefix) &&
      filename.endsWith('.json')
    ) {
      // Reproduce Bun/macOS resolving a published hard link to its temporary name.
      return path.join(workspace, 'catalog', path.basename(incoming));
    }
    return resolvePath(...args);
  },
  stat: async (...args: Parameters<typeof filesystem.stat>) => {
    const [filename] = args;
    if (
      !intercepted &&
      boundary === 'before-contract-read' &&
      typeof filename === 'string' &&
      filename.startsWith(catalogPrefix)
    ) {
      intercepted = true;
      process.stdout.write('before-contract-read\n');
      await Bun.stdin.text();
    }
    return inspect(...args);
  },
  mkdir: async (...args: Parameters<typeof filesystem.mkdir>) => {
    if (boundary === 'before-catalog-create' && args[0] === path.join(workspace, 'catalog')) {
      process.stdout.write('before-catalog-create\n');
      await Bun.stdin.text();
    }
    return createDirectory(...args);
  },
  writeFile: async (...args: Parameters<typeof filesystem.writeFile>) => {
    const [filename, contents, options] = args;
    if (
      !intercepted &&
      boundary === 'partial-write' &&
      typeof filename === 'string' &&
      filename.startsWith(`${path.join(workspace, 'catalog')}${path.sep}`) &&
      typeof contents === 'string'
    ) {
      intercepted = true;
      // Pause after a real partial write so the parent can inspect discovery or kill us.
      await write(filename, contents.slice(0, Math.floor(contents.length / 2)), options);
      process.stdout.write('partial-write\n');
      await Bun.stdin.text();
      await write(filename, contents, { mode: 0o600 });
      return;
    }
    return write(...args);
  },
}));

const { addPart, readCatalog } = await import('../../lib/catalog.ts');
try {
  if (boundary === 'before-contract-read') {
    process.stdout.write(JSON.stringify(await readCatalog(workspace)));
  } else {
    await addPart(workspace, incoming);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Registration failed'}\n`);
  process.exitCode = 1;
}
