import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cli = path.resolve(import.meta.dir, '../bin/qa-fleet.ts');

async function withMetadataWorkspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-catalog-cli-'));
  try {
    await mkdir(path.join(root, 'catalog'));
    await mkdir(path.join(root, 'parts'));
    await writeFile(path.join(root, 'parts/example.ts'), 'throw new Error("NEVER_EXECUTE");');
    for (const id of ['order.open', 'order.check']) {
      await writeFile(
        path.join(root, 'catalog', `${id}.json`),
        JSON.stringify({
          schemaVersion: 1,
          id,
          kind: id === 'order.check' ? 'assertion' : 'action',
          summary: 'Open an order and inspect its visible identifier.',
          module: 'parts/example.ts',
          exportName: 'example',
          inputs: {},
          effects: [],
        }),
      );
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function invoke(root: string, args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--no-install',
      cli,
      'catalog',
      ...args,
      '--workspace',
      root,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  return { exitCode, value: JSON.parse(output) };
}

test('CLI metadata discovery and batch show need no runtime, evidence, or application checkout', async () => {
  await withMetadataWorkspace(async (root) => {
    const search = await invoke(root, ['search', '--query', 'open', '--limit', '1']);
    assert.equal(search.exitCode, 0);
    assert.equal(search.value.totalMatches, 2);
    assert.equal(search.value.items.length, 1);
    assert.equal(search.value.nextOffset, 1);
    assert.equal('evidence' in search.value.items[0], false);
    const next = await invoke(root, ['search', '--query', 'open', '--limit', '1', '--offset', '1']);
    assert.equal(next.value.items.length, 1);
    assert.notEqual(next.value.items[0].id, search.value.items[0].id);
    const shown = await invoke(root, ['show', '--id', 'order.open', '--id', 'order.check']);
    assert.equal(shown.exitCode, 0);
    assert.deepEqual(
      shown.value.map((item: { contract: { id: string } }) => item.contract.id),
      ['order.open', 'order.check'],
    );
    assert.equal('evidence' in shown.value[0], false);
    const one = await invoke(root, ['show', '--id', 'order.open']);
    assert.equal(one.value.contract.id, 'order.open');
    // Explicit evidence must still enforce runtime/source checks, never invent a status.
    const evidence = await invoke(root, ['show', '--id', 'order.open', '--evidence']);
    assert.equal(evidence.exitCode, 2);
  });
});

test('CLI rejects invalid search bounds, kinds, duplicate ids, and misplaced options', async () => {
  await withMetadataWorkspace(async (root) => {
    for (const args of [
      ['search', '--limit', '0'],
      ['search', '--limit', '101'],
      ['search', '--limit', 'NaN'],
      ['search', '--offset', '-1'],
      ['search', '--kind', 'unknown'],
      ['search', '--kind', ''],
      ['search', '--id', 'order.open'],
      ['show', '--id', 'order.open', '--limit', '2'],
      ['show', '--id', 'order.open', '--id', 'order.open'],
      ['show', '--id', 'order.open', '--id', 'missing'],
    ]) {
      const result = await invoke(root, args);
      assert.equal(result.exitCode, 2, args.join(' '));
      assert.equal(result.value.causeCode, 'WORKSPACE_OPERATION_REJECTED');
      assert.ok(result.value.message.length > 0);
    }
  });
});

test('omitted workspace selects only valid current-directory metadata and explicit flags always win', async () => {
  await withMetadataWorkspace(async (root) => {
    async function from(directory: string, extra: string[] = []) {
      const child = Bun.spawn(
        [process.execPath, '--no-env-file', '--no-install', cli, 'catalog', 'search', ...extra],
        { cwd: directory, stdout: 'pipe', stderr: 'pipe' },
      );
      const output = await new Response(child.stdout).text();
      return { exitCode: await child.exited, value: JSON.parse(output) };
    }
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    assert.equal((await from(root)).exitCode, 2);
    const config = path.join(root, 'fleet.json');
    await writeFile(
      config,
      JSON.stringify({ schemaVersion: 1, name: 'metadata', applicationCheckout: './unneeded-app' }),
    );
    assert.equal((await from(root)).value.totalMatches, 2);
    assert.equal((await from(nested)).exitCode, 2);
    assert.equal((await from(root, ['--workspace', ''])).exitCode, 2);
    assert.equal((await from(root, ['--workspace', nested])).exitCode, 0);
    assert.equal((await from(root, ['--workspace', nested])).value.totalMatches, 0);
    await writeFile(config, '{broken');
    assert.equal((await from(root)).exitCode, 2);
    // Explicit metadata-only discovery still needs neither an app checkout nor config.
    assert.equal((await from(nested, ['--workspace', root])).value.totalMatches, 2);
  });
});
