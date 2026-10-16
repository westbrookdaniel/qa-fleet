import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceInputError } from './errors.ts';
import { runtimeDependencyFile, runtimeDirectory, workspaceRuntimeDirectory } from './runtime.ts';
import {
  portableRuntimeName,
  runtimePackageDefinition,
  writePortableDependencies,
} from './runtime-package.ts';

export interface WorkspaceConfig {
  schemaVersion: 1;
  name: string;
  applicationCheckout: string;
}

export async function readWorkspace(root: string): Promise<WorkspaceConfig> {
  let config: unknown;
  try {
    const source = await readFile(await workspaceFile(root, 'fleet.json'), 'utf8');
    if (Buffer.byteLength(source) > 64 * 1024) throw new WorkspaceInputError();
    config = JSON.parse(source);
  } catch {
    throw new WorkspaceInputError(
      'Workspace configuration must be a readable JSON file no larger than 64 KiB.',
    );
  }
  if (
    typeof config !== 'object' ||
    config === null ||
    Array.isArray(config) ||
    !('schemaVersion' in config) ||
    !('name' in config) ||
    !('applicationCheckout' in config) ||
    config.schemaVersion !== 1 ||
    typeof config.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(config.name) ||
    typeof config.applicationCheckout !== 'string' ||
    config.applicationCheckout.length > 4096 ||
    config.applicationCheckout.includes('\0') ||
    !config.applicationCheckout.trim() ||
    Object.keys(config).some(
      (key) => !['schemaVersion', 'name', 'applicationCheckout'].includes(key),
    )
  )
    throw new WorkspaceInputError('Invalid fleet.json workspace configuration.');
  const checkout = process.env.FLEET_APPLICATION_CHECKOUT ?? config.applicationCheckout;
  if (!checkout.trim() || checkout.includes('\0') || checkout.length > 4096)
    throw new WorkspaceInputError('Invalid application checkout override.');
  return { schemaVersion: 1, name: config.name, applicationCheckout: path.resolve(root, checkout) };
}

export async function workspaceFile(root: string, relative: string): Promise<string> {
  const workspace = await realpath(root);
  if (
    typeof relative !== 'string' ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes('..')
  )
    throw new WorkspaceInputError('Expected a file inside the QA workspace.');
  const file = await realpath(path.join(workspace, relative));
  if (!file.startsWith(`${workspace}${path.sep}`) || !(await lstat(file)).isFile())
    throw new WorkspaceInputError('Expected a regular file inside the QA workspace.');
  return file;
}

export async function workspaceDirectory(
  root: string,
  relative: string,
  options: { create?: boolean } = {},
): Promise<string> {
  const workspace = await realpath(root);
  if (typeof relative !== 'string')
    throw new WorkspaceInputError('Expected a relative directory inside the QA workspace.');
  const segments = relative.split(/[\\/]/);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\0') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new WorkspaceInputError('Expected a relative directory inside the QA workspace.');
  let directory = workspace;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    if (options.create) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST')
          throw new WorkspaceInputError('Workspace directory could not be created.');
      }
    }
    try {
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new WorkspaceInputError();
    } catch {
      throw new WorkspaceInputError(
        'Workspace directories must be existing directories without symbolic links.',
      );
    }
  }
  return directory;
}

export async function portableWorkspaceFiles(root: string): Promise<string[]> {
  const definition = JSON.parse(await readFile(await workspaceFile(root, 'package.json'), 'utf8'));
  const dependency = definition.dependencies?.[portableRuntimeName];
  if (dependency === undefined) return [];
  if (
    typeof dependency !== 'string' ||
    !/^file:vendor\/qa-fleet-runtime-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\.tgz$/.test(
      dependency,
    )
  )
    throw new WorkspaceInputError('Portable runtime must use its versioned vendored package.');
  return ['bun.lock', dependency.slice('file:'.length)];
}

export async function assertWorkspaceRuntime(root: string): Promise<void> {
  const workspace = await realpath(root);
  await workspaceDirectory(workspace, '.fleet/evidence', { create: true });
  const portableFiles = await portableWorkspaceFiles(workspace);
  try {
    const runtime = await realpath(runtimeDirectory());
    const workspaceRuntime = workspaceRuntimeDirectory(workspace);
    const workspaceModules = await realpath(path.join(workspace, 'node_modules'));
    if (portableFiles.length === 0) throw new WorkspaceInputError();
    if (
      !workspaceRuntime.startsWith(`${workspace}${path.sep}`) ||
      !workspaceModules.startsWith(`${workspace}${path.sep}`)
    )
      throw new WorkspaceInputError();
    for (const file of portableFiles) await workspaceFile(workspace, file);
    const definition = await runtimePackageDefinition(workspaceRuntime);
    const controller = await runtimePackageDefinition(runtime);
    if (definition.name !== portableRuntimeName || definition.version !== controller.version)
      throw new WorkspaceInputError();
    const workspacePackage = JSON.parse(
      await readFile(path.join(workspace, 'package.json'), 'utf8'),
    );
    const playwright = workspacePackage.dependencies['@playwright/test'];
    if (playwright !== definition.fleetPlaywright) throw new WorkspaceInputError();
    for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
      const owned = await realpath(runtimeDependencyFile(workspace, name));
      const fixture = await realpath(runtimeDependencyFile(workspaceRuntime, name));
      const installed = JSON.parse(await readFile(owned, 'utf8'));
      if (
        owned !== fixture ||
        !owned.startsWith(`${workspaceModules}${path.sep}`) ||
        installed.version !== playwright
      )
        throw new WorkspaceInputError();
    }
    for (const name of ['typescript', '@types/bun']) {
      const installedFile = await realpath(runtimeDependencyFile(workspace, name));
      const installed = JSON.parse(await readFile(installedFile, 'utf8'));
      if (
        !installedFile.startsWith(`${workspaceModules}${path.sep}`) ||
        installed.version !== workspacePackage.devDependencies[name]
      )
        throw new WorkspaceInputError();
    }
  } catch {
    throw new WorkspaceInputError(
      'Workspace requires its pinned local Fleet runtime and one local Playwright installation. Run bun install --frozen-lockfile --ignore-scripts.',
    );
  }
}

export async function installWorkspaceDependencies(root: string): Promise<void> {
  try {
    execFileSync(
      process.execPath,
      ['--no-env-file', 'install', '--frozen-lockfile', '--ignore-scripts', '--no-progress'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        env: { ...process.env, BUN_BE_BUN: '1' },
      },
    );
  } catch {
    throw new WorkspaceInputError(
      'Pinned dependency installation failed or exceeded 120 seconds. Run bun install --frozen-lockfile --ignore-scripts in the new workspace.',
    );
  }
}

export async function initializeWorkspace(
  options: {
    directory: string;
    applicationCheckout: string;
  },
  dependencies: { install?: typeof installWorkspaceDependencies } = {},
) {
  const requestedRoot = path.resolve(options.directory);
  const name = path.basename(requestedRoot);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name))
    throw new WorkspaceInputError(
      'Workspace directory needs a short name using letters, numbers, dots, underscores, or hyphens.',
    );
  const root = path.join(await realpath(path.dirname(requestedRoot)), name);
  let applicationCheckout: string;
  try {
    const requestedCheckout = await realpath(options.applicationCheckout);
    const repositoryRoot = execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgSign=false',
        '-C',
        requestedCheckout,
        'rev-parse',
        '--show-toplevel',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    applicationCheckout = await realpath(repositoryRoot);
  } catch {
    throw new WorkspaceInputError('Application checkout must be an accessible Git working tree.');
  }
  if (root === applicationCheckout || root.startsWith(`${applicationCheckout}${path.sep}`))
    throw new WorkspaceInputError('Create the QA workspace outside the application repository.');
  const runtime = runtimeDirectory();
  await realpath(runtimeDependencyFile(runtime, '@playwright/test'));
  // Exclusive directory creation prevents scaffolding over a user's existing repository.
  await mkdir(root);
  for (const directory of ['parts', 'catalog', 'specs', 'vendor', '.fleet/evidence', '.auth'])
    await workspaceDirectory(root, directory, { create: true });
  const config: WorkspaceConfig = {
    schemaVersion: 1,
    name,
    applicationCheckout: path.relative(root, applicationCheckout),
  };
  await writeFile(path.join(root, 'fleet.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(
    path.join(root, '.gitignore'),
    'node_modules\n.fleet/\n.auth/\nplaywright-report/\ntest-results/\n.env*\n',
  );
  await writePortableDependencies(root, runtime);
  await writeFile(
    path.join(root, 'fixtures.ts'),
    "export { test, expect } from '@qa-fleet/runtime/fixtures';\n",
  );
  await writeFile(
    path.join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'Preserve',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ['bun'],
          skipLibCheck: true,
        },
        include: ['parts/**/*.ts', 'specs/**/*.ts', 'fixtures.ts', 'playwright.config.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, 'playwright.config.ts'),
    `import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['**/specs/**/*.spec.*'],
  projects: [{ name: 'chromium' }],
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  use: {
    baseURL: process.env.FLEET_BASE_URL,
    storageState: existsSync('.auth/state.json') ? '.auth/state.json' : undefined,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
`,
  );
  await writeFile(
    path.join(root, 'AGENTS.md'),
    `# QA workspace

This repository holds ordinary Playwright specs and reusable TypeScript helpers for ${config.name}.

1. Start with bounded discovery: rg -l "<behavior or destination>" parts, then rg -n "^export" on those files. Optional catalog search/show can narrow metadata. Read relevant source and effects; import suitable helpers directly.
2. Add a small exported helper only when behavior is missing. Metadata registration is optional and does not establish correctness.
3. Write specs/ with test and expect from ../fixtures.ts. Call imported functions directly and await them. Keep authentication in ignored .auth/.
4. Assert the requested visible behavior, identities, negative outcomes and persisted state. Wait for destination controls to become visible, then for table loading to finish before reading rows. A changed URL or absent busy attribute alone is insufficient.
5. Typecheck, then verify with an explicit environment and bounded timeout/workers. Wait up to 30 seconds per shell call/poll; avoid repeated one-second polls. Inspect test verdict, cleanup, observedPassing and checkpoint independently.
6. Verify saves flow evidence and a local checkpoint of its static dependencies. Use status --maintenance after edits. Imported source is a dependency, not evidence that each helper ran.

Keep domain cleanup in fixtures; browser/process cleanup does not prove data restoration. Use direct Playwright replay when Fleet evidence is unnecessary. Read README.md for setup.
`,
  );
  await writeFile(
    path.join(root, 'README.md'),
    `# ${config.name}

Independent local Playwright QA workspace. No remote is configured.

After cloning, run bun install --frozen-lockfile --ignore-scripts, then bun run typecheck. The content-addressed vendored Fleet package and bun.lock pin runtime dependencies. Install the pinned Chromium browser separately on a new machine. fleet.json stores a relative application checkout; FLEET_APPLICATION_CHECKOUT can override it locally.

Set FLEET_BASE_URL to the authorized target. Prepare ignored .auth/state.json through your authorized login workflow when needed. Keep credentials and runtime artifacts out of source.

Write exported helpers under parts/ and ordinary specs under specs/. Import test/expect from ../fixtures.ts and call helpers directly: await openPage({ page, context }, { path }). TypeScript controls signatures, fixtures, loops, branches and return values.

The optional catalog adds bounded search and metadata: bun run fleet catalog search --query <behavior>, catalog show --id <helper>, catalog add --file <metadata.json>. Source remains authoritative. No registration is required to use a helper or verify a flow.

Run bun run typecheck, then bun run fleet verify --spec specs/<name>.spec.ts --environment <label> --timeout 120 --workers 1. For a remote target, also pass --deployment <deployment-id>. Verification records the flow result, cleanup, source dependencies and a local Git checkpoint; it never pushes.

Use bun run fleet status for current flow evidence and unfinished attempts, or status --maintenance for affected flows after edits. An imported helper may belong to an untaken branch: dependencies do not prove helper execution. Local application Git state does not prove the server is running that revision. Process cleanup does not prove database restoration.

Use bun run test -- specs/<name>.spec.ts --project chromium for direct Playwright replay without the Fleet controller. A browser-free suite cannot satisfy Fleet's browser custody requirement.
`,
  );
  execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'init', '-b', 'main', root],
    { stdio: 'pipe' },
  );
  await (dependencies.install ?? installWorkspaceDependencies)(root);
  await assertWorkspaceRuntime(root);
  return { workspace: root, applicationCheckout };
}
