import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runtimeDirectory } from '../lib/runtime.ts';
import {
  assertWorkspaceRuntime,
  initializeWorkspace,
  readWorkspace,
  workspaceDirectory,
  workspaceFile,
} from '../lib/workspace.ts';
import { installTestDependencies } from './portable-workspace-helpers.ts';

async function withDirectories(run: (root: string, app: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-workspace-')));
  const app = path.join(root, 'application');
  try {
    await mkdir(app);
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-b', 'main', app], {
      stdio: 'pipe',
    });
    await run(root, app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('initialization creates an independent local repository with a portable pinned runtime', async () => {
  await withDirectories(async (root, app) => {
    const destination = path.join(root, 'application-qa');
    const result = await initializeWorkspace(
      { directory: destination, applicationCheckout: app },
      { install: installTestDependencies },
    );
    assert.equal(result.workspace, destination);
    assert.deepEqual(await readWorkspace(destination), {
      schemaVersion: 1,
      name: 'application-qa',
      applicationCheckout: app,
    });
    await assertWorkspaceRuntime(destination);
    assert.equal(
      await realpath(path.join(destination, 'node_modules')),
      path.join(destination, 'node_modules'),
    );
    assert.equal(execFileSync('git', ['-C', destination, 'remote'], { encoding: 'utf8' }), '');
    const ignored = execFileSync(
      'git',
      ['-C', destination, 'check-ignore', '.auth/state.json', '.fleet/evidence/run.json'],
      { encoding: 'utf8' },
    );
    assert.equal(ignored.trim().split('\n').length, 2);
    await assert.rejects(
      initializeWorkspace(
        { directory: destination, applicationCheckout: app },
        { install: installTestDependencies },
      ),
    );
    assert.equal((await readWorkspace(destination)).name, 'application-qa');
  });
});

test('initialization rejects application descendants even through a symlinked output parent', async () => {
  await withDirectories(async (root, app) => {
    const alias = path.join(root, 'application-alias');
    await symlink(app, alias);
    for (const destination of [path.join(app, 'qa'), path.join(alias, 'qa')]) {
      await assert.rejects(
        initializeWorkspace(
          { directory: destination, applicationCheckout: app },
          { install: installTestDependencies },
        ),
        /outside the application/,
      );
    }
    await assert.rejects(realpath(path.join(app, 'qa')));
  });
});

test('initialization uses the full application repository when given a subdirectory', async () => {
  await withDirectories(async (root, app) => {
    await mkdir(path.join(app, 'src'));
    const destination = path.join(root, 'application-qa');
    await initializeWorkspace(
      {
        directory: destination,
        applicationCheckout: path.join(app, 'src'),
      },
      { install: installTestDependencies },
    );
    assert.equal((await readWorkspace(destination)).applicationCheckout, app);
  });
});

test('workspace output directories reject symlink components and traversal before writing', async () => {
  await withDirectories(async (root) => {
    const workspace = path.join(root, 'qa');
    const outside = path.join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    assert.equal(
      await workspaceDirectory(workspace, '.fleet/evidence', { create: true }),
      path.join(workspace, '.fleet/evidence'),
    );
    await symlink(outside, path.join(workspace, '.fleet/runs'));
    await assert.rejects(
      workspaceDirectory(workspace, '.fleet/runs/new', { create: true }),
      /without symbolic links/,
    );
    await assert.rejects(realpath(path.join(outside, 'new')));
    for (const relative of [
      '../outside',
      '/tmp/outside',
      'parts/../outside',
      'parts//nested',
      '',
    ]) {
      await assert.rejects(
        workspaceDirectory(workspace, relative, { create: true }),
        /relative directory/,
      );
    }
    await writeFile(path.join(workspace, 'file'), 'regular file');
    await assert.rejects(workspaceDirectory(workspace, 'file'), /existing directories/);
  });
});

test('workspace files and configuration cannot escape through symlinks', async () => {
  await withDirectories(async (root) => {
    const workspace = path.join(root, 'qa');
    await mkdir(workspace);
    const secret = path.join(root, 'private.json');
    await writeFile(secret, 'SYNTHETIC_SECRET');
    await symlink(secret, path.join(workspace, 'fleet.json'));
    await assert.rejects(workspaceFile(workspace, 'fleet.json'), /inside the QA workspace/);
    await assert.rejects(readWorkspace(workspace), /readable JSON/);
    await rm(path.join(workspace, 'fleet.json'));
    await writeFile(path.join(workspace, 'fleet.json'), '{ SYNTHETIC_SECRET');
    await assert.rejects(readWorkspace(workspace), (error: unknown) => {
      assert.ok(error instanceof Error);
      return !error.message.includes('SYNTHETIC_SECRET');
    });
  });
});

test('portable runtime rejects dependencies linked outside the workspace', async () => {
  await withDirectories(async (root, app) => {
    const workspace = path.join(root, 'portable-qa');
    await initializeWorkspace(
      { directory: workspace, applicationCheckout: app },
      { install: installTestDependencies },
    );
    await rm(path.join(workspace, 'node_modules'), { recursive: true });
    await symlink(
      path.join(runtimeDirectory(), 'node_modules'),
      path.join(workspace, 'node_modules'),
    );
    await assert.rejects(assertWorkspaceRuntime(workspace), /pinned local Fleet runtime/);
  });
});

test('application checkout override resolves relative to the relocated workspace', async () => {
  await withDirectories(async (root, app) => {
    const workspace = path.join(root, 'qa');
    await mkdir(workspace);
    await writeFile(
      path.join(workspace, 'fleet.json'),
      JSON.stringify({ schemaVersion: 1, name: 'qa', applicationCheckout: '../application' }),
    );
    assert.equal((await readWorkspace(workspace)).applicationCheckout, app);
    const previous = process.env.FLEET_APPLICATION_CHECKOUT;
    try {
      process.env.FLEET_APPLICATION_CHECKOUT = '../other-application';
      assert.equal(
        (await readWorkspace(workspace)).applicationCheckout,
        path.join(root, 'other-application'),
      );
      process.env.FLEET_APPLICATION_CHECKOUT = '';
      await assert.rejects(readWorkspace(workspace), /override/);
    } finally {
      if (previous === undefined) delete process.env.FLEET_APPLICATION_CHECKOUT;
      else process.env.FLEET_APPLICATION_CHECKOUT = previous;
    }
  });
});
