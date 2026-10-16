import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installLocal } from '../lib/local-install.ts';

const root = path.resolve(import.meta.dir, '..');
const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-installed-smoke-')));
try {
  const installed = await installLocal({
    runtimeSource: path.join(root, 'dist'),
    skillSource: path.join(root, 'skills/qa-fleet'),
    prefix: path.join(parent, 'original-prefix'),
    skillDirectory: path.join(parent, 'codex/skills/qa-fleet'),
  });
  const prefix = path.join(parent, 'relocated-prefix');
  await rename(path.join(parent, 'original-prefix'), prefix);
  const executable = path.join(prefix, 'bin/qa-fleet');
  const runtime = path.join(prefix, 'share/qa-fleet/runtime');
  const help = execFileSync(executable, ['--help'], {
    cwd: parent,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.match(help, /qa-fleet/);
  const childExecutable = execFileSync(
    executable,
    ['--no-env-file', '--print', 'process.execPath'],
    {
      cwd: parent,
      env: { ...process.env, BUN_BE_BUN: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(childExecutable.trim(), path.join(runtime, 'qa-fleet'));
  // Real Playwright collection exercises copied fixtures, config and dynamic sidecars without browsers.
  const collected = execFileSync(
    executable,
    [
      '--no-env-file',
      '--no-install',
      `--config=${path.join(runtime, 'bunfig.toml')}`,
      path.join(runtime, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      path.join(runtime, 'playwright.config.ts'),
      '--list',
      '--project',
      'chromium',
    ],
    {
      cwd: parent,
      env: { ...process.env, BUN_BE_BUN: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.match(collected, /replay\.spec\.ts/);
  assert.equal(
    await readFile(path.join(installed.skillDirectory, 'SKILL.md'), 'utf8'),
    await readFile(path.join(root, 'skills/qa-fleet/SKILL.md'), 'utf8'),
  );
  console.log(
    'Installed CLI help, relocated compiled child, Playwright collection and skill copy passed.',
  );
} finally {
  await rm(parent, { recursive: true, force: true });
}
