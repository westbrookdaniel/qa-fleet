import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { flowStatus, readObservations, readPendingAttempts } from '../lib/evidence.ts';
import { maintenanceReport } from '../lib/maintenance.ts';
import { initializeWorkspace } from '../lib/workspace.ts';
import { installTestDependencies } from './portable-workspace-helpers.ts';

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-pending-control-')));
  try {
    const app = path.join(root, 'application');
    await mkdir(app);
    execFileSync('git', ['init', '-b', 'main', app], { stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-C',
        app,
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
        'Fixture application',
      ],
      { stdio: 'pipe' },
    );
    const workspace = path.join(root, 'qa');
    await initializeWorkspace(
      { directory: workspace, applicationCheckout: app },
      { install: installTestDependencies },
    );
    await rm(path.join(workspace, 'catalog'), { recursive: true, force: true });
    await writeFile(path.join(workspace, 'parts/plain.ts'), 'export const expected = 1;\n');
    await writeFile(
      path.join(workspace, 'specs/plain.spec.ts'),
      "import {test,expect} from '../fixtures.ts'; import {expected} from '../parts/plain.ts'; test('plain helper', () => { expect(expected).toBe(1); });\n",
    );
    await run(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function launch(workspace: string, boundary: string) {
  return Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--no-install',
      path.join(import.meta.dir, 'fixtures/verification-interrupted-process.ts'),
      workspace,
      boundary,
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH, BUN_BE_BUN: '1', FLEET_BASE_URL: 'http://localhost:4000' },
    },
  );
}

test('killed verification keeps pending evidence before and during final publication, and suppresses it after completion', async () => {
  for (const boundary of ['before-run', 'during-final-publication', 'after-final-publication']) {
    await withWorkspace(async (workspace) => {
      const child = launch(workspace, boundary);
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        const reader = child.stdout.getReader();
        const output = await reader.read();
        reader.releaseLock();
        if (output.done) throw new Error(await new Response(child.stderr).text());
        assert.equal(new TextDecoder().decode(output.value), 'boundary-ready\n');
        assert.equal(
          (await readdir(path.join(workspace, '.fleet/evidence'))).filter((file) =>
            file.endsWith('.pending.json'),
          ).length,
          1,
        );
        child.kill('SIGKILL');
        await child.exited;
        const completed = boundary === 'after-final-publication';
        const observations = await readObservations(workspace);
        assert.equal(observations.length, completed ? 1 : 0);
        const pending = await readPendingAttempts(workspace);
        assert.equal(pending.length, completed ? 0 : 1);
        const status = await flowStatus(workspace);
        const maintenance = await maintenanceReport(workspace);
        assert.equal(status.pendingAttempts.length, pending.length);
        assert.equal(maintenance.summary.pendingAttempts, pending.length);
        if (completed) {
          assert.equal(status.flows[0].status, 'verification-incomplete');
          assert.equal(observations[0].observedPassing, false);
        } else {
          assert.equal(status.flows.length, 0);
          assert.equal('result' in pending[0], false);
          assert.equal('cleanup' in pending[0], false);
        }
      } finally {
        clearTimeout(deadline);
        child.kill('SIGKILL');
        await child.exited;
      }
    });
  }
}, 30_000);

test('normal finalization removes pending receipt and records no invented execution credit', async () => {
  await withWorkspace(async (workspace) => {
    const child = launch(workspace, 'complete');
    const output = await new Response(child.stdout).text();
    assert.equal(await child.exited, 0, await new Response(child.stderr).text());
    assert.equal(JSON.parse(output).observedPassing, false);
    assert.deepEqual(await readPendingAttempts(workspace), []);
    const [record] = await readObservations(workspace);
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.result.test.verdict, 'not-run');
    assert.ok(record.source.files['parts/plain.ts']);
    assert.equal('observedPartIds' in record, false);
    assert.equal('partIds' in record, false);
    assert.equal((await readdir(path.join(workspace, '.fleet/evidence'))).length, 1);
  });
}, 10_000);
