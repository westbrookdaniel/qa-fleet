import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

declare const FLEET_COMPILED: boolean;

export function runtimeDirectory(): string {
  const compiled = typeof FLEET_COMPILED !== 'undefined' && FLEET_COMPILED;
  return compiled ? path.dirname(process.execPath) : path.resolve(import.meta.dir, '..');
}

export function workspaceRuntimeDirectory(workspace: string): string {
  const localPackage = path.join(workspace, 'node_modules/@qa-fleet/runtime/package.json');
  return path.dirname(realpathSync(localPackage));
}

export function runtimeDependencyFile(
  runtime: string,
  name: string,
  file = 'package.json',
): string {
  const require = createRequire(path.join(runtime, 'package.json'));
  const definition = require.resolve(`${name}/package.json`);
  return path.join(path.dirname(definition), file);
}

export function playwrightInvocation(checkout?: string) {
  const runtime = runtimeDirectory();
  const controllerRequire = createRequire(path.join(runtime, 'package.json'));
  let cli = controllerRequire.resolve('@playwright/test/cli');
  if (checkout) {
    const checkoutRequire = createRequire(path.join(checkout, 'package.json'));
    try {
      // The CLI and suite fixtures must load the same installed Playwright instance.
      cli = checkoutRequire.resolve('@playwright/test/cli');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  // The compiled executable becomes the Bun CLI only inside this owned child.
  // These controller-owned settings also propagate to Playwright's forked workers.
  const prefix = ['--no-env-file', '--no-install', `--config=${path.join(runtime, 'bunfig.toml')}`];
  return { cli, prefix };
}
