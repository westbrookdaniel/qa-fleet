import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, type Dirent, openSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  acquireLeases,
  observePressure,
  releaseLeases,
  retireBrowsers,
  retireGroup,
} from './custody.ts';

import { errorCode, errorMessage } from './errors.ts';
import { playwrightInvocation, workspaceRuntimeDirectory } from './runtime.ts';
import type {
  CauseCode,
  ChildOutcome,
  OwnedChild,
  RunSummary,
  SuiteOptions,
  TestStats,
} from './types.ts';

interface LaunchSettings {
  cwd: string;
  detached: boolean;
  stdio: 'inherit' | ['inherit', number, number];
  env: NodeJS.ProcessEnv & { QA_FLEET_BROWSER_MARKER: string; QA_FLEET_BROWSER_RECEIPTS: string };
}
interface RunnerDependencies {
  pressure?: typeof observePressure;
  spawn?: (executable: string, args: string[], settings: LaunchSettings) => OwnedChild;
  cli?: string;
  lockRoot?: string;
  monitorMilliseconds?: number;
  retireGroup?: typeof retireGroup;
  retireBrowsers?: typeof retireBrowsers;
}
interface ReportSuite {
  specs?: { file: string; tests?: { projectName: string }[] }[];
  suites?: ReportSuite[];
}
interface PlaywrightReport {
  config: { rootDir: string };
  stats: TestStats;
  suites?: ReportSuite[];
}
const escapeFilter = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function suiteArguments(
  cli: string,
  target: string,
  config: string,
  options: Pick<SuiteOptions, 'project' | 'workers' | 'timeout' | 'trace' | 'verification'>,
  output: string,
) {
  const args = [
    cli,
    'test',
    `^${escapeFilter(target)}$`,
    '--config',
    config,
    '--project',
    options.project,
    '--no-deps',
    '--workers',
    String(options.workers),
    '--global-timeout',
    String(options.timeout * 1000),
    '--retries',
    '0',
    '--forbid-only',
    '--reporter',
    options.verification
      ? `line,json,html,${path.join(workspaceRuntimeDirectory(options.verification.workspace), 'verification-reporter.ts')}`
      : 'line,json,html',
    '--output',
    path.join(output, 'artifacts'),
  ];
  if (options.trace) args.push('--trace', options.trace);
  return args;
}

export async function traceArtifactPresent(directory: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'trace.zip') return true;
    if (entry.isDirectory() && (await traceArtifactPresent(path.join(directory, entry.name))))
      return true;
  }
  return false;
}

const allowedCauseCodes = new Set([
  'LEASE_REFUSED',
  'PRESSURE_REFUSED',
  'CANCELLED',
  'SUITE_TIMEOUT',
  'SPAWN_FAILED',
  'TEST_FAILED',
  'REPORT_UNAVAILABLE',
  'SELECTION_MISMATCH',
  'TRACE_OFF_UNVERIFIED',
  'CLEANUP_UNRESOLVED',
  'SETUP_FAILED',
]);

// Public results contain fixed cause codes and numeric test facts, never raw errors.
export function publicResult(
  summary: Pick<RunSummary, 'test' | 'cleanup' | 'output'> & { causeCode?: string },
) {
  const stats = summary.test.stats;
  let causeCode = null;
  if (summary.causeCode != null)
    causeCode = allowedCauseCodes.has(summary.causeCode) ? summary.causeCode : 'SETUP_FAILED';
  return {
    test: {
      verdict: summary.test.verdict,
      code: summary.test.code ?? null,
      signal: summary.test.signal ?? null,
      ...(stats
        ? {
            stats: {
              expected: stats.expected,
              unexpected: stats.unexpected,
              skipped: stats.skipped,
              flaky: stats.flaky,
            },
          }
        : {}),
    },
    cleanup: {
      complete: summary.cleanup.complete,
      custodyAcquired: summary.cleanup.custodyAcquired,
    },
    causeCode,
    output: summary.output,
    summaryPath: path.join(summary.output, 'summary.json'),
  };
}

export async function runSuite(
  options: SuiteOptions,
  dependencies: RunnerDependencies = {},
): Promise<RunSummary> {
  const startedMs = performance.now();
  const pressure = dependencies.pressure ?? observePressure;
  const launch = dependencies.spawn ?? spawn;
  const config = await realpath(options.config);
  const target = await realpath(options.target);
  const checkout = await realpath(options.checkout);
  if (!/\.spec\.[cm]?[jt]sx?$/.test(target))
    throw new Error('Target must be one explicit Playwright .spec file.');
  const outputRoot = path.resolve(options.output ?? '.qa-fleet-results');
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(path.join(outputRoot, 'run-'));
  const summary: RunSummary = {
    started: new Date().toISOString(),
    config,
    target,
    checkout,
    workers: options.workers,
    output,
    agentInvocations: 0,
    test: { verdict: 'not-run' },
    cleanup: { complete: true, custodyAcquired: false },
    pressure: [],
  };
  if (options.timings) summary.phaseMs = { inputsResolved: performance.now() - startedMs };
  const mark = (phase: string) => {
    if (summary.phaseMs) summary.phaseMs[phase] = performance.now() - startedMs;
  };
  let leases: string[] = [];
  let abortReason: string | null = null;
  let wakeAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    wakeAbort = resolve;
  });
  const abort = (reason: string, causeCode: CauseCode = 'CANCELLED') => {
    if (!abortReason) {
      abortReason = reason;
      summary.causeCode = causeCode;
      wakeAbort();
    }
  };
  const onInterrupt = () => abort('SIGINT');
  const onTerminate = () => abort('SIGTERM');
  const onHangup = () => abort('SIGHUP');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.on('SIGHUP', onHangup);
  try {
    try {
      leases = await acquireLeases(
        [`checkout:${checkout}`, ...options.locks],
        dependencies.lockRoot,
      );
    } catch (error) {
      summary.causeCode = 'LEASE_REFUSED';
      throw error;
    }
    mark('leasesAcquired');
    const initial = await pressure(process.platform, options.workers);
    summary.pressure.push(initial);
    mark('initialPressureComplete');
    if (!initial.safe) {
      summary.causeCode = 'PRESSURE_REFUSED';
      throw new Error(initial.reason ?? 'Unsafe pressure observation');
    }
    if (abortReason) throw new Error('Cancelled before launch');
    const invocation = playwrightInvocation(options.verification?.workspace ?? checkout);
    const cli = dependencies.cli ?? invocation.cli;
    const marker = randomUUID();
    const receiptsFile = path.join(output, 'browser-custody.jsonl');
    const args = [...invocation.prefix, ...suiteArguments(cli, target, config, options, output)];
    summary.project = options.project;
    summary.trace = { requested: options.trace ?? 'project-config', effective: null };
    const log = options.captureOutput
      ? openSync(path.join(output, 'playwright.log'), 'wx', 0o600)
      : undefined;
    let child: OwnedChild;
    try {
      child = launch(process.execPath, args, {
        cwd: checkout,
        detached: true,
        stdio: log === undefined ? 'inherit' : ['inherit', log, log],
        env: {
          ...process.env,
          BUN_BE_BUN: '1',
          QA_FLEET_BROWSER_MARKER: marker,
          QA_FLEET_BROWSER_RECEIPTS: receiptsFile,
          QA_FLEET_REQUIRED_TRACE_MODE: options.trace === 'off' ? 'off' : '',
          ...(options.verification
            ? {
                QA_FLEET_VERIFICATION_REPORT: path.join(output, 'verification-execution.json'),
              }
            : {}),
          PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(output, 'playwright.json'),
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(output, 'html'),
          PLAYWRIGHT_HTML_OPEN: 'never',
        },
      });
    } finally {
      // The child owns its duplicated descriptors. Avoid awaiting before installing listeners.
      if (log !== undefined) closeSync(log);
    }
    mark('cliSpawnReturned');
    summary.cleanup = { complete: false, custodyAcquired: true, pid: child.pid ?? null };
    let outcome: ChildOutcome | null = null;
    const completion = new Promise<ChildOutcome>((resolve) => {
      child.once('error', (error: Error) => {
        outcome = { error: errorMessage(error) };
        resolve(outcome);
      });
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        outcome = { code, signal };
        resolve(outcome);
      });
    });
    const deadline = setTimeout(
      () => abort('suite timeout', 'SUITE_TIMEOUT'),
      options.timeout * 1000,
    );
    let monitorPending: Promise<void> | null = null;
    const monitor = setInterval(() => {
      if (monitorPending || abortReason) return;
      monitorPending = (async () => {
        try {
          const sample = await pressure(process.platform, options.workers);
          summary.pressure.push(sample);
          if (!sample.safe)
            abort(sample.reason ?? 'Unsafe pressure observation', 'PRESSURE_REFUSED');
        } catch {
          abort('pressure observation failed', 'PRESSURE_REFUSED');
        }
      })();
      monitorPending.finally(() => {
        monitorPending = null;
      });
    }, dependencies.monitorMilliseconds ?? 1000);
    try {
      await Promise.race([completion, aborted]);
      mark('waitEnded');
      clearInterval(monitor);
      await monitorPending;
      mark('pressureMonitorSettled');
      const completed = outcome as ChildOutcome | null;
      summary.test = abortReason
        ? { verdict: 'aborted', reason: abortReason }
        : { verdict: completed?.code === 0 ? 'passed' : 'failed', ...completed };
      if (!abortReason && completed?.error) summary.causeCode = 'SPAWN_FAILED';
      else if (!abortReason && completed?.code !== 0) summary.causeCode = 'TEST_FAILED';
      const retireCli = dependencies.retireGroup ?? retireGroup;
      const retireBrowserGroups = dependencies.retireBrowsers ?? retireBrowsers;
      if (child.pid) {
        summary.cleanup = {
          custodyAcquired: true,
          pid: child.pid,
          ...(await retireCli({ pid: child.pid }, completion)),
        };
      } else {
        // A failed spawn reports asynchronously, including after cancellation.
        const spawnOutcome = await completion;
        summary.cleanup = {
          complete: true,
          custodyAcquired: false,
          spawnError: spawnOutcome.error ?? null,
        };
      }
      mark('cliCleanupComplete');
      const browsers = await retireBrowserGroups(marker, receiptsFile);
      summary.cleanup.browsers = browsers;
      mark('browserCleanupComplete');
      try {
        const text = await readFile(receiptsFile, 'utf8');
        const values = text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((receipt) => receipt.marker === marker)
          .map((receipt) => receipt.trace);
        const modes = [...new Set(values)];
        summary.trace.effective = modes.length === 1 ? modes[0] : null;
      } catch {
        /* An unobserved trace mode remains unknown in the receipt. */
      }
      summary.cleanup.complete = summary.cleanup.complete && browsers.complete;
      if (!browsers.complete && browsers.reason) summary.cleanup.reason = browsers.reason;
      if (child.pid && browsers.registered?.length === 0) {
        summary.cleanup.complete = false;
        summary.cleanup.reason =
          'No supported browser custody receipt; guarded browser replay requires qa-fleet fixtures.';
      }
      try {
        const report: PlaywrightReport = JSON.parse(
          await readFile(path.join(output, 'playwright.json'), 'utf8'),
        );
        summary.test.stats = report.stats;
        const selected: { file: string; project: string }[] = [];
        summary.test.selected = selected;
        const inspectSuite = (suite: ReportSuite) => {
          for (const spec of suite.specs ?? []) {
            for (const test of spec.tests ?? [])
              selected.push({
                file: path.resolve(report.config.rootDir, spec.file),
                project: test.projectName,
              });
          }
          for (const nested of suite.suites ?? []) inspectSuite(nested);
        };
        for (const suite of report.suites ?? []) inspectSuite(suite);
        if (
          summary.test.selected.some(
            (test) =>
              path.resolve(checkout, test.file) !== target || test.project !== options.project,
          )
        ) {
          summary.test.verdict = 'failed';
          summary.causeCode = 'SELECTION_MISMATCH';
        }
        if (
          summary.test.verdict === 'passed' &&
          (!report.stats || report.stats.expected < 1 || report.stats.unexpected > 0)
        )
          summary.test.verdict = 'failed';
      } catch (error) {
        summary.test.reportError = errorMessage(error);
        if (!abortReason) summary.causeCode = 'REPORT_UNAVAILABLE';
        if (summary.test.verdict === 'passed') summary.test.verdict = 'failed';
      }
      mark('reportProcessed');
      if (options.trace === 'off' || summary.trace.effective === 'off') {
        const artifactPresent = await traceArtifactPresent(path.join(output, 'artifacts'));
        summary.trace.artifactPresent = artifactPresent;
        if (artifactPresent || (options.trace === 'off' && summary.trace.effective !== 'off')) {
          summary.trace.guardFailure = 'Trace-off could not be verified';
          if (!abortReason) summary.causeCode = 'TRACE_OFF_UNVERIFIED';
          if (summary.test.verdict === 'passed') summary.test.verdict = 'failed';
        }
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(monitor);
      await monitorPending;
    }
  } catch (error) {
    summary.error = errorMessage(error);
    summary.causeCode ??= 'SETUP_FAILED';
  } finally {
    if (abortReason) summary.test = { ...summary.test, verdict: 'aborted', reason: abortReason };
    if (summary.cleanup.complete) {
      try {
        await releaseLeases(leases);
      } catch (error) {
        summary.cleanup = {
          ...summary.cleanup,
          complete: false,
          leaseReleaseError: errorMessage(error),
        };
      }
    }
    if (!summary.cleanup.complete) summary.causeCode = 'CLEANUP_UNRESOLVED';
    mark('cleanupFinalized');
    summary.finished = new Date().toISOString();
    try {
      await writeFile(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
        mode: 0o600,
      });
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      process.off('SIGHUP', onHangup);
    }
  }
  return summary;
}
