import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addPart, getParts, type PartContract, readCatalog, searchParts } from '../lib/catalog.ts';

function contract(overrides: Partial<PartContract> = {}): PartContract {
  return {
    schemaVersion: 1,
    id: 'order.open',
    kind: 'action',
    summary: 'Open an existing order by its visible identifier.',
    module: 'parts/open.ts',
    exportName: 'openOrder',
    inputs: { order: 'Order identifier' },
    effects: ['Navigates the current page.'],
    ...overrides,
  };
}

async function withWorkspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-catalog-'));
  try {
    await mkdir(path.join(root, 'catalog'));
    await mkdir(path.join(root, 'parts'));
    // Discovery must never evaluate source modules.
    await writeFile(path.join(root, 'parts/open.ts'), 'throw new Error("DO_NOT_EVALUATE_SOURCE");');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function save(root: string, value: unknown, name = 'part.json') {
  await writeFile(path.join(root, 'catalog', name), JSON.stringify(value));
}

async function interruptedCatalogOperation(
  root: string,
  incoming: string,
  boundary = 'partial-write',
) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--no-install',
      path.join(import.meta.dir, 'fixtures/catalog-interrupted-writer.ts'),
      root,
      incoming,
      boundary,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.exited.finally(() => clearTimeout(deadline));
  const reader = child.stdout.getReader();
  const output = await reader.read();
  reader.releaseLock();
  if (output.done) throw new Error(await new Response(child.stderr).text());
  assert.equal(new TextDecoder().decode(output.value), `${boundary}\n`);
  return child;
}

test('discovery and later registration survive an interrupted contract write', async () => {
  await withWorkspace(async (root) => {
    const incoming = path.join(root, 'incoming.json');
    await writeFile(incoming, JSON.stringify(contract()));
    const child = await interruptedCatalogOperation(root, incoming);
    try {
      assert.deepEqual(await readCatalog(root), []);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
    assert.deepEqual(await readCatalog(root), []);
    assert.deepEqual(await addPart(root, incoming), contract());
    assert.deepEqual(await readCatalog(root), [contract()]);
  });
});

test('concurrent contract publication preserves the winner and accepts identical registration', async () => {
  for (const identical of [true, false]) {
    await withWorkspace(async (root) => {
      const incoming = path.join(root, 'incoming.json');
      await writeFile(incoming, JSON.stringify(contract()));
      const child = await interruptedCatalogOperation(root, incoming);
      try {
        const winner = identical ? contract() : contract({ summary: 'Concurrent winner.' });
        const other = path.join(root, 'other.json');
        await writeFile(other, JSON.stringify(winner));
        await addPart(root, other);
        child.stdin.end();
        const exitCode = await child.exited;
        assert.equal(exitCode, identical ? 0 : 1, await new Response(child.stderr).text());
        assert.deepEqual(await readCatalog(root), [winner]);
        assert.deepEqual(await readdir(path.join(root, 'catalog')), ['order.open.json']);
      } finally {
        child.kill('SIGKILL');
        await child.exited;
      }
    });
  }
});

test('concurrent first registrations can both create an absent optional catalogue', async () => {
  await withWorkspace(async (root) => {
    await rm(path.join(root, 'catalog'), { recursive: true });
    const incoming = path.join(root, 'incoming.json');
    await writeFile(incoming, JSON.stringify(contract()));
    const writers = await Promise.all([
      interruptedCatalogOperation(root, incoming, 'before-catalog-create'),
      interruptedCatalogOperation(root, incoming, 'before-catalog-create'),
    ]);
    try {
      // Both processes observed a missing catalog and now race at the real mkdir.
      for (const writer of writers) writer.stdin.end();
      for (const writer of writers)
        assert.equal(await writer.exited, 0, await new Response(writer.stderr).text());
      assert.deepEqual(await readCatalog(root), [contract()]);
      assert.deepEqual(await readdir(path.join(root, 'catalog')), ['order.open.json']);
    } finally {
      for (const writer of writers) writer.kill('SIGKILL');
      await Promise.all(writers.map((writer) => writer.exited));
    }
  });
});

test('published metadata remains readable when its temporary hard link is removed during lookup', async () => {
  await withWorkspace(async (root) => {
    const temporary = path.join(root, 'catalog/.published.tmp');
    await writeFile(temporary, JSON.stringify(contract()));
    await link(temporary, path.join(root, 'catalog/order.open.json'));
    const child = await interruptedCatalogOperation(root, temporary, 'before-contract-read');
    try {
      // Remove the writer's temporary link after discovery resolves the published filename.
      await rm(temporary);
      child.stdin.end();
      assert.equal(await child.exited, 0, await new Response(child.stderr).text());
      const output: Uint8Array[] = [];
      for await (const chunk of child.stdout) output.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(output).toString('utf8')), [contract()]);
      assert.deepEqual(await readdir(path.join(root, 'catalog')), ['order.open.json']);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  });
});

test('catalogue reads ordered metadata without executing source', async () => {
  await withWorkspace(async (root) => {
    await save(root, contract());
    await save(
      root,
      contract({ id: 'auth.session', kind: 'fixture', summary: 'Authenticated session.' }),
      'auth.json',
    );
    assert.deepEqual(
      (await readCatalog(root)).map((part) => part.id),
      ['auth.session', 'order.open'],
    );
  });
});

test('catalogue rejects malformed required fields and unsupported metadata without disclosing source', async () => {
  await withWorkspace(async (root) => {
    const cases: unknown[] = [
      null,
      { ...contract(), schemaVersion: 2 },
      { ...contract(), id: '../secret' },
      { ...contract(), kind: 'unknown' },
      { ...contract(), exportName: 'default' },
      { ...contract(), exportName: 'x);evil()' },
      { ...contract(), inputs: [] },
      { ...contract(), inputs: { ok: '' } },
      { ...contract(), effects: undefined },
      { ...contract(), unexpected: 'SYNTHETIC_SECRET' },
    ];
    for (const value of cases) {
      await save(root, value);
      await assert.rejects(readCatalog(root), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('SYNTHETIC_SECRET'), false);
        assert.ok(error.message.length < 150);
        return true;
      });
    }
    await writeFile(path.join(root, 'catalog/part.json'), '{ SYNTHETIC_SECRET');
    await assert.rejects(readCatalog(root), /readable JSON/);
  });
});

test('catalogue rejects traversal, missing modules, and escaped module symlinks', async () => {
  await withWorkspace(async (root) => {
    for (const module of [
      '../secret.ts',
      '/parts/open.ts',
      'parts/../secret.ts',
      'parts\\open.ts',
      'parts/nope.ts',
      'parts/open.js',
    ]) {
      await save(root, contract({ module }));
      await assert.rejects(readCatalog(root));
    }
    const outside = await mkdtemp(path.join(tmpdir(), 'fleet-catalog-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.ts'), 'SYNTHETIC_SECRET');
      await symlink(path.join(outside, 'secret.ts'), path.join(root, 'parts/escaped.ts'));
      await save(root, contract({ module: 'parts/escaped.ts' }));
      await assert.rejects(readCatalog(root), /inside the workspace/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('catalogue rejects metadata and directory symlinks outside the workspace', async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'fleet-catalog-outside-'));
    try {
      await writeFile(path.join(outside, 'part.json'), JSON.stringify(contract()));
      await symlink(path.join(outside, 'part.json'), path.join(root, 'catalog/escaped.json'));
      await assert.rejects(readCatalog(root), /inside the workspace/);
      await rm(path.join(root, 'catalog'), { recursive: true });
      await symlink(outside, path.join(root, 'catalog'));
      await assert.rejects(readCatalog(root), /inside the workspace/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('catalogue follows internal symlinks and rejects symbolic-link cycles', async () => {
  await withWorkspace(async (root) => {
    const aliased = contract({ module: 'parts/alias.ts' });
    await mkdir(path.join(root, 'metadata'));
    await writeFile(path.join(root, 'metadata/part.json'), JSON.stringify(aliased));
    await symlink('open.ts', path.join(root, 'parts/alias.ts'));
    const catalogEntry = path.join(root, 'catalog/part.json');
    await symlink('../metadata/part.json', catalogEntry);
    assert.deepEqual(await readCatalog(root), [aliased]);

    const redirected = contract({ summary: 'Reached through a directory symlink.' });
    await mkdir(path.join(root, 'redirected/nested'), { recursive: true });
    await writeFile(path.join(root, 'redirected/part.json'), JSON.stringify(redirected));
    await symlink('../redirected/nested', path.join(root, 'metadata/redirect'));
    await rm(catalogEntry);
    await symlink('../metadata/redirect/../part.json', catalogEntry);
    assert.deepEqual(await readCatalog(root), [redirected]);

    await rm(catalogEntry);
    await symlink('part.json', catalogEntry);
    await assert.rejects(readCatalog(root), /missing or inaccessible/);

    await rm(path.join(root, 'catalog'), { recursive: true });
    await symlink('metadata', path.join(root, 'catalog'));
    assert.deepEqual(await readCatalog(root), [aliased]);
  });
});

test('catalogue rejects duplicate identifiers independently of implementation aliases', async () => {
  await withWorkspace(async (root) => {
    await save(root, contract());
    await save(root, contract({ id: 'auth.session' }), 'alias.json');
    assert.equal((await readCatalog(root)).length, 2);
    await save(root, contract(), 'duplicate.json');
    await assert.rejects(readCatalog(root), /duplicate part ids/);
  });
});

test('add validates before writing and never overwrites an existing contract', async () => {
  await withWorkspace(async (root) => {
    const incoming = path.join(root, 'incoming.json');
    await writeFile(incoming, JSON.stringify({ ...contract(), module: 'parts/missing.ts' }));
    await assert.rejects(addPart(root, incoming), /missing or inaccessible/);
    assert.deepEqual(await readdir(path.join(root, 'catalog')), []);
    await writeFile(incoming, JSON.stringify(contract()));
    assert.equal((await addPart(root, incoming)).id, 'order.open');
    const original = await readFile(path.join(root, 'catalog/order.open.json'), 'utf8');
    await writeFile(incoming, JSON.stringify(contract({ summary: 'Replacement' })));
    await assert.rejects(addPart(root, incoming), /duplicate part ids/);
    assert.equal(await readFile(path.join(root, 'catalog/order.open.json'), 'utf8'), original);
  });
});

test('missing catalogue is empty and first add creates it', async () => {
  await withWorkspace(async (root) => {
    await rm(path.join(root, 'catalog'), { recursive: true });
    assert.deepEqual(await readCatalog(root), []);
    const incoming = path.join(root, 'incoming.json');
    await writeFile(incoming, JSON.stringify(contract()));
    await addPart(root, incoming);
    assert.equal((await readCatalog(root)).length, 1);
  });
});

test('add is idempotent for identical registered metadata including its own catalogue file', async () => {
  await withWorkspace(async (root) => {
    await save(root, contract(), 'order.open.json');
    const registeredFile = path.join(root, 'catalog/order.open.json');
    const original = await readFile(registeredFile, 'utf8');
    assert.deepEqual(await addPart(root, registeredFile), contract());
    const incoming = path.join(root, 'incoming.json');
    await writeFile(incoming, JSON.stringify(contract(), null, 2));
    assert.deepEqual(await addPart(root, incoming), contract());
    assert.equal(await readFile(registeredFile, 'utf8'), original);
    assert.deepEqual(await readdir(path.join(root, 'catalog')), ['order.open.json']);
  });
});

test('ranked discovery prioritizes identifiers, preserves AND matching, and filters kind', async () => {
  await withWorkspace(async (root) => {
    await save(root, contract());
    await save(
      root,
      contract({
        id: 'aaa.check',
        kind: 'assertion',
        summary: 'Assert the open order is visible.',
      }),
      'check.json',
    );
    await save(root, contract({ id: 'order.open.copy' }), 'copy.json');
    const exact = await searchParts(root, { query: 'ORDER.OPEN' });
    assert.equal(exact.items[0].id, 'order.open');
    const words = await searchParts(root, { query: 'open order' });
    assert.deepEqual(
      words.items.map((part) => part.id),
      ['order.open', 'order.open.copy', 'aaa.check'],
    );
    assert.equal((await searchParts(root, { query: 'open missing' })).totalMatches, 0);
    const assertions = await searchParts(root, { query: 'open order', kind: 'assertion' });
    assert.deepEqual(
      assertions.items.map((part) => part.id),
      ['aaa.check'],
    );
    assert.deepEqual(Object.keys(exact.items[0]), ['id', 'kind', 'summary']);
  });
});

test('discovery bounds output and makes every match reachable with a metadata revision', async () => {
  await withWorkspace(async (root) => {
    for (let index = 0; index < 12; index += 1) {
      await save(root, contract({ id: `order.open-${index}` }), `part-${index}.json`);
    }
    const first = await searchParts(root);
    assert.equal(first.items.length, 10);
    assert.equal(first.totalMatches, 12);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 10);
    const second = await searchParts(root, { offset: first.nextOffset ?? 0 });
    assert.equal(second.items.length, 2);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextOffset, null);
    assert.equal(second.catalogRevision, first.catalogRevision);
    assert.equal(new Set([...first.items, ...second.items].map((part) => part.id)).size, 12);
    await save(root, contract({ id: 'order.open-0', summary: 'Updated metadata.' }), 'part-0.json');
    assert.notEqual((await searchParts(root)).catalogRevision, first.catalogRevision);
    const beyond = await searchParts(root, { offset: 100 });
    assert.equal(beyond.items.length, 0);
    assert.equal(beyond.totalMatches, 12);
    assert.equal(beyond.nextOffset, null);
  });
});

test('ranking prefers a focused operation over a related action with extra identifier terms', async () => {
  await withWorkspace(async (root) => {
    for (const id of ['item.clear-search', 'item.search']) {
      await save(root, contract({ id, summary: 'Search items by name.' }), `${id}.json`);
    }
    const page = await searchParts(root, { query: 'item search', limit: 1 });
    assert.equal(page.items[0].id, 'item.search');
    assert.equal(page.totalMatches, 2);
    assert.equal(page.nextOffset, 1);
  });
});

test('discovery rejects invalid bounds and batch retrieval is ordered and all-or-nothing', async () => {
  await withWorkspace(async (root) => {
    await save(root, contract());
    await save(root, contract({ id: 'auth.session' }), 'auth.json');
    assert.deepEqual(
      (await getParts(root, ['order.open', 'auth.session'])).map((part) => part.id),
      ['order.open', 'auth.session'],
    );
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      await assert.rejects(searchParts(root, { limit }), /limit/);
    }
    for (const offset of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(searchParts(root, { offset }), /offset/);
    }
    for (const ids of [
      [],
      ['../escaped'],
      ['order.open', 'order.open'],
      ['order.open', 'absent'],
    ]) {
      await assert.rejects(getParts(root, ids));
    }
    await assert.rejects(
      getParts(
        root,
        Array.from({ length: 101 }, (_, i) => `part-${i}`),
      ),
    );
  });
});
