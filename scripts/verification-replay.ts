// bun --no-env-file scripts/verification-replay.ts /absolute/fresh/replay-directory [--direct]
// Disposable local HTML only. No application checkout, authentication or external requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseLeases, retireBrowsers } from '../lib/custody.ts';
import { flowStatus, type Observation, verifyFlow } from '../lib/evidence.ts';
import { runtimeDirectory } from '../lib/runtime.ts';
import { initializeWorkspace } from '../lib/workspace.ts';
import { directReplay } from './replay-support.ts';

function git(root: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', root, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function head(root: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    return null;
  }
}

async function json(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const helpers = `import { type BrowserContext, type Page } from '@playwright/test';
type Context = { page: Page; context: BrowserContext };

export async function prepare({ page, context }: Context) {
  await context.route('**/*', (route) => route.abort());
  await page.setContent('<h1>Local counter</h1><button onclick="const output = document.getElementsByTagName(&quot;output&quot;)[0]; output.textContent = String(Number(output.textContent) + 1)">Increment</button><output data-testid="count">0</output><p data-testid="label">Ready</p>');
  return { label: await page.getByRole('heading').innerText(), initial: 0 };
}

export async function increment({ page }: Context) {
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  return Number(await page.getByTestId('count').innerText());
}

export async function readValue({ page }: Context, args: { field: string }) {
  return { field: args.field, value: await page.getByTestId(args.field).innerText() };
}

export async function untaken({ page }: Context) {
  await page.getByTestId('label').fill('This branch must not execute');
}

`;

const customFixtures = `import { test as base, expect } from '../fixtures.ts';
export const test = base.extend<{ repetitions: number }>({
  repetitions: async ({}, use) => { await use(3); },
});
export { expect };
`;

const passingSpec = `import { test, expect } from '../support/custom-fixtures.ts';
import { prepare, increment, readValue, untaken } from '../parts/synthetic.ts';

test.describe('counter interactions', () => {
  test('same leaf name', async ({ page, context, repetitions }) => {
    const initial = await prepare({ page, context });
    expect(initial).toEqual({ label: 'Local counter', initial: 0 });
    await test.step('ordinary nested group', async () => {
      for (let count = 1; count <= repetitions; count++) {
        const result = await increment({ page, context });
        expect(result).toBe(count);
      }
      const [count, label] = await Promise.all([
        readValue({ page, context }, { field: 'count' }),
        readValue({ page, context }, { field: 'label' }),
      ]);
      expect(count).toEqual({ field: 'count', value: String(repetitions) });
      expect(label).toEqual({ field: 'label', value: 'Ready' });
    });
    await expect(page.getByTestId('count')).toHaveText('3');
  });
});

test.describe('conditional composition', () => {
  test('same leaf name', async ({ page, context }) => {
    const initial = await prepare({ page, context });
    if (initial.initial > 0) await untaken({ page, context });
    await expect(page.getByRole('heading')).toHaveText('Local counter');
    await expect(page.getByTestId('label')).toHaveText('Ready');
  });
});

test('ordinary assertions need no helper library', async ({ page }) => {
  await page.setContent('<label>Message<input value="Hello"></label>');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello');
  await page.getByRole('textbox', { name: 'Message' }).fill('Edited locally');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Edited locally');
});
`;

interface Scenario {
  name: string;
  source: string;
  expectedStats: { expected: number; unexpected: number; flaky: number; skipped: number };
  expectedSourcesUnchanged?: boolean;
  restoreHelper?: boolean;
  overriddenBrowser?: boolean;
}

const scenarios: Scenario[] = [
  {
    name: 'skipped-test',
    source: `test('successful sibling', async ({ page, context }) => { await prepare({ page, context }); });
test.skip('required check was skipped', async ({ page, context }) => { await increment({ page, context }); });`,
    expectedStats: { expected: 1, unexpected: 0, flaky: 0, skipped: 1 },
  },
  {
    name: 'expected-failure',
    source: `test('expected failure is not observed passing', async ({ page, context }) => {
  test.fail();
  await prepare({ page, context });
  await expect(page.getByRole('heading')).toHaveText('Incorrect heading', { timeout: 300 });
});`,
    expectedStats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
  },
  {
    name: 'retried-test',
    source: `test.describe.configure({ retries: 1 });
test('a retry does not establish a clean initial pass', async ({ page, context }, testInfo) => {
  await prepare({ page, context });
  await expect(page.getByRole('heading')).toHaveText(testInfo.retry ? 'Local counter' : 'Wrong on first attempt', { timeout: 300 });
});`,
    expectedStats: { expected: 0, unexpected: 0, flaky: 1, skipped: 0 },
  },
  {
    name: 'assertion-failure',
    source: `test('a real wrong result does not checkpoint', async ({ page, context }) => {
  await prepare({ page, context });
  await increment({ page, context });
  await expect(page.getByTestId('count')).toHaveText('999', { timeout: 300 });
});`,
    expectedStats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
  },
  {
    name: 'mutated-helper',
    source: `test('post-execution source edit invalidates evidence', async ({ page, context }) => {
  await prepare({ page, context });
  await expect(page.getByRole('heading')).toHaveText('Local counter');
  await appendFile(new URL('../parts/synthetic.ts', import.meta.url), '\\n// concurrent edit\\n');
});`,
    expectedStats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    expectedSourcesUnchanged: false,
    restoreHelper: true,
  },
  {
    name: 'deleted-helper',
    source: `test('deleted source leaves a completed nonpassing receipt', async ({ page, context }) => {
  await prepare({ page, context });
  await expect(page.getByRole('heading')).toHaveText('Local counter');
  await unlink(new URL('../parts/synthetic.ts', import.meta.url));
});`,
    expectedStats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    expectedSourcesUnchanged: false,
    restoreHelper: true,
  },
  {
    name: 'overridden-browser',
    source: `test('an unregistered browser cannot produce protected evidence', async ({ page, context }) => {
  await prepare({ page, context });
  await expect(page.getByRole('heading')).toHaveText('Local counter');
});`,
    expectedStats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    overriddenBrowser: true,
  },
];

function overriddenBrowserFixture(marker: string): string {
  return `import { test as fleetTest, expect } from '../fixtures.ts';
import { chromium } from '@playwright/test';
const marker = ${JSON.stringify(marker)};
const test = fleetTest.extend({
  browser: [async ({}, use) => {
    const server = await chromium.launchServer({ args: ['--qa-fleet-custody=' + marker] });
    try {
      // Deliberately not the runner's browser receipt. The outer integration harness owns recovery.
      await appendFile('.fleet/override-browser.jsonl', JSON.stringify({ marker, pid: server.process().pid, trace: 'off' }) + '\\n');
      const browser = await chromium.connect(server.wsEndpoint());
      try { await use(browser); } finally { await browser.close(); }
    } finally { await server.close(); }
  }, { scope: 'worker' }],
});\n`;
}

async function recoverOverriddenBrowser(workspace: string, marker: string) {
  const cleanup = await retireBrowsers(
    marker,
    path.join(workspace, '.fleet/override-browser.jsonl'),
  );
  assert.equal(cleanup.complete, true, 'The deliberately overridden control browser must retire');
  assert.equal(cleanup.registered?.length, 1, 'Independent control receipt identifies one browser');
  const locks = path.join(tmpdir(), `qa-fleet-${process.getuid?.()}`, 'locks');
  const ownedLeases: string[] = [];
  for (const entry of await readdir(locks)) {
    const directory = path.join(locks, entry);
    const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
    if (owner.pid === process.pid && owner.resource === `checkout:${workspace}`)
      ownedLeases.push(directory);
  }
  assert.equal(ownedLeases.length, 1, 'Missing-custody control must retain its own checkout lease');
  await releaseLeases(ownedLeases);
  return { independentCleanupComplete: true, ownedRetainedLeasesReleased: ownedLeases.length };
}

const requestedDirectory = process.argv[2];
if (!requestedDirectory || process.argv.slice(3).some((arg) => arg !== '--direct'))
  throw new Error('Usage: verification-replay.ts /absolute/fresh/replay-directory [--direct]');
if (!path.isAbsolute(requestedDirectory)) throw new Error('Replay directory must be absolute');
const root = path.join(
  await realpath(path.dirname(requestedDirectory)),
  path.basename(requestedDirectory),
);
const runtime = await realpath(runtimeDirectory());
if (root === runtime || root.startsWith(`${runtime}${path.sep}`))
  throw new Error('Keep replay evidence outside the Fleet installation');
await mkdir(root);
const application = path.join(root, 'synthetic-app');
await mkdir(application);
await writeFile(
  path.join(application, 'README.md'),
  '# Disposable synthetic application identity\n',
);
git(application, ['init', '--quiet']);
git(application, ['add', 'README.md']);
git(application, [
  '-c',
  'user.name=QA Fleet Replay',
  '-c',
  'user.email=qa-fleet-replay@localhost',
  'commit',
  '--quiet',
  '-m',
  'Create synthetic application identity',
]);

for (const key of Object.keys(process.env)) {
  if (key.startsWith('FLEET_') || key.startsWith('QA_FLEET_')) delete process.env[key];
}
process.env.FLEET_BASE_URL = 'http://127.0.0.1:1';

async function createWorkspace(name: string, source: string) {
  const workspace = path.join(root, name);
  await initializeWorkspace({ directory: workspace, applicationCheckout: application });
  await mkdir(path.join(workspace, 'specs'), { recursive: true });
  await mkdir(path.join(workspace, 'support'));
  await writeFile(path.join(workspace, 'parts/synthetic.ts'), helpers);
  await writeFile(path.join(workspace, 'support/custom-fixtures.ts'), customFixtures);
  await writeFile(path.join(workspace, 'specs/counter.spec.ts'), source);
  // A generated workspace must typecheck authored specs and their extended fixtures.
  execFileSync(process.execPath, ['run', 'typecheck'], {
    cwd: workspace,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return workspace;
}

async function verify(workspace: string, expectedCleanup = true) {
  const result = await verifyFlow({
    workspace,
    spec: 'specs/counter.spec.ts',
    environment: 'synthetic-ordinary-helpers',
    timeout: 30,
    workers: 1,
  });
  assert.equal(result.cleanup.complete, expectedCleanup, 'Expected browser custody result');
  assert.equal((await readdir(path.join(workspace, '.fleet/evidence'))).length, 1);
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as Observation;
  return { result, evidence };
}

const summary: {
  scope: string;
  application: string;
  cases: Record<string, unknown>[];
  completed: boolean;
} = {
  scope:
    'Disposable synthetic browser HTML; no real application, authentication or external requests',
  application,
  cases: [],
  completed: false,
};
async function record(receipt: Record<string, unknown>) {
  summary.cases.push(receipt);
  await json(path.join(root, 'summary.json'), summary);
  console.log(JSON.stringify(receipt));
}

await json(path.join(root, 'summary.json'), summary);

const passingWorkspace = await createWorkspace('passing', passingSpec);
const passing = await verify(passingWorkspace);
assert.equal(
  passing.result.observedPassing,
  true,
  `Ordinary helper composition must pass: ${passing.result.causeCode}`,
);
assert.ok(passing.result.checkpoint, 'A verified authored spec needs a local checkpoint');
assert.equal(passing.result.test.stats?.expected, 3);
assert.equal(passing.result.test.stats?.unexpected, 0);
assert.equal(passing.result.test.stats?.skipped, 0);
assert.equal(head(passingWorkspace), passing.result.checkpoint);
const status = await flowStatus(passingWorkspace);
assert.equal(status.flows.length, 1);
assert.equal(status.pendingAttempts.length, 0);
assert.equal(passing.evidence.spec, 'specs/counter.spec.ts');
assert.equal(passing.evidence.observedPassing, true);
for (const source of [
  'specs/counter.spec.ts',
  'support/custom-fixtures.ts',
  'parts/synthetic.ts',
]) {
  const committed: Buffer = execFileSync('git', [
    '-C',
    passingWorkspace,
    'show',
    `${passing.result.checkpoint}:${source}`,
  ]);
  assert.deepEqual(
    committed,
    await readFile(path.join(passingWorkspace, source)),
    `${source} checkpoint bytes must match tested source`,
  );
}
await record({
  name: 'ordinary-helper-composition',
  tests: 3,
  observedPassing: true,
  catalogRegistrations: 0,
  checkpoint: passing.result.checkpoint,
  evidence: passing.result.evidencePath,
});

if (process.argv.includes('--direct')) {
  const before = await readdir(path.join(passingWorkspace, '.fleet/evidence'));
  const direct = await directReplay(passingWorkspace, 'specs/counter.spec.ts', 3);
  assert.deepEqual(
    await readdir(path.join(passingWorkspace, '.fleet/evidence')),
    before,
    'Ordinary replay must not create Fleet observations',
  );
  assert.equal(
    head(passingWorkspace),
    passing.result.checkpoint,
    'Ordinary replay must not create a checkpoint',
  );
  await record({
    name: 'direct-playwright',
    ...direct,
    observationsCreated: 0,
    checkpointsCreated: 0,
  });
}

for (const scenario of scenarios) {
  const controlMarker = scenario.overriddenBrowser ? randomUUID() : null;
  const fixtures = controlMarker
    ? overriddenBrowserFixture(controlMarker)
    : "import { test, expect } from '../fixtures.ts';\n";
  const source = `import { appendFile, unlink } from 'node:fs/promises';
${fixtures}
import { prepare, increment } from '../parts/synthetic.ts';
${scenario.source}\n`;
  const workspace = await createWorkspace(scenario.name, source);
  const before = head(workspace);
  const { result, evidence } = await verify(workspace, !scenario.overriddenBrowser);
  const independentRecovery = controlMarker
    ? await recoverOverriddenBrowser(workspace, controlMarker)
    : null;
  assert.equal(result.observedPassing, false, `${scenario.name}: observedPassing`);
  if (scenario.expectedSourcesUnchanged !== undefined)
    assert.equal(
      result.sourcesUnchanged,
      scenario.expectedSourcesUnchanged,
      `${scenario.name}: sourcesUnchanged`,
    );
  if (scenario.restoreHelper) await writeFile(path.join(workspace, 'parts/synthetic.ts'), helpers);
  assert.equal(evidence.observedPassing, false);
  for (const [stat, expected] of Object.entries(scenario.expectedStats)) {
    assert.equal(
      result.test.stats?.[stat as keyof typeof scenario.expectedStats],
      expected,
      `${scenario.name}: the intended control must execute (${stat})`,
    );
  }
  assert.equal((await flowStatus(workspace)).pendingAttempts.length, 0);
  assert.equal(result.checkpoint, null, `${scenario.name}: no checkpoint`);
  assert.equal(head(workspace), before, `${scenario.name}: Git HEAD unchanged`);
  await record({
    name: scenario.name,
    testVerdict: result.test.verdict,
    observedPassing: result.observedPassing,
    sourcesUnchanged: result.sourcesUnchanged,
    cleanupComplete: result.cleanup.complete,
    checkpoint: result.checkpoint,
    evidence: result.evidencePath,
    ...(independentRecovery ?? {}),
  });
}
summary.completed = true;
await json(path.join(root, 'summary.json'), summary);
console.log(
  `Ordinary-helper verification complete: ${summary.cases.length} scenarios; ${path.join(root, 'summary.json')}`,
);
