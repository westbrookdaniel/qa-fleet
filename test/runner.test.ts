import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fstatSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertRequiredTraceMode, launchOwnedBrowser, resolvedTraceMode } from '../fixtures.ts';
import { publicResult, runSuite, suiteArguments } from '../lib/runner.ts';

test('exact target with regex metacharacters excludes sibling files and projects', () => {
  const target = '/repo/specs/navigation[copy]+.spec.ts';
  const args = suiteArguments(
    'cli',
    target,
    'config',
    { project: 'chromium', workers: 2, timeout: 30 },
    'output',
  );
  const filter = new RegExp(args[2]);
  assert.equal(filter.test(target), true);
  assert.equal(filter.test('/repo/specs/navigationc.spec.ts'), false);
  assert.equal(filter.test(`${target}.other`), false);
  assert.equal(args[args.indexOf('--project') + 1], 'chromium');
  assert.equal(args.includes('--no-deps'), true);
});

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-run-test-'));
  await writeFile(path.join(root, 'playwright.config.ts'), '');
  await writeFile(path.join(root, 'test.spec.ts'), '');
  return {
    root,
    options: {
      config: path.join(root, 'playwright.config.ts'),
      target: path.join(root, 'test.spec.ts'),
      checkout: root,
      project: 'chromium',
      workers: 1,
      timeout: 2,
      locks: [],
      output: path.join(root, 'results'),
    },
  };
}

test('captured output sends both child streams to a private log and closes the parent descriptor', async () => {
  const { root, options } = await workspace();
  let descriptor: number | undefined;
  try {
    const summary = await runSuite(
      { ...options, captureOutput: true },
      {
        cli: 'unused',
        lockRoot: path.join(root, 'locks'),
        pressure: async () => ({ safe: true }),
        spawn: (_executable, _args, settings) => {
          assert.ok(Array.isArray(settings.stdio));
          descriptor = settings.stdio[1];
          assert.equal(settings.stdio[2], descriptor);
          writeSync(descriptor, 'child stdout\n');
          writeSync(settings.stdio[2], 'child stderr\n');
          const child = new EventEmitter();
          setImmediate(() => child.emit('error', new Error('synthetic spawn failure')));
          return child;
        },
        retireBrowsers: async () => ({ complete: true, registered: [] }),
      },
    );
    const log = path.join(summary.output, 'playwright.log');
    assert.equal(await readFile(log, 'utf8'), 'child stdout\nchild stderr\n');
    assert.equal((await stat(log)).mode & 0o777, 0o600);
    assert.equal(typeof descriptor, 'number');
    assert.throws(() => fstatSync(descriptor as number), { code: 'EBADF' });
    assert.equal(summary.cleanup.complete, true);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('capture closes its descriptor when launch throws and default replay still inherits output', async () => {
  const { root, options } = await workspace();
  try {
    for (const captureOutput of [false, true]) {
      let descriptor: number | undefined;
      const summary = await runSuite(
        { ...options, captureOutput },
        {
          cli: 'unused',
          lockRoot: path.join(root, 'locks'),
          pressure: async () => ({ safe: true }),
          spawn: (_executable, _args, settings) => {
            if (captureOutput) {
              assert.ok(Array.isArray(settings.stdio));
              descriptor = settings.stdio[1];
            } else {
              assert.equal(settings.stdio, 'inherit');
            }
            throw new Error('synthetic synchronous launch failure');
          },
        },
      );
      if (descriptor !== undefined) {
        const closedDescriptor = descriptor;
        assert.throws(() => fstatSync(closedDescriptor), { code: 'EBADF' });
      }
      assert.equal(summary.cleanup.complete, true);
      assert.equal(summary.test.verdict, 'not-run');
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test('failed browser inspection preserves its cause and retains leases despite an existing receipt', async () => {
  const { root, options } = await workspace();
  try {
    const summary = await runSuite(options, {
      cli: 'unused',
      lockRoot: path.join(root, 'locks'),
      pressure: async () => ({ safe: true }),
      spawn: (_executable, _args, settings) => {
        const child = Object.assign(new EventEmitter(), { pid: 123 });
        setImmediate(async () => {
          await writeFile(
            settings.env.QA_FLEET_BROWSER_RECEIPTS,
            JSON.stringify({
              marker: settings.env.QA_FLEET_BROWSER_MARKER,
              pid: 456,
              trace: 'off',
            }),
          );
          child.emit('close', 1, null);
        });
        return child;
      },
      retireGroup: async () => ({ complete: true, childReaped: true, groupAbsent: true }),
      retireBrowsers: async () => ({
        complete: false,
        reason: 'Synthetic process inspection timed out',
      }),
    });
    assert.equal(summary.cleanup.complete, false);
    assert.equal(summary.cleanup.reason, 'Synthetic process inspection timed out');
    assert.equal(summary.causeCode, 'CLEANUP_UNRESOLVED');
    assert.equal((await readdir(path.join(root, 'locks'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trace honors project configuration unless explicitly overridden', () => {
  const options = { project: 'chromium', workers: 1, timeout: 30 };
  assert.equal(
    suiteArguments('cli', '/spec.spec.ts', 'config', options, 'output').includes('--trace'),
    false,
  );
  for (const trace of ['off', 'on', 'retain-on-failure'] as const) {
    const args = suiteArguments('cli', '/spec.spec.ts', 'config', { ...options, trace }, 'output');
    assert.equal(args[args.indexOf('--trace') + 1], trace);
  }
});

test('unknown and critical prelaunch observations never spawn or retain leases', async () => {
  const { root, options } = await workspace();
  try {
    for (const reason of ['unknown pressure', 'critical pressure']) {
      let launched = false;
      const summary = await runSuite(
        { ...options, timings: true },
        {
          lockRoot: path.join(root, 'locks'),
          pressure: async () => ({ safe: false, reason }),
          spawn: () => {
            launched = true;
            throw new Error('Unexpected launch');
          },
        },
      );
      assert.equal(launched, false);
      assert.equal(summary.causeCode, 'PRESSURE_REFUSED');
      assert.ok(summary.phaseMs);
      assert.equal('cliSpawnReturned' in summary.phaseMs, false);
      assert.ok(Object.values(summary.phaseMs).every(Number.isFinite));
      assert.equal(summary.test.verdict, 'not-run');
      assert.equal(summary.cleanup.complete, true);
      assert.deepEqual(await readdir(path.join(root, 'locks')), []);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test('SIGINT and SIGHUP at launch are caught and owned cleanup is invoked', async () => {
  for (const signal of ['SIGINT', 'SIGHUP']) {
    const { root, options } = await workspace();
    let retired = false;
    try {
      const summary = await runSuite(
        { ...options, timings: true },
        {
          cli: 'unused',
          lockRoot: path.join(root, 'locks'),
          pressure: async () => ({ safe: true }),
          spawn: () => {
            process.emit(signal);
            return Object.assign(new EventEmitter(), { pid: 123 });
          },
          retireGroup: async () => {
            retired = true;
            return { complete: true, childReaped: true, groupAbsent: true };
          },
          retireBrowsers: async () => ({ complete: true, registered: [456] }),
        },
      );
      assert.equal(retired, true);
      assert.equal(summary.test.verdict, 'aborted');
      assert.equal(summary.test.reason, signal);
      assert.equal(summary.causeCode, 'CANCELLED');
      assert.ok(summary.phaseMs);
      const phases = Object.values(summary.phaseMs);
      assert.ok(
        phases.every(
          (value, index) =>
            Number.isFinite(value) && value >= 0 && (index === 0 || value >= phases[index - 1]),
        ),
      );
      assert.ok('cliCleanupComplete' in summary.phaseMs);
      assert.equal(summary.cleanup.complete, true);
    } finally {
      await rm(root, { recursive: true });
    }
  }
});

test('cancelled no-PID spawn awaits its asynchronous error and releases only unacquired custody', async () => {
  const { root, options } = await workspace();
  let errorObserved = false;
  try {
    const summary = await runSuite(options, {
      cli: 'unused',
      lockRoot: path.join(root, 'locks'),
      pressure: async () => ({ safe: true }),
      spawn: () => {
        process.emit('SIGINT');
        const child = new EventEmitter();
        setTimeout(() => {
          errorObserved = true;
          child.emit('error', new Error('spawn failed'));
        }, 5);
        return child;
      },
      retireBrowsers: async () => ({ complete: true, registered: [] }),
    });
    assert.equal(errorObserved, true);
    assert.equal(summary.test.verdict, 'aborted');
    assert.equal(summary.cleanup.complete, true);
    assert.equal(summary.cleanup.custodyAcquired, false);
    assert.equal(summary.cleanup.spawnError, 'spawn failed');
    assert.deepEqual(await readdir(path.join(root, 'locks')), []);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('resolved file trace override is refused when protected replay requires off', () => {
  assert.equal(resolvedTraceMode('on'), 'on');
  assert.equal(resolvedTraceMode({ mode: 'off' }), 'off');
  assert.throws(() => assertRequiredTraceMode('on', 'off'), /refuses a resolved trace override/);
  assert.doesNotThrow(() => assertRequiredTraceMode('off', 'off'));
});

test('a real trace artifact prevents a passing off-mode verdict without rewriting process cleanup', async () => {
  const { root, options } = await workspace();
  try {
    const summary = await runSuite(
      { ...options, trace: 'off' },
      {
        cli: 'unused',
        lockRoot: path.join(root, 'locks'),
        pressure: async () => ({ safe: true }),
        spawn: (_node, _args, settings) => {
          const child = Object.assign(new EventEmitter(), { pid: 123 });
          setImmediate(async () => {
            const output = path.dirname(settings.env.QA_FLEET_BROWSER_RECEIPTS);
            await writeFile(
              settings.env.QA_FLEET_BROWSER_RECEIPTS,
              JSON.stringify({
                marker: settings.env.QA_FLEET_BROWSER_MARKER,
                pid: 456,
                trace: 'off',
              }),
            );
            await mkdir(path.join(output, 'artifacts', 'test'), { recursive: true });
            await writeFile(
              path.join(output, 'artifacts', 'test', 'trace.zip'),
              'unexpected artifact',
            );
            await writeFile(
              path.join(output, 'playwright.json'),
              JSON.stringify({
                config: { rootDir: root },
                stats: { expected: 1, unexpected: 0 },
                suites: [
                  { specs: [{ file: 'test.spec.ts', tests: [{ projectName: 'chromium' }] }] },
                ],
              }),
            );
            child.emit('close', 0, null);
          });
          return child;
        },
        retireGroup: async () => ({ complete: true, childReaped: true, groupAbsent: true }),
        retireBrowsers: async () => ({ complete: true, registered: [456] }),
      },
    );
    assert.equal(summary.test.verdict, 'failed');
    assert.ok(summary.trace);
    assert.equal(summary.trace.artifactPresent, true);
    assert.equal(summary.cleanup.complete, true);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('late in-flight critical or unknown pressure settles and changes verdict after CLI closes', async () => {
  for (const reason of ['critical pressure', 'unknown pressure']) {
    const { root, options } = await workspace();
    const child = Object.assign(new EventEmitter(), { pid: 123 });
    let calls = 0;
    let settled = false;
    try {
      const summary = await runSuite(options, {
        cli: 'unused',
        lockRoot: path.join(root, 'locks'),
        monitorMilliseconds: 1,
        spawn: () => child,
        pressure: async () => {
          calls += 1;
          if (calls === 1) return { safe: true };
          child.emit('close', 0, null);
          await new Promise((resolve) => setTimeout(resolve, 10));
          settled = true;
          return { safe: false, reason };
        },
        retireGroup: async () => {
          assert.equal(settled, true);
          return { complete: true, childReaped: true, groupAbsent: true };
        },
        retireBrowsers: async () => ({ complete: true, registered: [456] }),
      });
      assert.equal(settled, true);
      assert.equal(summary.test.verdict, 'aborted');
      assert.equal(summary.test.reason, reason);
      assert.equal(summary.pressure.length, 2);
    } finally {
      await rm(root, { recursive: true });
    }
  }
});

test('public result excludes raw private errors, paths and arbitrary reason values', () => {
  const secret = 'PRIVATE_AUTH_VALUE';
  const summary = {
    test: { verdict: 'failed' as const, code: 1, reason: secret, reportError: secret },
    cleanup: { complete: false, custodyAcquired: true, reason: secret, error: secret },
    error: secret,
    trace: { guardFailure: secret },
    causeCode: 'CLEANUP_UNRESOLVED',
    output: '/owned/results',
  };
  const printed = publicResult(summary);
  assert.equal(JSON.stringify(printed).includes(secret), false);
  assert.equal(printed.causeCode, 'CLEANUP_UNRESOLVED');
  assert.equal(printed.summaryPath, '/owned/results/summary.json');
  assert.equal(publicResult({ ...summary, causeCode: secret }).causeCode, 'SETUP_FAILED');
});

test('lease refusal exposes a fixed cause without raw owner or filesystem errors', async () => {
  const { root, options } = await workspace();
  try {
    const lockRoot = path.join(root, 'locks');
    const { acquireLeases, releaseLeases } = await import('../lib/custody.ts');
    const held = await acquireLeases([`checkout:${await realpath(root)}`], lockRoot);
    const summary = await runSuite(
      { ...options, timings: true },
      {
        lockRoot,
        pressure: async () => ({ safe: true }),
        spawn: () => {
          throw new Error('must not spawn');
        },
      },
    );
    assert.equal(summary.causeCode, 'LEASE_REFUSED');
    assert.ok(summary.phaseMs);
    assert.equal('cliSpawnReturned' in summary.phaseMs, false);
    assert.equal((await readdir(lockRoot)).length, 1);
    assert.equal(publicResult(summary).causeCode, 'LEASE_REFUSED');
    await releaseLeases(held);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('optional same-process timing marks are numeric and ordered for pass and failure', async () => {
  for (const code of [0, 1]) {
    const { root, options } = await workspace();
    try {
      const summary = await runSuite(
        { ...options, timings: true },
        {
          cli: 'unused',
          lockRoot: path.join(root, 'locks'),
          pressure: async () => ({ safe: true }),
          spawn: (_node, _args, settings) => {
            const child = Object.assign(new EventEmitter(), { pid: 123 });
            setImmediate(async () => {
              const output = path.dirname(settings.env.QA_FLEET_BROWSER_RECEIPTS);
              await writeFile(
                path.join(output, 'playwright.json'),
                JSON.stringify({
                  config: { rootDir: root },
                  stats: { expected: code === 0 ? 1 : 0, unexpected: code },
                  suites: [],
                }),
              );
              child.emit('close', code, null);
            });
            return child;
          },
          retireGroup: async () => ({ complete: true, childReaped: true, groupAbsent: true }),
          retireBrowsers: async () => ({ complete: true, registered: [456] }),
        },
      );
      assert.equal(summary.test.verdict, code === 0 ? 'passed' : 'failed');
      assert.equal(summary.cleanup.complete, true);
      assert.equal(summary.causeCode ?? null, code === 0 ? null : 'TEST_FAILED');
      assert.ok(summary.phaseMs);
      const phases = Object.values(summary.phaseMs);
      assert.ok(
        phases.every(
          (value, index) =>
            Number.isFinite(value) && value >= 0 && (index === 0 || value >= phases[index - 1]),
        ),
      );
      assert.ok('reportProcessed' in summary.phaseMs);
      assert.ok('cleanupFinalized' in summary.phaseMs);
    } finally {
      await rm(root, { recursive: true });
    }
  }
});

test('Bun child runtime controls are explicit and never mutate the controller environment', async () => {
  const { root, options } = await workspace();
  const inheritedMode = process.env.BUN_BE_BUN;
  try {
    const summary = await runSuite(options, {
      cli: 'unused',
      lockRoot: path.join(root, 'locks'),
      pressure: async () => ({ safe: true }),
      spawn: (_executable, args, settings) => {
        assert.equal(args[0], '--no-env-file');
        assert.equal(args[1], '--no-install');
        assert.ok(args[2].startsWith('--config='));
        assert.ok(args[2].endsWith('/bunfig.toml'));
        assert.equal(args[3], 'unused');
        assert.equal(settings.env.BUN_BE_BUN, '1');
        process.emit('SIGINT');
        return Object.assign(new EventEmitter(), { pid: 123 });
      },
      retireGroup: async () => ({ complete: true, childReaped: true, groupAbsent: true }),
      retireBrowsers: async () => ({ complete: true, registered: [456] }),
    });
    assert.equal(summary.test.verdict, 'aborted');
    assert.equal(summary.cleanup.complete, true);
    assert.equal(process.env.BUN_BE_BUN, inheritedMode);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('default, explicit headless and headed settings reach the owned browser launcher', async () => {
  for (const headless of [undefined, true, false]) {
    let called = false;
    await assert.rejects(
      launchOwnedBrowser(headless, 'owned-marker', async (options) => {
        called = true;
        assert.equal(options?.headless, headless ?? true);
        assert.deepEqual(options?.args, ['--qa-fleet-custody=owned-marker']);
        throw new Error('Synthetic launcher stops before any browser spawn');
      }),
      /Synthetic launcher/,
    );
    assert.equal(called, true);
  }
});
