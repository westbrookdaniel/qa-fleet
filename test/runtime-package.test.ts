import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runtimeDirectory } from '../lib/runtime.ts';
import {
  portableRuntimeArchive,
  portableRuntimeName,
  writePortableDependencies,
} from '../lib/runtime-package.ts';

test('same-version runtime packages install their own contents through one retained Bun cache', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'fleet-package-cache-'));
  try {
    const runtime = path.join(parent, 'runtime');
    for (const directory of ['bin', 'lib', 'docs'])
      await mkdir(path.join(runtime, directory), { recursive: true });
    for (const file of ['fixtures.ts', 'verification-reporter.ts', 'bunfig.toml'])
      await writeFile(path.join(runtime, file), '');
    await writeFile(path.join(runtime, 'docs/WORKSPACES.md'), '# Workspace authoring\n');
    await writeFile(
      path.join(runtime, 'package.json'),
      JSON.stringify({
        name: 'qa-fleet',
        version: '1.1.0',
        engines: { bun: Bun.version },
        dependencies: {},
        devDependencies: {},
      }),
    );
    await writeFile(
      path.join(runtime, 'bun.lock'),
      JSON.stringify({ lockfileVersion: 1, workspaces: {}, packages: {} }),
    );
    await writeFile(
      path.join(runtime, 'bin/qa-fleet.ts'),
      "import { message } from '../lib/workspace-cli.ts'; console.log(message);\n",
    );
    const dependencies: string[] = [];
    for (const message of ['first source revision', 'second source revision']) {
      await writeFile(
        path.join(runtime, 'lib/workspace-cli.ts'),
        `export const message = ${JSON.stringify(message)};\n`,
      );
      const workspace = path.join(parent, `workspace-${dependencies.length}`);
      await mkdir(path.join(workspace, 'vendor'), { recursive: true });
      await writePortableDependencies(workspace, runtime);
      const definition = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
      dependencies.push(definition.dependencies[portableRuntimeName]);
      // Both real installs share this cache; all dependencies are local and no cache is purged.
      execFileSync(
        process.execPath,
        [
          '--no-env-file',
          `--config=${path.join(runtime, 'bunfig.toml')}`,
          'install',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--no-progress',
        ],
        {
          cwd: workspace,
          stdio: 'pipe',
          timeout: 10_000,
          env: { BUN_INSTALL_CACHE_DIR: path.join(parent, 'cache'), BUN_BE_BUN: '1' },
        },
      );
      const installed = path.join(workspace, 'node_modules/@qa-fleet/runtime');
      const installedDefinition = JSON.parse(
        await readFile(path.join(installed, 'package.json'), 'utf8'),
      );
      assert.equal(installedDefinition.version, '1.1.0');
      const output = execFileSync(
        process.execPath,
        ['--no-env-file', '--no-install', path.join(installed, 'bin/qa-fleet.ts')],
        { cwd: workspace, encoding: 'utf8', stdio: 'pipe', timeout: 5000 },
      );
      assert.equal(output.trim(), message);
    }
    assert.notEqual(dependencies[0], dependencies[1]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('the portable runtime includes the workspace guide referenced by its CLI', async () => {
  const runtime = runtimeDirectory();
  const archive = new Bun.Archive(await portableRuntimeArchive(runtime));
  const guide = (await archive.files()).get('package/docs/WORKSPACES.md');
  assert.ok(guide);
  assert.equal(
    await guide.text(),
    await readFile(path.join(runtime, 'docs/WORKSPACES.md'), 'utf8'),
  );
});
