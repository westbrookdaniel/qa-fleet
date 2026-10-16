#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { WorkspaceInputError } from '../lib/errors.ts';
import { publicResult, runSuite } from '../lib/runner.ts';
import type { TraceMode } from '../lib/types.ts';
import { workspaceMain, workspaceUsage } from '../lib/workspace-cli.ts';

const usage =
  'qa-fleet run --config <file> --target <spec-file> --project <name> --checkout <directory> --timeout <seconds> --workers <1..4> [--trace off|on|retain-on-failure] [--timings] [--quiet] [--lock <resource>] [--output <directory>]';
if (['init', 'catalog', 'verify', 'status'].includes(process.argv[2] ?? '')) {
  try {
    await workspaceMain(process.argv.slice(2));
  } catch (error) {
    console.log(
      JSON.stringify({
        causeCode: 'WORKSPACE_OPERATION_REJECTED',
        message:
          error instanceof WorkspaceInputError
            ? error.message
            : 'Check workspace files, JSON syntax, installed dependencies and CLI arguments.',
        help: 'Use qa-fleet <command> --help. Inspect workspace files, installed dependencies and target configuration.',
      }),
    );
    process.exitCode = 2;
  }
} else
  try {
    const { values, positionals } = parseArgs({
      options: {
        config: { type: 'string' },
        target: { type: 'string' },
        checkout: { type: 'string' },
        project: { type: 'string' },
        trace: { type: 'string' },
        timings: { type: 'boolean' },
        quiet: { type: 'boolean' },
        timeout: { type: 'string' },
        workers: { type: 'string' },
        lock: { type: 'string', multiple: true },
        output: { type: 'string' },
        help: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(`${usage}\n\n${workspaceUsage}`);
      process.exit(0);
    }
    if (
      positionals.length !== 1 ||
      positionals[0] !== 'run' ||
      !values.config ||
      !values.target ||
      !values.checkout ||
      !values.project
    )
      throw new Error(usage);
    const timeout = Number(values.timeout);
    const workers = Number(values.workers);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 900)
      throw new Error('Explicit timeout must be 1..900 seconds.');
    if (!Number.isInteger(workers) || workers < 1 || workers > 4)
      throw new Error('Explicit workers must be 1..4.');
    const locks = values.lock ?? [];
    if (values.trace && !['off', 'on', 'retain-on-failure'].includes(values.trace))
      throw new Error(
        'Trace must be off, on or retain-on-failure; omit to honor project configuration.',
      );
    if (!/^[A-Za-z0-9_-]+$/.test(values.project))
      throw new Error('Project must be one exact name, without wildcard patterns.');
    if (locks.some((value) => !/^(db|port):\S+$/.test(value)))
      throw new Error('Additional locks must be db:<identity> or port:<identity>.');
    const summary = await runSuite({
      config: values.config,
      target: values.target,
      checkout: values.checkout,
      project: values.project,
      timeout,
      workers,
      locks,
      trace: values.trace as TraceMode | undefined,
      captureOutput: values.quiet,
      timings: values.timings,
      output: values.output,
    });
    console.log(JSON.stringify(publicResult(summary)));
    process.exitCode = summary.cleanup.complete && summary.test.verdict === 'passed' ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ causeCode: 'INVOCATION_REJECTED', summaryPath: null }));
    process.exitCode = 2;
  }
