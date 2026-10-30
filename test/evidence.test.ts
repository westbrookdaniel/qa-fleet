import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applicationSnapshot,
  checkpoint,
  digest,
  flowStatus,
  runtimeSourceHash,
  workspaceSnapshot,
} from '../lib/evidence.ts';
import { runtimeDirectory } from '../lib/runtime.ts';
import { writePortableDependencies } from '../lib/runtime-package.ts';
import { installTestDependencies } from './portable-workspace-helpers.ts';

const selectedScope = { spec: 'specs/selected.spec.ts' };

async function scopedWorkspace() {
  const root = await sourceWorkspace();
  await writeFile(path.join(root, 'shared.ts'), 'export const expected = 1;\n');
  await writeFile(
    path.join(root, 'parts/check.ts'),
    "import { expected } from '../shared';\nexport function check() { return expected; }\n",
  );
  await writeFile(
    path.join(root, selectedScope.spec),
    "import { check } from '../parts/check'; export const selected = check;\n",
  );
  return root;
}

test('scoped snapshots follow local helpers and ignore unrelated catalogue growth without evaluating code', async () => {
  const root = await scopedWorkspace();
  try {
    await writeFile(
      path.join(root, 'shared.ts'),
      'throw new Error("must never evaluate"); export const expected = 1;\n',
    );
    const before = await workspaceSnapshot(root, selectedScope);
    assert.equal(before.dependencyMode, 'static-imports');
    assert.ok(before.files['shared.ts']);
    await writeFile(path.join(root, 'parts/unrelated.ts'), 'export const unrelated = true;');
    await mkdir(path.join(root, 'catalog'));
    await writeFile(path.join(root, 'catalog/optional.json'), '{unfinished discovery metadata');
    assert.equal((await workspaceSnapshot(root, selectedScope)).hash, before.hash);
    await writeFile(path.join(root, 'shared.ts'), 'export const expected = 2;\n');
    assert.notEqual((await workspaceSnapshot(root, selectedScope)).hash, before.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scoped snapshots follow re-exports and conservatively cover dynamic imports while excluding private files', async () => {
  const root = await scopedWorkspace();
  try {
    await writeFile(
      path.join(root, 'parts/check.ts'),
      "export { expected as check } from '../shared.js';\n",
    );
    assert.ok((await workspaceSnapshot(root, selectedScope)).files['shared.ts']);
    await writeFile(
      path.join(root, 'parts/check.ts'),
      'export async function check(name: string) { return import(name); }\n',
    );
    await mkdir(path.join(root, '.auth'));
    await writeFile(path.join(root, '.auth/state.json'), 'SYNTHETIC_PRIVATE');
    await writeFile(path.join(root, '.env.local'), 'SYNTHETIC_PRIVATE');
    const before = await workspaceSnapshot(root, selectedScope);
    assert.equal(before.dependencyMode, 'workspace-fallback');
    assert.ok(before.files['shared.ts']);
    assert.ok(!before.files['.auth/state.json']);
    assert.ok(!before.files['.env.local']);
    await writeFile(path.join(root, 'shared.ts'), 'export const expected = 3;\n');
    assert.notEqual((await workspaceSnapshot(root, selectedScope)).hash, before.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scoped source imports refuse symlinks and private authentication files', async () => {
  const root = await scopedWorkspace();
  try {
    await symlink(path.join(root, 'shared.ts'), path.join(root, 'alias.ts'));
    await writeFile(
      path.join(root, 'parts/check.ts'),
      "export { expected as check } from '../alias.ts';\n",
    );
    await assert.rejects(workspaceSnapshot(root, selectedScope), /symbolic links/);
    await mkdir(path.join(root, '.auth'));
    await writeFile(path.join(root, '.auth/state.json'), '{}');
    await writeFile(
      path.join(root, 'parts/check.ts'),
      "import state from '../.auth/state.json'; export function check() { return state; }\n",
    );
    await assert.rejects(workspaceSnapshot(root, selectedScope), /authentication files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scoped source includes type-only, mixed and re-exported dependencies needed to typecheck a saved part', async () => {
  const root = await scopedWorkspace();
  try {
    await writeFile(path.join(root, 'context.ts'), 'export type Context = { value: string };\n');
    await writeFile(path.join(root, 'data.ts'), 'export type Data = number;\n');
    await writeFile(
      path.join(root, 'parts/check.ts'),
      `
import /* preserve comments */ type { Context } from '../context';
export { type Data } from '../data';
const text = "import type Missing from './not-real'";
export function check(context: Context) { return context.value + text; }
`,
    );
    const source = await workspaceSnapshot(root, selectedScope);
    assert.ok(source.files['context.ts']);
    assert.ok(source.files['data.ts']);
    assert.ok(source.checkpointFiles?.includes('context.ts'));
    assert.ok(source.checkpointFiles?.includes('data.ts'));
    assert.equal(source.dependencyMode, 'static-imports');
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { paths: { '@qa/*': ['./*'] } },
      }),
    );
    await writeFile(
      path.join(root, 'parts/check.ts'),
      "import type { Context } from '@qa/context'; export function check(value: Context) { return value; }\n",
    );
    const aliased = await workspaceSnapshot(root, selectedScope);
    assert.ok(aliased.files['context.ts']);
    assert.ok(aliased.checkpointFiles?.includes('context.ts'));
    assert.equal(aliased.dependencyMode, 'static-imports');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real route regex source inspection terminates and fallback scopes refuse automatic checkpoint', async () => {
  const root = await sourceWorkspace();
  try {
    // Slash-heavy route regexes and an extensionless import must not stall source inspection.
    await writeFile(
      path.join(root, 'parts/context.ts'),
      'export const itemsPath = /^\\/(?:app|[a-z]{2}(?:-[A-Z]{2})?)\\/[^/?#]+\\/[^/?#]+\\/items\\/?$/;\n',
    );
    await writeFile(
      path.join(root, 'parts/actions.ts'),
      "import { itemsPath } from './context';\nexport const isItems = (path: string) => itemsPath.test(path) && !/[?#]/.test(path);\n",
    );
    const script = `import { importedSources } from ${JSON.stringify(path.resolve(import.meta.dir, '../lib/source-scope.ts'))}; console.log(JSON.stringify(await importedSources(${JSON.stringify(root)}, ['parts/actions.ts'])));`;
    const output = execFileSync(process.execPath, ['--no-env-file', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ok(JSON.parse(output).staticFiles.includes('parts/context.ts'));
    const source = await workspaceSnapshot(root);
    await assert.rejects(
      checkpoint(root, { ...source, dependencyMode: 'workspace-fallback' }),
      /static source dependencies/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint binds committed blobs to observed bytes and excludes unrelated candidates', async () => {
  const root = await scopedWorkspace();
  try {
    await writeFile(path.join(root, '.gitignore'), '.fleet/\nnode_modules\n');
    for (const file of ['README.md', 'AGENTS.md']) await writeFile(path.join(root, file), file);
    localGit(root, ['init', '-b', 'main']);
    await writeFile(path.join(root, 'parts/unexecuted.ts'), 'export const candidate = true;');
    await writeFile(path.join(root, 'private.txt'), 'SYNTHETIC_PRIVATE');
    localGit(root, ['add', '--', 'private.txt']);
    const source = await workspaceSnapshot(root, selectedScope);
    const commit = await checkpoint(root, source);
    assert.equal(
      digest(localGit(root, ['show', `${commit}:shared.ts`])),
      source.files['shared.ts'],
    );
    assert.ok(
      !localGit(root, ['ls-tree', '-r', '--name-only', commit]).includes('parts/unexecuted.ts'),
    );
    assert.equal(localGit(root, ['diff', '--cached', '--name-only']).trim(), 'private.txt');
    await writeFile(path.join(root, 'shared.ts'), 'export const expected = 42;\n');
    await assert.rejects(checkpoint(root, source), /Source changed before checkpoint/);
    assert.equal(localGit(root, ['rev-parse', 'HEAD']).trim(), commit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function sourceWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-evidence-test-'));
  for (const filename of [
    'fleet.json',
    'fixtures.ts',
    'playwright.config.ts',
    'package.json',
    'tsconfig.json',
  ]) {
    await writeFile(path.join(root, filename), '{}');
  }
  for (const directory of ['parts/internal', 'specs', 'vendor', '.fleet']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writePortableDependencies(root, runtimeDirectory());
  await installTestDependencies(root);
  await writeFile(path.join(root, 'parts/internal/helper.ts'), 'export const value = 1;');
  return root;
}

test('snapshot includes nested reusable helpers while excluding runtime and generated files', async () => {
  const root = await sourceWorkspace();
  const external = await mkdtemp(path.join(tmpdir(), 'fleet-evidence-dependencies-'));
  try {
    await symlink(external, path.join(root, '.auth'));
    await mkdir(path.join(root, 'generated'));
    await writeFile(path.join(root, 'generated/temporary.spec.ts'), 'temporary');
    const before = await workspaceSnapshot(root);
    assert.ok(Object.hasOwn(before.files, 'parts/internal/helper.ts'));
    assert.ok(!Object.hasOwn(before.files, 'generated/temporary.spec.ts'));
    await writeFile(path.join(root, 'parts/internal/helper.ts'), 'export const value = 2;');
    const after = await workspaceSnapshot(root);
    assert.notEqual(before.hash, after.hash);
    assert.notEqual(
      before.files['parts/internal/helper.ts'],
      after.files['parts/internal/helper.ts'],
    );
  } finally {
    await rm(root, { recursive: true });
    await rm(external, { recursive: true });
  }
});

test('snapshot refuses reusable directory symlinks even when their target is empty', async () => {
  const root = await sourceWorkspace();
  const external = await mkdtemp(path.join(tmpdir(), 'fleet-evidence-symlink-'));
  try {
    await rm(path.join(root, 'parts'), { recursive: true });
    await symlink(external, path.join(root, 'parts'));
    await assert.rejects(workspaceSnapshot(root), /symlink|symbolic|regular directory/i);
  } finally {
    await rm(root, { recursive: true });
    await rm(external, { recursive: true });
  }
});

test('compiled runtime snapshots hash the executable when controller source directories are absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-compiled-snapshot-'));
  try {
    for (const file of ['fixtures.ts', 'package.json', 'bunfig.toml', 'qa-fleet'])
      await writeFile(path.join(root, file), file);
    for (const name of ['@playwright/test', 'playwright', 'playwright-core', 'typescript']) {
      await mkdir(path.join(root, 'node_modules', name), { recursive: true });
      await writeFile(path.join(root, 'node_modules', name, 'package.json'), '{}');
    }
    const before = await runtimeSourceHash(root, path.join(root, 'qa-fleet'));
    await writeFile(path.join(root, 'qa-fleet'), 'changed compiled controller');
    assert.notEqual(await runtimeSourceHash(root, path.join(root, 'qa-fleet')), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime fingerprint changes with Bun version while source and dependencies stay unchanged', async () => {
  const runtime = runtimeDirectory();
  const current = await runtimeSourceHash(runtime, process.execPath);
  assert.equal(await runtimeSourceHash(runtime, process.execPath, Bun.version), current);
  assert.notEqual(
    await runtimeSourceHash(runtime, process.execPath, '0.0.0-synthetic-runtime'),
    current,
  );
});

function localGit(root: string, args: string[]) {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=QA Test',
      '-c',
      'user.email=qa-test@localhost',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

test('checkpoints include approved deletions and workspace guidance while preserving unrelated staging', async () => {
  const root = await sourceWorkspace();
  try {
    await writeFile(path.join(root, '.gitignore'), '.fleet/\nnode_modules\n');
    for (const file of ['README.md', 'AGENTS.md']) await writeFile(path.join(root, file), file);
    localGit(root, ['init', '-b', 'main']);
    await writeFile(path.join(root, 'private.txt'), 'SYNTHETIC_PRIVATE');
    localGit(root, ['add', '--', 'private.txt']);
    await checkpoint(root, await workspaceSnapshot(root));
    assert.equal(localGit(root, ['diff', '--cached', '--name-only']).trim(), 'private.txt');
    assert.ok(localGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']).includes('AGENTS.md'));
    assert.ok(!localGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']).includes('private.txt'));
    await rm(path.join(root, 'parts/internal/helper.ts'));
    await checkpoint(root, await workspaceSnapshot(root));
    assert.ok(
      !localGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']).includes(
        'parts/internal/helper.ts',
      ),
    );
    assert.equal(localGit(root, ['diff', '--cached', '--name-only']).trim(), 'private.txt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function passingObservation(root: string) {
  const app = path.join(root, '.fleet/application');
  await mkdir(app);
  localGit(app, ['init', '-b', 'main']);
  localGit(app, ['commit', '--allow-empty', '-m', 'Synthetic application']);
  await writeFile(
    path.join(root, 'fleet.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'qa',
      applicationCheckout: app,
    }),
  );
  const source = await workspaceSnapshot(root, selectedScope);
  const observation = {
    schemaVersion: 2,
    id: 'passing',
    finished: '2026-10-09T00:00:00Z',
    environment: 'local',
    targetOrigin: 'http://localhost:3000',
    parametersHash: 'same-inputs',
    deployment: null,
    source,
    application: await applicationSnapshot(app),
    spec: selectedScope.spec,
    specHash: source.files[selectedScope.spec],
    observedPassing: true,
    result: { test: { verdict: 'passed' }, cleanup: { complete: true } },
  };
  await writeFile(path.join(root, '.fleet/evidence/passing.json'), JSON.stringify(observation));
  return observation;
}

test('flow status reports the latest failed replay without requiring a catalogue', async () => {
  const root = await scopedWorkspace();
  try {
    const passing = await passingObservation(root);
    await writeFile(
      path.join(root, '.fleet/evidence/failure.json'),
      JSON.stringify({
        ...passing,
        id: 'failure',
        finished: '2026-10-09T00:01:00Z',
        observedPassing: false,
        result: { test: { verdict: 'failed' }, cleanup: { complete: true } },
      }),
    );
    const status = await flowStatus(root);
    assert.equal(status.flows.length, 1);
    assert.equal(status.flows[0].status, 'failed');
    assert.equal(status.flows[0].testVerdict, 'failed');
    assert.deepEqual(status.pendingAttempts, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('flow dependencies retain source freshness without claiming imported helpers executed', async () => {
  const root = await scopedWorkspace();
  try {
    await passingObservation(root);
    await writeFile(path.join(root, '.fleet/evidence/interrupted.json'), '{"schemaVersion":');
    await writeFile(path.join(root, 'parts/unrelated.ts'), 'export const unrelated = true;');
    const status = await flowStatus(root);
    assert.equal(status.flows[0].status, 'observed-passing');
    assert.ok(status.flows[0].sourceDependencies.includes('parts/check.ts'));
    assert.equal('observedPartIds' in status.flows[0], false);
    await writeFile(path.join(root, 'shared.ts'), 'export const expected = 4;\n');
    assert.equal((await flowStatus(root)).flows[0].status, 'changed-since-observation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test('schema-one observations remain historical and cannot become current passing evidence', async () => {
  const root = await scopedWorkspace();
  try {
    const passing = await passingObservation(root);
    await writeFile(
      path.join(root, '.fleet/evidence/passing.json'),
      JSON.stringify({
        ...passing,
        schemaVersion: 1,
        observedPartIds: ['legacy.claim'],
      }),
    );
    assert.equal((await flowStatus(root)).flows[0].status, 'historical-evidence');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('target identity preserves caller JSON bytes and rejects non-object receipts', async () => {
  const { readTargetIdentity, digest } = await import('../lib/evidence.ts');
  const directory = await mkdtemp(path.join(tmpdir(), 'fleet-target-'));
  try {
    const filename = path.join(directory, 'target.json');
    const json = ' { "schemaVersion": 1, "ok": true }\n';
    await writeFile(filename, json);
    const identity = await readTargetIdentity(filename);
    assert.equal(identity.json, json);
    assert.equal(identity.hash, digest(json));
    assert.deepEqual(identity.value, { schemaVersion: 1, ok: true });
    for (const invalid of ['null', '[]', 'true', '{']) {
      await writeFile(filename, invalid);
      await assert.rejects(readTargetIdentity(filename));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
