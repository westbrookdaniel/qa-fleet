import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSuite } from '../lib/runner.ts';
import { workspaceRuntimeDirectory } from '../lib/runtime.ts';
import { importedSources } from '../lib/source-scope.ts';
import { assertWorkspaceRuntime, initializeWorkspace, readWorkspace } from '../lib/workspace.ts';
import { installTestDependencies } from './portable-workspace-helpers.ts';

async function withWorkspace(run: (workspace: string, parent: string) => Promise<void>) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-portability-')));
  try {
    const application = path.join(parent, 'application');
    await mkdir(application);
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-b', 'main', application], {
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      [
        '-C',
        application,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@localhost',
        'commit',
        '--allow-empty',
        '-m',
        'Synthetic identity',
      ],
      { stdio: 'pipe' },
    );
    const workspace = path.join(parent, 'original', 'qa');
    await mkdir(path.dirname(workspace));
    await initializeWorkspace(
      { directory: workspace, applicationCheckout: application },
      { install: installTestDependencies },
    );
    await run(workspace, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('a relocated copy uses only its installed runtime for CLI, typecheck and ordinary Playwright collection', async () => {
  await withWorkspace(async (original, parent) => {
    await writeFile(
      path.join(original, 'specs/local.spec.ts'),
      "import { test, expect } from '../fixtures.ts';\ntest('local ordinary replay', async ({page}) => { await page.setContent('<h1>Portable</h1>'); await expect(page.getByRole('heading')).toHaveText('Portable'); });\n",
    );
    await writeFile(
      path.join(original, 'parts/candidate.ts'),
      'export async function candidate() {}\n',
    );
    await writeFile(
      path.join(original, 'catalog/candidate.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'candidate',
        kind: 'action',
        summary: 'Unobserved helper',
        module: 'parts/candidate.ts',
        exportName: 'candidate',
        inputs: {},
        effects: [],
      }),
    );
    const relocated = path.join(parent, 'relocated', 'qa');
    await cp(original, relocated, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => !source.includes(`${path.sep}.fleet`),
    });
    await rm(path.dirname(original), { recursive: true });
    await assert.rejects(realpath(original));
    await assert.rejects(lstat(path.join(relocated, '.fleet')));
    // A real Git clone has no ignored evidence directory before its first command.
    const status = execFileSync(
      process.execPath,
      ['--no-env-file', 'run', 'fleet', 'status', '--workspace', '.'],
      { cwd: relocated, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
    );
    assert.deepEqual(JSON.parse(status), { flows: [], pendingAttempts: [] });
    await assertWorkspaceRuntime(relocated);
    assert.equal(
      (await readWorkspace(relocated)).applicationCheckout,
      path.join(parent, 'application'),
    );
    assert.equal((await lstat(path.join(relocated, 'node_modules'))).isSymbolicLink(), false);
    assert.equal(
      workspaceRuntimeDirectory(relocated),
      path.join(relocated, 'node_modules/@qa-fleet/runtime'),
    );
    const cli = execFileSync(
      process.execPath,
      ['--no-env-file', 'run', 'fleet', 'catalog', 'search', '--workspace', '.'],
      { cwd: relocated, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
    );
    assert.equal(JSON.parse(cli).totalMatches, 1);
    execFileSync(process.execPath, ['--no-env-file', 'run', 'typecheck'], {
      cwd: relocated,
      stdio: 'pipe',
      timeout: 10_000,
    });
    const collected = execFileSync(
      process.execPath,
      ['--no-env-file', 'run', 'test', '--', '--list', '--project', 'chromium'],
      { cwd: relocated, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
    );
    assert.match(collected, /local ordinary replay/);
    let controllerCollection: string | undefined;
    await runSuite(
      {
        config: path.join(relocated, 'playwright.config.ts'),
        target: path.join(relocated, 'specs/local.spec.ts'),
        checkout: relocated,
        project: 'chromium',
        timeout: 10,
        workers: 1,
        locks: [],
        output: path.join(relocated, '.fleet/collection'),
      },
      {
        lockRoot: path.join(parent, 'collection-locks'),
        pressure: async () => ({ safe: true }),
        spawn: (executable, args, settings) => {
          // Exercise the external controller's actual command, stopping before browser launch.
          controllerCollection = execFileSync(executable, [...args, '--list'], {
            cwd: settings.cwd,
            env: settings.env,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 10_000,
          });
          throw new Error('Collection-only control finished before suite execution.');
        },
      },
    );
    assert.match(controllerCollection ?? '', /local ordinary replay/);
    assert.deepEqual(await readdir(path.join(parent, 'collection-locks')), []);
    const imported = await importedSources(relocated, [
      'fixtures.ts',
      'playwright.config.ts',
      'specs/local.spec.ts',
    ]);
    assert.equal(imported.dependencyMode, 'static-imports');
    assert.ok(imported.files.includes('specs/local.spec.ts'));
    assert.ok(
      imported.files.every(
        (file) => !file.includes('node_modules') && !file.includes('.fleet/runtime'),
      ),
    );
  });
}, 20_000);
