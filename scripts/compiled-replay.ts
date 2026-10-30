// bun --no-env-file scripts/compiled-replay.ts /absolute/fresh/replay-directory
// Self-contained synthetic workspace; no donor files, application service or credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Observation } from '../lib/evidence.ts';
import { runtimeDirectory } from '../lib/runtime.ts';
import { directReplay } from './replay-support.ts';

function git(directory: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', directory, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function commit(directory: string, message: string): void {
  git(directory, ['add', '.']);
  git(directory, [
    '-c',
    'user.name=QA Fleet Replay',
    '-c',
    'user.email=qa-fleet-replay@localhost',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
}

function command(executable: string, args: string[], cwd: string): string {
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  }).trim();
}

async function json(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function assertContainedLinks(directory: string, root: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(file);
      assert.ok(target.startsWith(`${root}${path.sep}`), `External link: ${file}`);
    } else if (entry.isDirectory() && entry.name !== '.git') {
      await assertContainedLinks(file, root);
    }
  }
}

const requestedDirectory = process.argv[2];
if (!requestedDirectory || process.argv.length !== 3 || !path.isAbsolute(requestedDirectory))
  throw new Error('Usage: compiled-replay.ts /absolute/fresh/replay-directory');
const root = path.join(
  await realpath(path.dirname(requestedDirectory)),
  path.basename(requestedDirectory),
);
const sourceRuntime = await realpath(runtimeDirectory());
if (root === sourceRuntime || root.startsWith(`${sourceRuntime}${path.sep}`))
  throw new Error('Keep replay evidence outside the Fleet installation');
await mkdir(root);
const summary = {
  completed: false,
  scope:
    'Disposable synthetic HTML; relocated compiled runtime and independently installed workspace',
  cases: [] as Record<string, unknown>[],
};
async function record(receipt: Record<string, unknown>): Promise<void> {
  summary.cases.push(receipt);
  await json(path.join(root, 'summary.json'), summary);
  console.log(JSON.stringify(receipt));
}
await json(path.join(root, 'summary.json'), summary);
for (const key of Object.keys(process.env)) {
  if (key.startsWith('FLEET_') || key.startsWith('QA_FLEET_')) delete process.env[key];
}
process.env.FLEET_BASE_URL = 'http://127.0.0.1:1';

const original = path.join(root, 'original');
await mkdir(original);
const originalRuntime = path.join(original, 'runtime');
await cp(path.join(sourceRuntime, 'dist'), originalRuntime, {
  recursive: true,
  verbatimSymlinks: true,
});
const originalExecutable = path.join(originalRuntime, 'qa-fleet');
const originalApplication = path.join(original, 'synthetic-app');
await mkdir(originalApplication);
await writeFile(path.join(originalApplication, 'README.md'), '# Synthetic compiled identity\n');
git(originalApplication, ['init', '--quiet']);
commit(originalApplication, 'Create synthetic application identity');
const originalWorkspace = path.join(original, 'synthetic-qa');
const initialized = JSON.parse(
  command(
    originalExecutable,
    ['init', originalWorkspace, '--app-checkout', originalApplication],
    original,
  ),
);
assert.equal(initialized.workspace, originalWorkspace);
await mkdir(path.join(originalWorkspace, 'support'));
await writeFile(
  path.join(originalWorkspace, 'support/custom-fixtures.ts'),
  `import { test as base, expect } from '../fixtures.ts';
export const test = base.extend<{ repetitions: number }>({
  repetitions: async ({}, use) => { await use(2); },
});
export { expect };
`,
);
await writeFile(
  path.join(originalWorkspace, 'parts/synthetic.ts'),
  `import { type BrowserContext, type Page } from '@playwright/test';
type Context = { page: Page; context: BrowserContext };
export async function prepare({ page, context }: Context) {
  await context.route('**/*', (route) => route.abort());
  await page.setContent('<h1>Compiled counter</h1><button onclick="document.querySelector(&quot;output&quot;).textContent++">Increment</button><output>0</output>');
  return { initial: 0 };
}
export async function increment({ page }: Context) {
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  return Number(await page.locator('output').innerText());
}
export async function untaken({ page }: Context) {
  await page.getByRole('heading').fill('This branch must never run');
}
`,
);
await writeFile(
  path.join(originalWorkspace, 'specs/counter.spec.ts'),
  `import { test, expect } from '../support/custom-fixtures.ts';
import { prepare, increment, untaken } from '../parts/synthetic.ts';
test('authored ordinary helpers', async ({ page, context, repetitions }) => {
  const result = await prepare({ page, context });
  expect(result).toEqual({ initial: 0 });
  await test.step('ordinary composition', async () => {
    for (let count = 1; count <= repetitions; count++) {
      expect(await increment({ page, context })).toBe(count);
    }
  });
  if (result.initial > 0) await untaken({ page, context });
  await expect(page.locator('output')).toHaveText(String(repetitions));
});
test('ordinary assertions', async ({ page }) => {
  await page.setContent('<label>Message<input value="Before"></label>');
  await page.getByRole('textbox', { name: 'Message' }).fill('After');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('After');
});
`,
);
commit(originalWorkspace, 'Record portable synthetic workspace');
assert.ok(git(originalWorkspace, ['ls-files', 'bun.lock']), 'Lockfile must travel with workspace');
assert.ok(
  git(originalWorkspace, ['ls-files', 'vendor']),
  'Runtime archive must travel with workspace',
);
await record({
  name: 'compiled-scaffold',
  catalogRegistrations: 0,
  lockfileCommitted: true,
});

const relocated = path.join(root, 'relocated');
await mkdir(relocated);
const runtime = path.join(relocated, 'runtime');
await rename(originalRuntime, runtime);
const application = path.join(relocated, 'synthetic-app');
const workspace = path.join(relocated, 'synthetic-qa');
git(relocated, ['clone', '--quiet', '--no-local', originalApplication, application]);
git(relocated, ['clone', '--quiet', '--no-local', originalWorkspace, workspace]);
for (const checkout of [application, workspace]) git(checkout, ['remote', 'remove', 'origin']);
await rm(original, { recursive: true });
await assert.rejects(lstat(original));
await assert.rejects(lstat(path.join(workspace, 'node_modules')));
command(
  process.execPath,
  ['--no-env-file', 'install', '--frozen-lockfile', '--ignore-scripts'],
  workspace,
);
assert.equal(
  git(workspace, ['status', '--porcelain']),
  '',
  'Frozen install must not modify committed files',
);
await assertContainedLinks(workspace, workspace);
await assertContainedLinks(runtime, runtime);
for (const relative of ['fleet.json', 'package.json', 'fixtures.ts', 'bun.lock']) {
  const source = await readFile(path.join(workspace, relative), 'utf8');
  assert.equal(source.includes(original), false, `${relative} must not reference original paths`);
  assert.equal(
    source.includes(sourceRuntime),
    false,
    `${relative} must not reference the source installation`,
  );
}
command(process.execPath, ['--no-env-file', 'run', 'typecheck'], workspace);
await record({
  name: 'fresh-clone-install',
  originalRemoved: true,
  containedLinks: true,
  frozenInstall: 'passed',
  typecheck: 'passed',
  workspace,
  runtime,
});

const identityPath = path.join(workspace, '.fleet/target-identity.json');
const identityJson = ' { "schemaVersion": 1, "ok": true }\n';
await mkdir(path.dirname(identityPath), { recursive: true });
await writeFile(identityPath, identityJson);
const verifyArgs = [
  'verify',
  '--target-identity',
  identityPath,
  '--workspace',
  workspace,
  '--spec',
  'specs/counter.spec.ts',
  '--environment',
  'compiled-synthetic',
  '--timeout',
  '30',
  '--workers',
  '1',
];
const executable = path.join(runtime, 'qa-fleet');
const verified = JSON.parse(command(executable, verifyArgs, workspace));
assert.equal(verified.observedPassing, true, `Compiled verification: ${verified.causeCode}`);
assert.equal(verified.cleanup.complete, true);
assert.equal(verified.sourcesUnchanged, true);
assert.equal(verified.test.stats.expected, 2);
assert.ok(verified.checkpoint);
const observation = JSON.parse(await readFile(verified.evidencePath, 'utf8')) as Observation;
assert.equal(observation.spec, 'specs/counter.spec.ts');
assert.equal(observation.observedPassing, true);
assert.equal(observation.targetIdentity?.json, identityJson);
const compiledStatus = JSON.parse(
  command(executable, ['status', '--workspace', workspace], workspace),
);
assert.equal(compiledStatus.flows[0].targetIdentity.json, identityJson);
assert.equal(compiledStatus.flows[0].targetIdentity.hash, observation.targetIdentity?.hash);
assert.equal(git(workspace, ['rev-parse', 'HEAD']), verified.checkpoint);
await record({
  name: 'compiled-verification',
  observedPassing: true,
  cleanupComplete: true,
  checkpoint: verified.checkpoint,
  evidence: verified.evidencePath,
});

const localVerified = JSON.parse(
  command(process.execPath, ['--no-env-file', 'run', 'fleet', ...verifyArgs], workspace),
);
assert.equal(
  localVerified.observedPassing,
  true,
  `Workspace CLI verification: ${localVerified.causeCode}`,
);
assert.equal(localVerified.cleanup.complete, true);
const status = JSON.parse(
  command(
    process.execPath,
    ['--no-env-file', 'run', 'fleet', 'status', '--workspace', workspace],
    workspace,
  ),
) as { flows: { spec: string }[]; pendingAttempts: unknown[] };
assert.equal(status.flows.length, 1);
assert.equal(status.flows[0]?.spec, 'specs/counter.spec.ts');
assert.equal(status.pendingAttempts.length, 0);
await record({
  name: 'workspace-local-cli',
  observedPassing: true,
  cleanupComplete: true,
  recordedFlowScopes: status.flows.length,
  evidence: localVerified.evidencePath,
});

const observationsBefore = await readdir(path.join(workspace, '.fleet/evidence'));
const checkpointBefore = git(workspace, ['rev-parse', 'HEAD']);
const direct = await directReplay(workspace, 'specs/counter.spec.ts', 2, executable);
assert.deepEqual(await readdir(path.join(workspace, '.fleet/evidence')), observationsBefore);
assert.equal(git(workspace, ['rev-parse', 'HEAD']), checkpointBefore);
await record({
  name: 'direct-playwright',
  ...direct,
  observationsCreated: 0,
  checkpointsCreated: 0,
});
summary.completed = true;
await json(path.join(root, 'summary.json'), summary);
console.log(`Compiled relocation integration complete: ${path.join(root, 'summary.json')}`);
