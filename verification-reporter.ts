import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

export interface PlannedTest {
  testId: string;
  project: string;
  file: string;
  titlePath: string[];
  expectedStatus: TestCase['expectedStatus'];
}

export interface VerificationTestResult extends PlannedTest {
  retry: number;
  status: TestResult['status'];
}

export interface VerificationReport {
  schemaVersion: 1;
  complete: boolean;
  status: FullResult['status'] | null;
  errorCount: number;
  planned: PlannedTest[];
  results: VerificationTestResult[];
}

function plannedTest(test: TestCase): PlannedTest {
  return {
    testId: test.id,
    project: test.parent.project()?.name ?? '',
    file: path.resolve(test.location.file),
    titlePath: test.titlePath().filter(Boolean),
    expectedStatus: test.expectedStatus,
  };
}

export default class VerificationReporter implements Reporter {
  private output = process.env.QA_FLEET_VERIFICATION_REPORT;
  private report: VerificationReport = {
    schemaVersion: 1,
    complete: false,
    status: null,
    errorCount: 0,
    planned: [],
    results: [],
  };

  onBegin(_config: FullConfig, suite: Suite): void {
    const tests = suite.allTests();
    if (tests.length > 10_000) throw new Error('Verification exceeds its test limit.');
    this.report.planned = tests.map(plannedTest);
    this.write();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (this.report.results.length >= 20_000)
      throw new Error('Verification exceeds its result limit.');
    this.report.results.push({ ...plannedTest(test), retry: result.retry, status: result.status });
    this.write();
  }

  onError(): void {
    this.report.errorCount += 1;
    this.write();
  }

  onEnd(result: FullResult): void {
    this.report.complete = true;
    this.report.status = result.status;
    this.write();
  }

  private write(): void {
    if (!this.output) throw new Error('Verification report path is missing.');
    const body = `${JSON.stringify(this.report)}\n`;
    if (Buffer.byteLength(body) > 16 * 1024 * 1024)
      throw new Error('Verification report exceeds its size limit.');
    const temporary = `${this.output}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
      // Keep the last complete snapshot readable if the process stops during an update.
      renameSync(temporary, this.output);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
