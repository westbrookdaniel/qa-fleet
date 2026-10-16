import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { portableRuntimeArchive } from '../lib/runtime-package.ts';

const root = path.resolve(import.meta.dir, '..');
const output = path.join(root, 'dist');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Bun.version !== '1.4.0') throw new Error('Build requires the pinned Bun 1.4.0 runtime.');

await rm(output, { recursive: true, force: true });
await mkdir(output);
const result = await Bun.build({
  entrypoints: [path.join(root, 'bin/qa-fleet.ts')],
  target: 'bun',
  define: { FLEET_COMPILED: 'true' },
  compile: {
    outfile: path.join(output, 'qa-fleet'),
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
});
if (!result.success) throw new AggregateError(result.logs, 'Fleet compilation failed.');

// Playwright resolves workers, reporters and browser metadata dynamically.
// Keep its complete packages on disk, beside the binary and ordinary fixtures.
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
  await cp(path.join(root, 'node_modules', name), path.join(output, 'node_modules', name), {
    recursive: true,
    dereference: true,
  });
}
await mkdir(path.join(output, 'node_modules/.bin'));
await symlink('../typescript/bin/tsc', path.join(output, 'node_modules/.bin/tsc'));
await symlink('../@playwright/test/cli.js', path.join(output, 'node_modules/.bin/playwright'));
for (const name of [
  'fixtures.ts',
  'verification-reporter.ts',
  'bunfig.toml',
  'playwright.config.ts',
  'specs',
  'docs/WORKSPACES.md',
]) {
  await mkdir(path.dirname(path.join(output, name)), { recursive: true });
  await cp(path.join(root, name), path.join(output, name), { recursive: true });
}
await writeFile(path.join(output, 'portable-runtime.tgz'), await portableRuntimeArchive(root));
await cp(path.join(root, 'bun.lock'), path.join(output, 'bun.lock'));
await writeFile(
  path.join(output, 'package.json'),
  `${JSON.stringify(
    {
      name: packageJson.name,
      version: packageJson.version,
      type: 'module',
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
      engines: packageJson.engines,
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  path.join(output, 'build.json'),
  `${JSON.stringify(
    {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      playwright: packageJson.dependencies['@playwright/test'],
      executable: 'qa-fleet',
      browser: 'External Playwright Chromium installation; not embedded or downloaded by build.',
    },
    null,
    2,
  )}\n`,
);
console.log(`Built ${output}/qa-fleet with required Playwright sidecars. Chromium is external.`);
