import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { inspectExecution } from '../lib/execution-evidence.ts';
import VerificationReporter, { type VerificationReport } from '../verification-reporter.ts';

function testCase(root: string, id: string): TestCase {
  return {
    id,
    parent: { project: () => ({ name: 'chromium' }) },
    location: { file: path.join(root, 'flow.spec.ts') },
    titlePath: () => [id],
    expectedStatus: 'passed',
  } as TestCase;
}

async function withReporter(
  run: (
    root: string,
    reporter: VerificationReporter,
    read: () => Promise<VerificationReport>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-reporter-'));
  const previous = process.env.QA_FLEET_VERIFICATION_REPORT;
  const output = path.join(root, 'inventory.json');
  try {
    process.env.QA_FLEET_VERIFICATION_REPORT = output;
    await run(root, new VerificationReporter(), async () =>
      JSON.parse(await readFile(output, 'utf8')),
    );
  } finally {
    if (previous === undefined) delete process.env.QA_FLEET_VERIFICATION_REPORT;
    else process.env.QA_FLEET_VERIFICATION_REPORT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('a completed timeout remains readable while another planned test is still running', async () => {
  await withReporter(async (root, reporter, read) => {
    const first = testCase(root, 'first');
    const pending = testCase(root, 'pending');
    reporter.onBegin({} as FullConfig, { allTests: () => [first, pending] } as Suite);
    reporter.onTestEnd(first, { retry: 0, status: 'timedOut' } as TestResult);
    const partial = await read();
    assert.equal(partial.complete, false);
    assert.equal(partial.status, null);
    assert.deepEqual(
      partial.planned.map((test) => test.testId),
      ['first', 'pending'],
    );
    assert.deepEqual(
      partial.results.map((test) => ({ id: test.testId, status: test.status })),
      [{ id: 'first', status: 'timedOut' }],
    );
  });
});

test('passing partial results cannot certify execution before the reporter completes', async () => {
  await withReporter(async (root, reporter, read) => {
    const fixture = testCase(root, 'passing');
    reporter.onBegin({} as FullConfig, { allTests: () => [fixture] } as Suite);
    reporter.onTestEnd(fixture, { retry: 0, status: 'passed' } as TestResult);
    const independentReport = {
      config: { rootDir: root },
      specs: [
        {
          id: fixture.id,
          file: 'flow.spec.ts',
          tests: [
            {
              projectName: 'chromium',
              expectedStatus: 'passed',
              status: 'expected',
              results: [{ retry: 0, status: 'passed' }],
            },
          ],
        },
      ],
    };
    const options = { target: fixture.location.file, project: 'chromium' };
    const partial = await read();
    assert.equal(partial.results.length, 1);
    assert.deepEqual(inspectExecution(independentReport, partial, options), {
      accepted: false,
      testCount: 0,
    });
    reporter.onEnd({ status: 'passed' } as FullResult);
    assert.deepEqual(inspectExecution(independentReport, await read(), options), {
      accepted: true,
      testCount: 1,
    });
  });
});

test('global errors are persisted without marking the report complete', async () => {
  await withReporter(async (root, reporter, read) => {
    reporter.onBegin({} as FullConfig, { allTests: () => [testCase(root, 'pending')] } as Suite);
    reporter.onError();
    reporter.onError();
    const partial = await read();
    assert.equal(partial.errorCount, 2);
    assert.equal(partial.complete, false);
    assert.equal(partial.status, null);
    assert.deepEqual(partial.results, []);
  });
});

test('interruption during replacement preserves the previous parseable report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-reporter-interruption-'));
  const output = path.join(root, 'inventory.json');
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(import.meta.dir, 'fixtures/reporter-interrupted-process.ts'), output],
          { stdio: 'pipe', timeout: 10_000, env: { ...process.env, BUN_BE_BUN: '1' } },
        ),
      (error: unknown) => (error as { status?: number }).status === 77,
    );
    const report = JSON.parse(await readFile(output, 'utf8')) as VerificationReport;
    assert.equal(report.complete, false);
    assert.equal(report.planned.length, 1);
    assert.deepEqual(report.results, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
