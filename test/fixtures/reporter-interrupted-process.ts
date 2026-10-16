import { mock } from 'bun:test';
import * as filesystem from 'node:fs';
import path from 'node:path';
import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';

const output = process.argv[2];
if (!output) throw new Error('Reporter output is required.');
const write = filesystem.writeFileSync;
let writes = 0;
mock.module('node:fs', () => ({
  ...filesystem,
  writeFileSync: (...args: Parameters<typeof filesystem.writeFileSync>) => {
    writes += 1;
    if (writes === 2) {
      const [filename, body, options] = args;
      write(filename, String(body).slice(0, 20), options);
      // Exit before rename/finally, as a process deadline could do during a write.
      process.exit(77);
    }
    return write(...args);
  },
}));
process.env.QA_FLEET_VERIFICATION_REPORT = output;
const { default: VerificationReporter } = await import('../../verification-reporter.ts');
const fixture = {
  id: 'interrupted',
  parent: { project: () => ({ name: 'chromium' }) },
  location: { file: path.join(path.dirname(output), 'flow.spec.ts') },
  titlePath: () => ['interrupted'],
  expectedStatus: 'passed',
} as TestCase;
const reporter = new VerificationReporter();
reporter.onBegin({} as FullConfig, { allTests: () => [fixture] } as Suite);
reporter.onTestEnd(fixture, { retry: 0, status: 'timedOut' } as TestResult);
