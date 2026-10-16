import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installLocal, type LocalInstallOptions } from '../lib/local-install.ts';

async function withInstallation(
  run: (options: LocalInstallOptions, parent: string) => Promise<void>,
) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-local-install-')));
  try {
    const options = {
      runtimeSource: path.join(parent, 'source/dist'),
      skillSource: path.join(parent, 'source/skills/qa-fleet'),
      prefix: path.join(parent, 'local'),
      skillDirectory: path.join(parent, 'codex/skills/qa-fleet'),
    };
    await mkdir(path.join(options.runtimeSource, 'node_modules/@playwright/test'), {
      recursive: true,
    });
    await mkdir(options.skillSource, { recursive: true });
    await writeFile(path.join(options.runtimeSource, 'qa-fleet'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(options.runtimeSource, 'qa-fleet'), 0o755);
    await writeFile(path.join(options.runtimeSource, 'portable-runtime.tgz'), 'test archive');
    await writeFile(path.join(options.runtimeSource, 'node_modules/@playwright/test/cli.js'), '');
    await writeFile(
      path.join(options.runtimeSource, 'build.json'),
      JSON.stringify({ platform: process.platform, arch: process.arch }),
    );
    await writeFile(path.join(options.skillSource, 'SKILL.md'), '# Test skill\n');
    await run(options, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('local install retains sidecars and relative links, then replaces an owned installation', async () => {
  await withInstallation(async (options) => {
    await writeFile(path.join(options.runtimeSource, 'old-sidecar.txt'), 'first revision');
    await symlink('@playwright/test/cli.js', path.join(options.runtimeSource, 'node_modules/cli'));
    const installed = await installLocal(options);
    assert.equal(await readlink(installed.launcher), '../share/qa-fleet/runtime/qa-fleet');
    assert.equal(
      await readlink(path.join(installed.runtimeDirectory, 'node_modules/cli')),
      '@playwright/test/cli.js',
    );
    assert.equal(
      await readFile(path.join(installed.runtimeDirectory, 'old-sidecar.txt'), 'utf8'),
      'first revision',
    );
    assert.equal(
      await readFile(path.join(installed.skillDirectory, 'SKILL.md'), 'utf8'),
      '# Test skill\n',
    );

    await rm(path.join(options.runtimeSource, 'old-sidecar.txt'));
    await writeFile(path.join(options.runtimeSource, 'new-sidecar.txt'), 'second revision');
    await writeFile(path.join(options.skillSource, 'SKILL.md'), '# Updated skill\n');
    await installLocal(options);
    await assert.rejects(lstat(path.join(installed.runtimeDirectory, 'old-sidecar.txt')));
    assert.equal(
      await readFile(path.join(installed.runtimeDirectory, 'new-sidecar.txt'), 'utf8'),
      'second revision',
    );
    assert.equal(
      await readFile(path.join(installed.skillDirectory, 'SKILL.md'), 'utf8'),
      '# Updated skill\n',
    );
  });
});

for (const collision of ['runtime', 'skill', 'command', 'symlink'] as const) {
  test(`local install preserves an unrelated ${collision} and leaves other targets untouched`, async () => {
    await withInstallation(async (options, parent) => {
      const command = path.join(options.prefix, 'bin/qa-fleet');
      const runtime = path.join(options.prefix, 'share/qa-fleet');
      let destination = command;
      if (collision === 'skill') destination = options.skillDirectory;
      if (collision === 'runtime') destination = runtime;
      await mkdir(path.dirname(destination), { recursive: true });
      if (collision === 'symlink') {
        await symlink(path.join(parent, 'someone-elses-cli'), destination);
      } else if (collision === 'command') {
        await writeFile(destination, 'unrelated executable');
      } else {
        await mkdir(destination);
        await writeFile(path.join(destination, 'keep.txt'), 'unrelated files');
      }
      await assert.rejects(installLocal(options), /unrelated installation target/);
      if (collision === 'symlink') {
        assert.equal(await readlink(destination), path.join(parent, 'someone-elses-cli'));
      } else if (collision === 'command') {
        assert.equal(await readFile(destination, 'utf8'), 'unrelated executable');
      } else {
        assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), 'unrelated files');
      }
      for (const other of [command, runtime, options.skillDirectory]) {
        if (other !== destination) await assert.rejects(lstat(other));
      }
    });
  });
}

test('an incomplete rebuild leaves the working runtime and skill in place', async () => {
  await withInstallation(async (options) => {
    const installed = await installLocal(options);
    await rm(path.join(options.runtimeSource, 'portable-runtime.tgz'));
    await writeFile(path.join(options.skillSource, 'SKILL.md'), '# Uninstallable revision\n');
    await assert.rejects(installLocal(options));
    assert.equal(
      await readFile(path.join(installed.runtimeDirectory, 'portable-runtime.tgz'), 'utf8'),
      'test archive',
    );
    assert.equal(
      await readFile(path.join(installed.skillDirectory, 'SKILL.md'), 'utf8'),
      '# Test skill\n',
    );
  });
});

test('a symlinked parent cannot hide overlapping source and destination directories', async () => {
  await withInstallation(async (options, parent) => {
    const alias = path.join(parent, 'source-alias');
    await symlink(path.dirname(options.runtimeSource), alias);
    options.skillDirectory = path.join(alias, 'skills/qa-fleet');
    await assert.rejects(installLocal(options), /overlaps source files/);
    assert.equal(
      await readFile(path.join(options.skillSource, 'SKILL.md'), 'utf8'),
      '# Test skill\n',
    );
  });
});

test('a linked prefix subdirectory cannot install back into the build source', async () => {
  await withInstallation(async (options) => {
    await mkdir(options.prefix);
    await symlink(options.runtimeSource, path.join(options.prefix, 'share'));
    await assert.rejects(installLocal(options), /overlaps source files/);
    assert.equal(
      await readFile(path.join(options.runtimeSource, 'qa-fleet'), 'utf8'),
      '#!/bin/sh\nexit 0\n',
    );
  });
});

test('runtime upgrades and legacy migration preserve sibling user data bytes', async () => {
  await withInstallation(async (options) => {
    const container = path.join(options.prefix, 'share/qa-fleet');
    await mkdir(path.join(container, 'user-data/runs'), { recursive: true });
    await mkdir(path.join(container, 'tools-env/bin'), { recursive: true });
    await mkdir(path.join(options.prefix, 'bin'), { recursive: true });
    await writeFile(
      path.join(container, '.qa-fleet-install.json'),
      JSON.stringify({ package: 'qa-fleet', schemaVersion: 1, component: 'runtime' }),
    );
    await writeFile(path.join(container, 'qa-fleet'), 'legacy executable');
    await symlink('../share/qa-fleet/qa-fleet', path.join(options.prefix, 'bin/qa-fleet'));
    const saved = path.join(container, 'user-data/runs/report.json');
    const python = path.join(container, 'tools-env/bin/python');
    await writeFile(saved, '{"originalEvidence":true}');
    await writeFile(python, 'existing tool environment');
    for (let revision = 0; revision < 2; revision++) {
      await writeFile(path.join(options.runtimeSource, 'revision.txt'), String(revision));
      const installed = await installLocal(options);
      assert.equal(await readFile(saved, 'utf8'), '{"originalEvidence":true}');
      assert.equal(await readFile(python, 'utf8'), 'existing tool environment');
      assert.equal(
        await readFile(path.join(installed.runtimeDirectory, 'revision.txt'), 'utf8'),
        String(revision),
      );
      assert.equal(
        JSON.parse(await readFile(path.join(container, '.qa-fleet-install.json'), 'utf8'))
          .component,
        'container',
      );
    }
  });
});

test('updates retain unexpected runtime and skill files in discoverable recovery trees', async () => {
  await withInstallation(async (options) => {
    const installed = await installLocal(options);
    await mkdir(path.join(installed.runtimeDirectory, 'saved-runs'));
    await writeFile(
      path.join(installed.runtimeDirectory, 'saved-runs/report.json'),
      '{"saved":true}',
    );
    await writeFile(path.join(installed.skillDirectory, 'personal-notes.txt'), 'keep my notes');
    await writeFile(path.join(options.runtimeSource, 'qa-fleet'), '#!/bin/sh\nexit 7\n');
    const updated = await installLocal(options);
    assert.equal(updated.recoveryDirectories.length, 2);
    const [oldRuntime, oldSkill] = updated.recoveryDirectories;
    assert.equal(
      await readFile(path.join(oldRuntime, 'saved-runs/report.json'), 'utf8'),
      '{"saved":true}',
    );
    assert.equal(
      await readFile(path.join(oldSkill, 'personal-notes.txt'), 'utf8'),
      'keep my notes',
    );
    assert.equal(
      await readFile(path.join(updated.runtimeDirectory, 'qa-fleet'), 'utf8'),
      '#!/bin/sh\nexit 7\n',
    );
    await installLocal(options);
    assert.equal(
      await readFile(path.join(oldRuntime, 'saved-runs/report.json'), 'utf8'),
      '{"saved":true}',
    );
    assert.equal(
      await readFile(path.join(oldSkill, 'personal-notes.txt'), 'utf8'),
      'keep my notes',
    );
  });
});

test('failure after replacement rolls back both trees and launcher without losing user files', async () => {
  await withInstallation(async (options) => {
    const installed = await installLocal(options);
    await writeFile(path.join(installed.runtimeDirectory, 'keep.txt'), 'runtime evidence');
    await writeFile(path.join(installed.skillDirectory, 'keep.txt'), 'skill evidence');
    await writeFile(path.join(options.runtimeSource, 'qa-fleet'), '#!/bin/sh\nexit 7\n');
    const marker = path.join(installed.installationDirectory, '.qa-fleet-install.json');
    await assert.rejects(
      installLocal(options, async (source, destination) => {
        if (String(source).endsWith('/container-marker')) {
          // Force an actual rename failure after runtime, skill, and launcher were replaced.
          await rm(marker);
          await mkdir(marker);
        }
        await rename(source, destination);
      }),
    );
    assert.equal(
      await readFile(path.join(installed.runtimeDirectory, 'qa-fleet'), 'utf8'),
      '#!/bin/sh\nexit 0\n',
    );
    assert.equal(
      await readFile(path.join(installed.runtimeDirectory, 'keep.txt'), 'utf8'),
      'runtime evidence',
    );
    assert.equal(
      await readFile(path.join(installed.skillDirectory, 'keep.txt'), 'utf8'),
      'skill evidence',
    );
    assert.equal(await readlink(installed.launcher), '../share/qa-fleet/runtime/qa-fleet');
    const stages = (await readdir(installed.installationDirectory)).filter((name) =>
      name.startsWith('.qa-fleet-stage-'),
    );
    assert.deepEqual(stages, []);
  });
});
