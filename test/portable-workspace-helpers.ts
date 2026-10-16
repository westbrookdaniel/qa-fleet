import { chmod, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeDirectory } from '../lib/runtime.ts';
import { portableWorkspaceFiles } from '../lib/workspace.ts';

// Unit fixtures use the already-installed release packages. This creates owned
// directories, never links back to Fleet, and makes no registry requests.
export async function installTestDependencies(root: string): Promise<void> {
  const runtime = runtimeDirectory();
  const archiveName = (await portableWorkspaceFiles(root)).find((file) => file.endsWith('.tgz'));
  if (!archiveName) throw new Error('Portable runtime archive is missing.');
  const archive = new Bun.Archive(await readFile(path.join(root, archiveName)));
  const destination = path.join(root, 'node_modules/@qa-fleet/runtime');
  for (const [name, file] of await archive.files()) {
    const output = path.join(destination, name.replace(/^package\//, ''));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(await file.arrayBuffer()));
  }
  for (const name of [
    '@playwright/test',
    'playwright',
    'playwright-core',
    'typescript',
    `@typescript/typescript-${process.platform}-${process.arch}`,
    '@types/bun',
    'bun-types',
    '@types/node',
    'undici-types',
  ]) {
    await cp(path.join(runtime, 'node_modules', name), path.join(root, 'node_modules', name), {
      recursive: true,
      dereference: true,
    });
  }
  await mkdir(path.join(root, 'node_modules/.bin'));
  await symlink('../typescript/bin/tsc', path.join(root, 'node_modules/.bin/tsc'));
  await symlink('../@playwright/test/cli.js', path.join(root, 'node_modules/.bin/playwright'));
  await chmod(path.join(destination, 'bin/qa-fleet.ts'), 0o755);
  await symlink(
    '../@qa-fleet/runtime/bin/qa-fleet.ts',
    path.join(root, 'node_modules/.bin/qa-fleet'),
  );
}
