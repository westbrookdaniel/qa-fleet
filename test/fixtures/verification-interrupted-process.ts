import { mock } from 'bun:test';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';

const [workspace, boundary] = process.argv.slice(2);
if (!workspace || !boundary) throw new Error('Workspace and interruption boundary are required.');
const write = filesystem.writeFile;
const remove = filesystem.rm;
async function pauseAtBoundary() {
  process.stdout.write('boundary-ready\n');
  await Bun.stdin.text();
}
mock.module('node:fs/promises', () => ({
  ...filesystem,
  writeFile: async (...args: Parameters<typeof filesystem.writeFile>) => {
    const [filename, contents, options] = args;
    if (
      boundary === 'during-final-publication' &&
      typeof filename === 'string' &&
      filename.endsWith('.tmp') &&
      typeof contents === 'string' &&
      JSON.parse(contents).schemaVersion === 2
    ) {
      await write(filename, contents.slice(0, Math.floor(contents.length / 2)), options);
      await pauseAtBoundary();
      await write(filename, contents, { mode: 0o600 });
      return;
    }
    return write(...args);
  },
  rm: async (...args: Parameters<typeof filesystem.rm>) => {
    if (boundary === 'after-final-publication' && String(args[0]).endsWith('.pending.json'))
      await pauseAtBoundary();
    return remove(...args);
  },
}));
const runner = await import('../../lib/runner.ts');
mock.module(path.resolve(import.meta.dir, '../../lib/runner.ts'), () => ({
  ...runner,
  runSuite: async () => {
    if (boundary === 'before-run') await pauseAtBoundary();
    const output = path.join(workspace, '.fleet/runs/controlled-result');
    await filesystem.mkdir(output, { recursive: true });
    // This receipt-lifecycle control starts no CLI or browser and supplies no passing reports.
    return {
      output,
      test: { verdict: 'not-run' },
      cleanup: { complete: true, custodyAcquired: false },
    };
  },
}));
const { verifyFlow } = await import('../../lib/evidence.ts');
const result = await verifyFlow({
  workspace,
  spec: 'specs/plain.spec.ts',
  environment: 'fixture',
  timeout: 1,
  workers: 1,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
