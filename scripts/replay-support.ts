import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  acquireLeases,
  observePressure,
  releaseLeases,
  retireBrowsers,
  retireGroup,
} from '../lib/custody.ts';
import { playwrightInvocation } from '../lib/runtime.ts';
import type { ChildOutcome } from '../lib/types.ts';

async function json(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function directReplay(
  workspace: string,
  spec: string,
  expectedTests: number,
  executable = process.execPath,
) {
  const leases = await acquireLeases([`checkout:${workspace}`]);
  let cleanupComplete = true;
  try {
    assert.equal((await observePressure()).safe, true, 'Direct replay requires safe pressure');
    const output = path.join(workspace, '.fleet/direct-replay');
    await mkdir(output);
    const marker = randomUUID();
    const receipts = path.join(output, 'browser-custody.jsonl');
    const invocation = playwrightInvocation(workspace);
    cleanupComplete = false;
    const child = spawn(
      executable,
      [
        ...invocation.prefix,
        invocation.cli,
        'test',
        spec,
        '--config',
        path.join(workspace, 'playwright.config.ts'),
        '--project=chromium',
        '--workers=1',
        '--retries=0',
        '--forbid-only',
        '--global-timeout=30000',
        '--reporter=line,json',
        '--output',
        path.join(output, 'artifacts'),
      ],
      {
        cwd: workspace,
        detached: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          BUN_BE_BUN: '1',
          QA_FLEET_BROWSER_MARKER: marker,
          QA_FLEET_BROWSER_RECEIPTS: receipts,
          QA_FLEET_REQUIRED_TRACE_MODE: 'off',
          PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(output, 'playwright.json'),
        },
      },
    );
    const completion = new Promise<ChildOutcome>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ error: 'DIRECT_SPAWN_FAILED' }));
    });
    let cancel: (reason: string) => void = () => {};
    const interrupted = new Promise<string>((resolve) => {
      cancel = resolve;
    });
    const onSignal = () => cancel('DIRECT_CANCELLED');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onSignal);
    const timeout = setTimeout(() => cancel('DIRECT_TIMEOUT'), 35_000);
    let checkingPressure = false;
    const monitor = setInterval(async () => {
      if (checkingPressure) return;
      checkingPressure = true;
      try {
        if (!(await observePressure()).safe) cancel('DIRECT_PRESSURE_REFUSED');
      } catch {
        cancel('DIRECT_PRESSURE_UNAVAILABLE');
      } finally {
        checkingPressure = false;
      }
    }, 1000);
    let outcome: ChildOutcome | string;
    try {
      outcome = await Promise.race([completion, interrupted]);
    } finally {
      clearTimeout(timeout);
      clearInterval(monitor);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, onSignal);
      const group = child.pid
        ? await retireGroup({ pid: child.pid }, completion)
        : { complete: true };
      const browsers = await retireBrowsers(marker, receipts);
      cleanupComplete = group.complete && browsers.complete;
      await json(path.join(output, 'cleanup.json'), { group, browsers });
      assert.equal(group.complete, true, 'Direct child cleanup must complete');
      assert.equal(browsers.complete, true, 'Direct browser cleanup must complete');
    }
    assert.equal(typeof outcome === 'object' ? outcome.code : null, 0, 'Direct replay must pass');
    const report = JSON.parse(await readFile(path.join(output, 'playwright.json'), 'utf8'));
    assert.equal(report.stats.expected, expectedTests);
    assert.equal(report.stats.unexpected, 0);
    assert.equal(report.stats.skipped, 0);
    return { verdict: 'passed', tests: expectedTests, cleanupComplete: true, output };
  } finally {
    // Retain the checkout lease when cleanup could not establish browser retirement.
    if (cleanupComplete) await releaseLeases(leases);
  }
}
