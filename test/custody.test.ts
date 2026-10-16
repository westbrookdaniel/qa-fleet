import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireLeases,
  browserGroups,
  groupPresent,
  observePressure,
  releaseLeases,
  retireBrowsers,
  retireGroup,
} from '../lib/custody.ts';

test('resource conflict refuses and rolls back only newly acquired leases', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-lock-test-'));
  try {
    const held = await acquireLeases(['db:shared'], root);
    await assert.rejects(acquireLeases(['checkout:new', 'db:shared'], root), /already held/);
    assert.equal((await readdir(root)).length, 1);
    await releaseLeases(held);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('duplicate resources acquire once and release completely', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-lock-test-'));
  try {
    const held = await acquireLeases(['port:3001', 'port:3001'], root);
    assert.equal(held.length, 1);
    await releaseLeases(held);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('only ESRCH establishes group absence; EPERM remains unknown', () => {
  const failure = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(groupPresent(123, failure('ESRCH')), false);
  assert.throws(() => groupPresent(123, failure('EPERM')), /EPERM/);
});

test('signal without child reap cannot claim successful cleanup', async () => {
  const receipt = await retireGroup({ pid: 123 }, new Promise(() => {}), {
    graceMilliseconds: 1,
    kill: () => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    },
  });
  assert.equal(receipt.groupAbsent, true);
  assert.equal(receipt.childReaped, false);
  assert.equal(receipt.complete, false);
});

test('known child reap and group absence resolve custody without redundant signals', async () => {
  const receipt = await retireGroup({ pid: 123 }, Promise.resolve(), {
    graceMilliseconds: 1,
    kill: () => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    },
  });
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.signals, []);
});

test('unsupported pressure observations refuse execution', async () => {
  const observation = await observePressure('unsupported');
  assert.equal(observation.safe, false);
});

test('Mac warning remains usable while critical, unknown and failed probes refuse', async () => {
  for (const [value, safe] of [
    ['1', true],
    ['2', true],
    ['4', false],
    ['3', false],
    ['garbage', false],
  ] as const) {
    const observation = await observePressure('darwin', 1, {
      execute: async () => ({ stdout: value }),
    });
    assert.equal(observation.safe, safe, value);
  }
  const observation = await observePressure('darwin', 1, {
    execute: async () => {
      throw new Error('timeout');
    },
  });
  assert.equal(observation.safe, false);
});

test('registered PID with missing leader but live group remains unresolved', async () => {
  await assert.rejects(
    browserGroups('own', 'unused', {
      execute: async () => ({ stdout: '' }),
      read: async () => '{"pid":123,"marker":"own"}\n',
      kill: () => {},
    }),
    /leader is absent/,
  );
});

test('registered PID with changed marker cannot confer custody', async () => {
  await assert.rejects(
    browserGroups('own', 'unused', {
      execute: async () => ({ stdout: '123 123 chrome --qa-fleet-custody=other' }),
      read: async () => '{"pid":123,"marker":"own"}\n',
      kill: () => {},
    }),
    /ownership changed/,
  );
});

test('lost live marker before escalation prevents signal and fails cleanup', async () => {
  const sent: (number | NodeJS.Signals)[] = [];
  let observations = 0;
  const receipt = await retireBrowsers('own', 'unused', {
    inspect: async () => {
      observations += 1;
      if (observations > 1) throw new Error('ownership changed');
      return { groups: [123], registered: [123] };
    },
    kill: (_group, signal) => {
      if (signal !== 0) sent.push(signal);
    },
    graceMilliseconds: 1,
  });
  assert.equal(receipt.complete, false);
  assert.deepEqual(sent, []);
});

test('transient post-TERM probe EPERM resolves with reap and ESRCH without escalation', async () => {
  let signalled = false;
  let uncertain = true;
  const receipt = await retireGroup({ pid: 123 }, Promise.resolve(), {
    graceMilliseconds: 100,
    kill: (_group, signal) => {
      if (signal !== 0) {
        assert.equal(signal, 'SIGTERM');
        signalled = true;
        return;
      }
      if (!signalled) return;
      if (uncertain) {
        uncertain = false;
        throw Object.assign(new Error('unknown'), { code: 'EPERM' });
      }
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    },
  });
  assert.equal(receipt.complete, true);
  assert.equal(receipt.childReaped, true);
  assert.equal(receipt.groupAbsent, true);
  assert.deepEqual(receipt.signals, ['SIGTERM']);
  assert.deepEqual(receipt.probeErrors, [{ phase: 'after SIGTERM', code: 'EPERM' }]);
});

test('persistent post-TERM probe EPERM stays within one grace without escalation', async () => {
  const signals: (number | NodeJS.Signals)[] = [];
  const started = performance.now();
  const receipt = await retireGroup({ pid: 123 }, Promise.resolve(), {
    graceMilliseconds: 40,
    kill: (_group, signal) => {
      if (signal !== 0) {
        signals.push(signal);
        return;
      }
      if (!signals.length) return;
      throw Object.assign(new Error('unknown'), { code: 'EPERM' });
    },
  });
  assert.equal(receipt.complete, false);
  assert.equal(receipt.groupAbsent, false);
  assert.equal(receipt.error, 'EPERM');
  assert.ok(receipt.probeErrors);
  assert.ok(receipt.probeErrors.length >= 2);
  assert.ok(receipt.probeErrors.every((error) => error.phase === 'after SIGTERM'));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.ok(performance.now() - started < 500, 'unknown observation does not add a second grace');
});

test('actual signal EPERM is not retried or escalated', async () => {
  const signals: (number | NodeJS.Signals)[] = [];
  const receipt = await retireGroup({ pid: 123 }, Promise.resolve(), {
    kill: (_group, signal) => {
      if (signal === 0) return;
      signals.push(signal);
      throw Object.assign(new Error('denied signal'), { code: 'EPERM' });
    },
  });
  assert.equal(receipt.complete, false);
  assert.equal(receipt.error, 'EPERM');
  assert.deepEqual(receipt.signals, []);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.deepEqual(receipt.probeErrors, []);
});
