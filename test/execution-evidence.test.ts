import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectExecution } from '../lib/execution-evidence.ts';
import { playwrightInvocation, runtimeDirectory } from '../lib/runtime.ts';

async function recordedRun(source: string, retries = 0) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-flow-inventory-')));
  try {
    const target = path.join(root, 'flow.spec.ts');
    await writeFile(
      path.join(root, 'playwright.config.ts'),
      `export default { testDir: '.', retries: ${retries}, projects: [{name:'chromium'}] };`,
    );
    await writeFile(
      path.join(root, 'helpers.ts'),
      'export const sum = (a: number, b: number) => a + b; export function unused() { throw new Error("untaken helper"); }',
    );
    await writeFile(
      target,
      `import {test,expect} from ${JSON.stringify(path.join(runtimeDirectory(), 'fixtures.ts'))};\nimport {sum,unused} from './helpers.ts';\n${source}`,
    );
    const invocation = playwrightInvocation();
    try {
      execFileSync(
        process.execPath,
        [
          ...invocation.prefix,
          invocation.cli,
          'test',
          target,
          '--config',
          path.join(root, 'playwright.config.ts'),
          '--workers=1',
          `--reporter=json,${path.join(runtimeDirectory(), 'verification-reporter.ts')}`,
        ],
        {
          cwd: root,
          stdio: 'pipe',
          timeout: 10_000,
          env: {
            BUN_BE_BUN: '1',
            PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(root, 'report.json'),
            QA_FLEET_VERIFICATION_REPORT: path.join(root, 'inventory.json'),
          },
        },
      );
    } catch (error) {
      assert.equal((error as { status?: number }).status, 1);
    }
    return {
      report: JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8')),
      inventory: JSON.parse(await readFile(path.join(root, 'inventory.json'), 'utf8')),
      options: { target, project: 'chromium' },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('ordinary helper calls and duplicate leaf titles verify without a catalogue or part wrapper', async () => {
  const run = await recordedRun(`
    test.describe('first context', () => { test('same title', () => { expect(sum(1,2)).toBe(3); }); });
    test.describe('second context', () => { test('same title', () => { if (false) unused(); expect(sum(4,5)).toBe(9); }); });
  `);
  assert.deepEqual(inspectExecution(run.report, run.inventory, run.options), {
    accepted: true,
    testCount: 2,
  });
  assert.equal(
    inspectExecution(run.report, run.inventory, { ...run.options, target: '/wrong.spec.ts' })
      .accepted,
    false,
  );
  run.inventory.planned.pop();
  run.inventory.results.pop();
  assert.equal(inspectExecution(run.report, run.inventory, run.options).accepted, false);
});

test('real skipped, expected-failure, retry, and zero-test outcomes never become passing flow evidence', async () => {
  const cases = [
    { source: "test.skip('skipped', () => {});", retries: 0 },
    { source: "test('expected failure', () => { test.fail(); expect(1).toBe(2); });", retries: 0 },
    { source: "test('passing retry', ({}, info) => { expect(info.retry).toBe(1); });", retries: 1 },
    { source: 'export const noTests = true;', retries: 0 },
  ];
  for (const scenario of cases) {
    const run = await recordedRun(scenario.source, scenario.retries);
    assert.deepEqual(inspectExecution(run.report, run.inventory, run.options), {
      accepted: false,
      testCount: 0,
    });
  }
}, 20_000);
