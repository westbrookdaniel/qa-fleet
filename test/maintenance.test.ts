import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applicationSnapshot, flowStatus, workspaceSnapshot } from '../lib/evidence.ts';
import { maintenanceReport } from '../lib/maintenance.ts';
import { runtimeDirectory } from '../lib/runtime.ts';
import { writePortableDependencies } from '../lib/runtime-package.ts';
import { installTestDependencies } from './portable-workspace-helpers.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-maintenance-'));
  const app = path.join(root, 'app');
  const qa = path.join(root, 'qa');
  await mkdir(app);
  await mkdir(qa);
  const git = (args: string[]) =>
    execFileSync(
      'git',
      ['-C', app, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
      { stdio: 'pipe' },
    );
  git(['init', '-b', 'main']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Fixture app',
  ]);
  for (const directory of ['parts', 'vendor', 'specs', '.fleet/evidence'])
    await mkdir(path.join(qa, directory), { recursive: true });
  await writePortableDependencies(qa, runtimeDirectory());
  await installTestDependencies(qa);
  await writeFile(
    path.join(qa, 'fixtures.ts'),
    "export { test, expect } from '@qa-fleet/runtime/fixtures';\n",
  );
  await writeFile(
    path.join(qa, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({});\n",
  );
  await writeFile(
    path.join(qa, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'Preserve', moduleResolution: 'Bundler' } }),
  );
  await writeFile(
    path.join(qa, 'fleet.json'),
    JSON.stringify({ schemaVersion: 1, name: 'qa', applicationCheckout: app }),
  );
  for (const name of ['shared', 'unrelated']) {
    await writeFile(path.join(qa, `parts/${name}.ts`), `export const ${name} = 'original';\n`);
  }
  const application = await applicationSnapshot(app);
  async function observation(
    name: string,
    helper: string,
    overrides: Record<string, unknown> = {},
  ) {
    const spec = `specs/${name}.spec.ts`;
    await writeFile(path.join(qa, spec), `import { ${helper} } from '../parts/${helper}.ts';\n`);
    const source = await workspaceSnapshot(qa, { spec });
    const record = {
      schemaVersion: 2,
      id: name,
      finished: '2026-10-09T00:00:00Z',
      environment: 'fixture',
      targetOrigin: 'http://localhost:4000',
      parametersHash: 'fixture',
      deployment: null,
      application,
      source,
      spec,
      specHash: source.files[spec],
      observedPassing: true,
      result: { test: { verdict: 'passed' }, cleanup: { complete: true } },
      ...overrides,
    };
    await writeFile(path.join(qa, `.fleet/evidence/${name}.json`), JSON.stringify(record));
    return record;
  }
  return { root, qa, app, observation };
}

test('one changed helper identifies exactly the affected flows while unrelated growth stays valid', async () => {
  const { root, qa, observation } = await fixture();
  try {
    await observation('search', 'shared');
    await observation('filter', 'shared');
    await observation('settings', 'unrelated');
    assert.equal((await maintenanceReport(qa)).summary.replayNeeded, 0);
    await writeFile(path.join(qa, 'parts/new-candidate.ts'), 'export const candidate = true;');
    await writeFile(path.join(qa, 'parts/shared.ts'), "export const shared = 'changed';\n");
    const report = await maintenanceReport(qa, { limit: 1 });
    assert.equal(report.summary.replayNeeded, 2);
    assert.equal(report.summary.unchangedFlowScopes, 1);
    assert.deepEqual(report.replayCandidates[0].changedFiles, ['parts/shared.ts']);
    assert.equal(report.nextOffset, 1);
    const next = await maintenanceReport(qa, { limit: 1, offset: 1 });
    assert.deepEqual(
      [report.replayCandidates[0].spec, next.replayCandidates[0].spec],
      ['specs/filter.spec.ts', 'specs/search.spec.ts'],
    );
    assert.equal(next.nextOffset, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test('a newly shadowing module invalidates dependent flows without changing recorded files', async () => {
  const { root, qa, observation } = await fixture();
  try {
    await mkdir(path.join(qa, 'parts/support'));
    await writeFile(path.join(qa, 'parts/support/index.ts'), "export const shared = 'original';\n");
    await writeFile(path.join(qa, 'parts/shared.ts'), "export { shared } from './support';\n");
    const previous = await observation('search', 'shared');
    await observation('settings', 'unrelated');
    assert.ok('parts/support/index.ts' in previous.source.files);
    assert.equal((await maintenanceReport(qa)).summary.replayNeeded, 0);

    await writeFile(path.join(qa, 'parts/support.ts'), "export const shared = 'replacement';\n");
    const report = await maintenanceReport(qa);
    assert.equal(report.summary.replayNeeded, 1);
    assert.equal(report.summary.unchangedFlowScopes, 1);
    const affected = report.replayCandidates[0];
    assert.equal(affected.spec, 'specs/search.spec.ts');
    assert.deepEqual(affected.changedFiles, []);
    assert.deepEqual(affected.missingFiles, []);
    assert.ok(affected.reasons.includes('source-dependencies-changed'));
    assert.deepEqual(affected.addedFiles, ['parts/support.ts']);

    await writeFile(path.join(qa, 'parts/shared.ts'), "export const shared = 'inline';\n");
    const removed = (await maintenanceReport(qa)).replayCandidates[0];
    assert.deepEqual(removed.removedDependencies, ['parts/support/index.ts']);
    assert.deepEqual(removed.addedFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test('latest failed and incomplete cleanup scopes remain actionable even when source is unchanged', async () => {
  const { root, qa, observation } = await fixture();
  try {
    const previous = await observation('search', 'shared');
    await writeFile(
      path.join(qa, '.fleet/evidence/failure.json'),
      JSON.stringify({
        ...previous,
        finished: '2026-10-09T00:01:00Z',
        observedPassing: false,
        result: { test: { verdict: 'failed' }, cleanup: { complete: false } },
      }),
    );
    const report = await maintenanceReport(qa);
    assert.equal(report.summary.recordedFlowScopes, 1);
    assert.deepEqual(report.replayCandidates[0].reasons, [
      'last-run-not-passed',
      'cleanup-incomplete',
      'verification-incomplete',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a newer unfinished attempt affects only its matching flow and preserves the prior verdict', async () => {
  const { root, qa, observation } = await fixture();
  try {
    const previous = await observation('search', 'shared');
    await observation('settings', 'unrelated');
    const pending = {
      schemaVersion: 1,
      id: 'unfinished',
      started: '2026-10-09T00:01:00Z',
      spec: previous.spec,
      environment: previous.environment,
      targetOrigin: previous.targetOrigin,
      deployment: previous.deployment,
      parametersHash: previous.parametersHash,
      sourceHash: previous.source.hash,
      application: previous.application,
    };
    const unrelatedAttempts = [
      { started: '2026-10-08T23:59:00Z' },
      { spec: 'specs/another.spec.ts' },
      { environment: 'another-environment' },
      { targetOrigin: 'http://localhost:4001' },
      { deployment: 'another-deployment' },
      { parametersHash: 'another-input' },
    ];
    for (const [index, overrides] of unrelatedAttempts.entries()) {
      const id = `other-${index}`;
      await writeFile(
        path.join(qa, `.fleet/evidence/${id}.pending.json`),
        JSON.stringify({ ...pending, ...overrides, id }),
      );
    }
    assert.ok((await flowStatus(qa)).flows.every((flow) => flow.status === 'observed-passing'));
    assert.equal((await maintenanceReport(qa)).summary.replayNeeded, 0);

    await writeFile(
      path.join(qa, '.fleet/evidence/unfinished.pending.json'),
      JSON.stringify(pending),
    );
    const status = await flowStatus(qa);
    const affected = status.flows.find((flow) => flow.spec === previous.spec);
    assert.ok(affected);
    assert.equal(affected.status, 'unfinished-attempt');
    assert.equal(affected.id, previous.id);
    assert.equal(affected.observedPassing, true);
    assert.equal(affected.testVerdict, 'passed');
    assert.equal(affected.cleanupComplete, true);
    assert.equal(
      status.flows.find((flow) => flow.spec === 'specs/settings.spec.ts')?.status,
      'observed-passing',
    );
    const report = await maintenanceReport(qa);
    assert.equal(report.summary.replayNeeded, 1);
    assert.equal(report.summary.unchangedFlowScopes, 1);
    assert.equal(report.summary.pendingAttempts, unrelatedAttempts.length + 1);
    assert.deepEqual(report.replayCandidates[0].reasons, ['unfinished-attempt']);
    assert.equal(report.replayCandidates[0].spec, previous.spec);

    // A completed receipt suppresses its leftover pending file after interrupted unlink.
    await writeFile(
      path.join(qa, '.fleet/evidence/unfinished.json'),
      JSON.stringify({ ...previous, id: pending.id, finished: '2026-10-09T00:02:00Z' }),
    );
    const completed = await flowStatus(qa);
    assert.ok(completed.flows.every((flow) => flow.status === 'observed-passing'));
    assert.equal(completed.pendingAttempts.length, unrelatedAttempts.length);
    assert.equal((await maintenanceReport(qa)).summary.replayNeeded, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test('missing sources and application changes are reported independently of broken optional metadata', async () => {
  const { root, qa, app, observation } = await fixture();
  try {
    await observation('search', 'shared');
    await mkdir(path.join(qa, 'catalog'));
    await writeFile(path.join(qa, 'catalog/broken.json'), '{unfinished metadata');
    await rm(path.join(qa, 'specs/search.spec.ts'));
    await writeFile(path.join(app, 'changed.txt'), 'Application changed');
    const report = await maintenanceReport(qa);
    assert.deepEqual(report.replayCandidates[0].missingFiles, ['specs/search.spec.ts']);
    assert.ok(report.replayCandidates[0].reasons.includes('source-inspection-failed'));
    assert.ok(report.replayCandidates[0].reasons.includes('application-checkout-changed'));
    await assert.rejects(maintenanceReport(qa, { limit: 0 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('declared transitive app files scope evidence and select unrun flows from a worktree diff', async () => {
  const { root, qa, app, observation } = await fixture();
  const previousOverride = process.env.FLEET_APPLICATION_CHECKOUT;
  try {
    await mkdir(path.join(app, 'src'));
    await writeFile(path.join(app, 'src/feature.ts'), 'before');
    await writeFile(path.join(app, 'src/removed.ts'), 'removed');
    execFileSync('git', ['-C', app, 'add', '.']);
    execFileSync('git', [
      '-C',
      app,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'App source',
    ]);
    // Throwing at module scope proves metadata inspection never executes it.
    await writeFile(
      path.join(qa, 'parts/shared.ts'),
      "export const shared = true; export const appSources = ['src/**'] as const; throw new Error('must not execute');",
    );
    const record = await observation('search', 'shared');
    const { applicationSources } = await import('../lib/application-sources.ts');
    const appSources = await applicationSources(app, record.source.appSources ?? []);
    assert.deepEqual(Object.keys(appSources.files), ['src/feature.ts', 'src/removed.ts']);
    await writeFile(
      path.join(qa, '.fleet/evidence/search.json'),
      JSON.stringify({ ...record, applicationSources: appSources }),
    );
    await writeFile(path.join(app, 'unrelated.txt'), 'unrelated');
    assert.equal((await maintenanceReport(qa)).summary.replayNeeded, 0);
    await writeFile(path.join(app, 'src/feature.ts'), 'after');
    await rm(path.join(app, 'src/removed.ts'));
    await writeFile(path.join(app, 'src/added.ts'), 'untracked');
    const affected = (await maintenanceReport(qa)).replayCandidates[0];
    assert.deepEqual(affected.reasons, ['application-sources-changed']);
    assert.deepEqual(affected.applicationChangedFiles, ['src/feature.ts']);
    assert.deepEqual(affected.applicationAddedFiles, ['src/added.ts']);
    assert.deepEqual(affected.applicationRemovedFiles, ['src/removed.ts']);
    assert.equal((await flowStatus(qa)).flows[0].status, 'changed-since-observation');
    await writeFile(path.join(qa, 'specs/unrun.spec.ts'), "import '../parts/shared.ts';");
    await writeFile(path.join(qa, 'specs/unknown.spec.ts'), 'export const other = 1;');
    await writeFile(
      path.join(qa, 'fleet.json'),
      JSON.stringify({ schemaVersion: 1, name: 'qa', applicationCheckout: '/nonexistent' }),
    );
    process.env.FLEET_APPLICATION_CHECKOUT = app;
    const selected = (await maintenanceReport(qa, { appBase: 'HEAD' })).applicationDiff;
    assert.deepEqual(
      selected?.flows.map((flow) => [flow.spec, flow.status]),
      [
        ['specs/search.spec.ts', 'affected'],
        ['specs/unknown.spec.ts', 'undeclared'],
        ['specs/unrun.spec.ts', 'affected'],
      ],
    );
    assert.deepEqual(selected?.flows[2].changedFiles, [
      'src/added.ts',
      'src/feature.ts',
      'src/removed.ts',
    ]);
    await writeFile(
      path.join(qa, 'parts/shared.ts'),
      "export const appSources = [String('src/**')];",
    );
    await assert.rejects(workspaceSnapshot(qa, { spec: 'specs/unrun.spec.ts' }));
  } finally {
    if (previousOverride === undefined) delete process.env.FLEET_APPLICATION_CHECKOUT;
    else process.env.FLEET_APPLICATION_CHECKOUT = previousOverride;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
