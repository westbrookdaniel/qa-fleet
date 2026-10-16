import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceInputError } from './errors.ts';

export const portableRuntimeName = '@qa-fleet/runtime';

interface PackageDefinition {
  name: string;
  version: string;
  engines: { bun: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  fleetPlaywright?: string;
}

export async function runtimePackageDefinition(runtime: string): Promise<PackageDefinition> {
  return JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
}

// Source and compiled scaffolds carry the same source package. Compiled controllers
// read the sidecar produced at build time, rather than inventing source from a binary.
export async function portableRuntimeArchive(runtime: string): Promise<Buffer> {
  const bundled = path.join(runtime, 'portable-runtime.tgz');
  if (await lstat(bundled).catch(() => null)) return readFile(bundled);
  const definition = await runtimePackageDefinition(runtime);
  const playwright = definition.dependencies['@playwright/test'] ?? definition.fleetPlaywright;
  const contents: Record<string, string | Buffer> = {};
  async function collect(relative: string): Promise<void> {
    const source = path.join(runtime, relative);
    const entry = await lstat(source);
    if (entry.isSymbolicLink())
      throw new WorkspaceInputError('Runtime package source contains a symbolic link.');
    if (entry.isDirectory()) {
      for (const name of (await readdir(source)).sort())
        await collect(path.posix.join(relative, name));
    } else if (entry.isFile()) {
      contents[`package/${relative}`] = await readFile(source);
    } else throw new WorkspaceInputError('Runtime package source must contain regular files.');
  }
  for (const file of [
    'bin',
    'lib',
    'docs/WORKSPACES.md',
    'fixtures.ts',
    'verification-reporter.ts',
    'bunfig.toml',
    'bun.lock',
  ])
    await collect(file);
  contents['package/package.json'] = JSON.stringify(
    {
      name: portableRuntimeName,
      version: definition.version,
      type: 'module',
      license: 'MIT',
      engines: { bun: definition.engines?.bun ?? '1.4.0' },
      bin: { 'qa-fleet': 'bin/qa-fleet.ts' },
      exports: { './fixtures': './fixtures.ts', './package.json': './package.json' },
      peerDependencies: { '@playwright/test': playwright },
      // Retain the compiler pins as metadata for workspaces initialized by this package.
      dependencies: {},
      devDependencies: definition.devDependencies,
      fleetPlaywright: definition.dependencies['@playwright/test'] ?? definition.fleetPlaywright,
    },
    null,
    2,
  );
  const archive = new Bun.Archive(contents, { compress: 'gzip' });
  return Buffer.from(await archive.bytes());
}

export async function writePortableDependencies(root: string, runtime: string): Promise<void> {
  const definition = await runtimePackageDefinition(runtime);
  const archive = await portableRuntimeArchive(runtime);
  const archiveHash = createHash('sha256').update(archive).digest('hex');
  // Bun caches file packages by their location; changed bytes need a new identity.
  const archiveName = `vendor/qa-fleet-runtime-${definition.version}-${archiveHash}.tgz`;
  await writeFile(path.join(root, archiveName), archive, { flag: 'wx' });
  const playwright = definition.dependencies['@playwright/test'] ?? definition.fleetPlaywright;
  const packageJson = {
    name: path.basename(root),
    private: true,
    type: 'module',
    packageManager: `bun@${definition.engines?.bun ?? '1.4.0'}`,
    scripts: {
      fleet: 'bun --no-env-file --no-install node_modules/@qa-fleet/runtime/bin/qa-fleet.ts',
      test: 'bun --no-env-file --no-install node_modules/@playwright/test/cli.js test',
      typecheck: 'tsc --noEmit',
    },
    dependencies: { [portableRuntimeName]: `file:${archiveName}`, '@playwright/test': playwright },
    devDependencies: {
      typescript: definition.devDependencies.typescript,
      '@types/bun': definition.devDependencies['@types/bun'],
    },
  };
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  // Reuse the release's entire resolved graph, including transitive types and all
  // platform compiler packages. No registry resolution occurs during scaffolding.
  const lock = Bun.JSON5.parse(await readFile(path.join(runtime, 'bun.lock'), 'utf8')) as {
    workspaces: Record<string, unknown>;
    packages: Record<string, unknown>;
  };
  lock.workspaces = {
    '': {
      name: packageJson.name,
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
    },
  };
  lock.packages[portableRuntimeName] = [
    `${portableRuntimeName}@${archiveName}`,
    {
      peerDependencies: { '@playwright/test': playwright },
      bin: { 'qa-fleet': 'bin/qa-fleet.ts' },
    },
    `sha512-${createHash('sha512').update(archive).digest('base64')}`,
  ];
  await writeFile(path.join(root, 'bun.lock'), `${JSON.stringify(lock, null, 2)}\n`);
}
