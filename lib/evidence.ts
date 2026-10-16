import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceInputError } from './errors.ts';
import { inspectExecution } from './execution-evidence.ts';
import { publicResult, runSuite } from './runner.ts';
import { runtimeDependencyFile, runtimeDirectory, workspaceRuntimeDirectory } from './runtime.ts';
import { importedSources, type SourceScope } from './source-scope.ts';
import {
  assertWorkspaceRuntime,
  portableWorkspaceFiles,
  readWorkspace,
  workspaceDirectory,
  workspaceFile,
} from './workspace.ts';

export const digest = (contents: string | Uint8Array) =>
  createHash('sha256').update(contents).digest('hex');

async function sourceFiles(root: string, directory: string): Promise<string[]> {
  await workspaceDirectory(root, directory);
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new WorkspaceInputError('Reusable source directories must not contain symlinks.');
    if (entry.isDirectory()) result.push(...(await sourceFiles(root, relative)));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

export async function workspaceSnapshot(root: string, scope?: SourceScope) {
  await assertWorkspaceRuntime(root);
  const files = [
    'fleet.json',
    'fixtures.ts',
    'playwright.config.ts',
    'package.json',
    'tsconfig.json',
    ...(await portableWorkspaceFiles(root)),
  ];
  let dependencyMode: 'workspace' | 'static-imports' | 'workspace-fallback' = 'workspace';
  let checkpointFiles: string[] | undefined;
  if (scope) {
    const imported = await importedSources(root, [
      'fixtures.ts',
      'playwright.config.ts',
      scope.spec,
    ]);
    dependencyMode = imported.dependencyMode;
    checkpointFiles = [...new Set([...files, ...imported.staticFiles])].sort();
    files.push(...imported.files);
  } else {
    for (const directory of ['parts', 'specs']) {
      if (await lstat(path.join(root, directory)).catch(() => null))
        files.push(...(await sourceFiles(root, directory)));
    }
  }
  const hashes: Record<string, string> = {};
  for (const file of [...new Set(files)].sort())
    hashes[file] = digest(await readFile(await workspaceFile(root, file)));
  const runtimeFingerprint = await workspaceRuntimeHash(root);
  return {
    hash: digest(JSON.stringify({ hashes, runtimeFingerprint })),
    files: hashes,
    runtimeHash: runtimeFingerprint,
    ...(scope ? { scope, dependencyMode, checkpointFiles } : {}),
  };
}

export async function runtimeSourceHash(
  runtime: string,
  executable: string,
  bunVersion = Bun.version,
): Promise<string> {
  const runtimeHash = createHash('sha256');
  runtimeHash.update(JSON.stringify({ bun: bunVersion }));
  for (const name of ['fixtures.ts', 'package.json', 'bunfig.toml'])
    runtimeHash.update(await readFile(path.join(runtime, name)));
  for (const name of ['verification-reporter.ts']) {
    if (await lstat(path.join(runtime, name)).catch(() => null))
      runtimeHash.update(name).update(await readFile(path.join(runtime, name)));
  }
  let compiledSources = false;
  for (const directory of ['lib', 'bin']) {
    try {
      await lstat(path.join(runtime, directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      compiledSources = true;
      continue;
    }
    for (const file of (await sourceFiles(runtime, directory)).sort())
      runtimeHash.update(file).update(await readFile(path.join(runtime, file)));
  }
  // Compiled distributions omit controller source directories.
  if (compiledSources) runtimeHash.update(await readFile(executable));
  for (const name of ['@playwright/test', 'playwright', 'playwright-core', 'typescript'])
    runtimeHash.update(await readFile(runtimeDependencyFile(runtime, name)));
  return runtimeHash.digest('hex');
}

export async function workspaceRuntimeHash(root: string): Promise<string> {
  const controller = await runtimeSourceHash(runtimeDirectory(), process.execPath);
  const workspace = workspaceRuntimeDirectory(root);
  if (path.resolve(workspace) === path.resolve(runtimeDirectory())) return controller;
  const installed = await runtimeSourceHash(workspace, process.execPath);
  return controller === installed ? controller : digest(JSON.stringify({ controller, installed }));
}

function git(root: string, args: string[]) {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

export async function applicationSnapshot(root: string) {
  const revision = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '-z']);
  const hash = createHash('sha256')
    .update(status)
    .update(git(root, ['diff', 'HEAD', '--binary']));
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const file of untracked.sort()) {
    const full = path.join(root, file);
    hash.update(file);
    if ((await lstat(full)).isFile()) hash.update(await readFile(full));
  }
  return { revision, dirty: status.length > 0, dirtyHash: hash.digest('hex') };
}

export interface Observation {
  schemaVersion: 1 | 2;
  id: string;
  finished: string;
  environment: string;
  targetOrigin: string;
  parametersHash: string;
  deployment: string | null;
  application: Awaited<ReturnType<typeof applicationSnapshot>>;
  source: Awaited<ReturnType<typeof workspaceSnapshot>>;
  spec: string;
  specHash: string;
  observedPassing: boolean;
  sourcesUnchanged: boolean;
  result: ReturnType<typeof publicResult>;
  toolchain: { bun: string; playwright: string };
  checkpoint: string | null;
  checkpointError?: 'LOCAL_CHECKPOINT_FAILED' | 'SOURCE_DEPENDENCIES_NOT_STATIC';
}

function targetIdentity(environment: string, deployment?: string) {
  if (
    !/^[A-Za-z0-9._-]{1,80}$/.test(environment) ||
    (deployment && !/^[A-Za-z0-9._-]{1,160}$/.test(deployment))
  )
    throw new WorkspaceInputError('Environment and deployment must be short identifier labels.');
  const target = new URL(process.env.FLEET_BASE_URL ?? '');
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new WorkspaceInputError(
      'FLEET_BASE_URL must be an HTTP URL without credentials, query, or fragment.',
    );
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (!local && !deployment)
    throw new WorkspaceInputError('Remote targets require an explicit deployment identity.');
  const values = Object.entries(process.env)
    .filter(([key]) => key.startsWith('FLEET_'))
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    environment,
    targetOrigin: target.origin,
    deployment: deployment ?? null,
    parametersHash: digest(JSON.stringify(values)),
  };
}

function checkpointFile(file: string): boolean {
  return (
    [
      'fleet.json',
      'fixtures.ts',
      'playwright.config.ts',
      'package.json',
      'tsconfig.json',
      'bun.lock',
      '.gitignore',
      'AGENTS.md',
      'README.md',
    ].includes(file) ||
    /^parts\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.ts$/.test(file) ||
    /^specs\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.spec\.[cm]?[jt]sx?$/.test(file) ||
    /^vendor\/qa-fleet-runtime-[A-Za-z0-9._-]+\.tgz$/.test(file)
  );
}

export async function checkpoint(
  root: string,
  source: Awaited<ReturnType<typeof workspaceSnapshot>>,
) {
  if (source.dependencyMode === 'workspace-fallback')
    throw new WorkspaceInputError(
      'Automatic checkpoints require static source dependencies. Use static imports or ordinary replay.',
    );
  const files = source.checkpointFiles ?? Object.keys(source.files).filter(checkpointFile);
  // Guidance is saved as documentation, never credited as executed source.
  const guidance = ['.gitignore', 'AGENTS.md', 'README.md'];
  const contents = new Map<string, { mode: string; bytes: Buffer }>();
  for (const file of [...new Set([...files, ...guidance])]) {
    if ((await lstat(path.join(root, file)).catch(() => null))?.isSymbolicLink())
      throw new WorkspaceInputError('Checkpoint files must not be symbolic links.');
    let filename: string;
    try {
      filename = await workspaceFile(root, file);
    } catch (error) {
      if (guidance.includes(file) && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const bytes = await readFile(filename);
    if (source.files[file] && digest(bytes) !== source.files[file])
      throw new WorkspaceInputError('Source changed before checkpoint; replay the updated source.');
    const mode = (await lstat(filename)).mode & 0o111 ? '100755' : '100644';
    contents.set(file, { mode, bytes });
  }
  let previous: string | undefined;
  try {
    previous = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    // A newly initialized QA repository has no HEAD yet.
  }
  const deleted =
    previous && !source.scope
      ? git(root, ['diff', '--name-only', '--diff-filter=D', '-z', 'HEAD', '--'])
          .split('\0')
          .filter((file) => file && checkpointFile(file))
      : [];
  const temporary = await mkdtemp(
    path.join(await workspaceDirectory(root, '.fleet'), 'checkpoint-'),
  );
  const environment = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') };
  const isolatedGit = (args: string[], input?: string | Buffer) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'user.name=QA Fleet',
        '-c',
        'user.email=qa-fleet@localhost',
        ...args,
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: environment, input },
    ).trim();
  try {
    isolatedGit(previous ? ['read-tree', previous] : ['read-tree', '--empty']);
    const entries: string[] = [];
    for (const [file, { mode, bytes }] of contents) {
      // Hash and stage the exact bytes checked above, not another read of mutable files.
      const blob = isolatedGit(['hash-object', '-w', '--stdin'], bytes);
      entries.push(`${mode} ${blob}\t${file}\0`);
    }
    for (const file of deleted) entries.push(`0 ${'0'.repeat(40)}\t${file}\0`);
    isolatedGit(['update-index', '-z', '--index-info'], entries.join(''));
    const tree = isolatedGit(['write-tree']);
    if (previous && tree === git(root, ['rev-parse', `${previous}^{tree}`]).trim()) return previous;
    const commit = isolatedGit([
      'commit-tree',
      tree,
      ...(previous ? ['-p', previous] : []),
      '-m',
      'Save QA flow source after passing replay',
    ]);
    // Compare-and-swap protects a concurrent checkpoint or user's commit.
    git(root, ['update-ref', 'HEAD', commit, previous ?? '0'.repeat(40)]);
    // Reconcile only saved paths; unrelated staged work is preserved.
    git(root, ['reset', '--quiet', commit, '--', ...contents.keys(), ...deleted]);
    return commit;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export interface PendingAttempt {
  schemaVersion: 1;
  id: string;
  started: string;
  spec: string;
  environment: string;
  targetOrigin: string;
  deployment: string | null;
  parametersHash: string;
  sourceHash: string;
  application: Awaited<ReturnType<typeof applicationSnapshot>>;
}

async function publishJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // A process interruption cannot expose a partially written final receipt.
    await link(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function verifyFlow(options: {
  workspace: string;
  spec: string;
  environment: string;
  deployment?: string;
  timeout: number;
  workers: number;
}) {
  const root = path.resolve(options.workspace);
  await assertWorkspaceRuntime(root);
  if (!/^specs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.spec\.[cm]?[jt]sx?$/.test(options.spec))
    throw new WorkspaceInputError('Verify requires an authored specs/ file.');
  const spec = await workspaceFile(root, options.spec);
  const specHash = digest(await readFile(spec));
  const scope: SourceScope = { spec: options.spec };
  const config = await readWorkspace(root);
  const source = await workspaceSnapshot(root, scope);
  const application = await applicationSnapshot(config.applicationCheckout);
  const identity = targetIdentity(options.environment, options.deployment);
  const playwrightPackage = JSON.parse(
    await readFile(
      runtimeDependencyFile(workspaceRuntimeDirectory(root), '@playwright/test'),
      'utf8',
    ),
  );
  await workspaceDirectory(root, '.fleet/runs', { create: true });
  const evidenceDirectory = await workspaceDirectory(root, '.fleet/evidence', { create: true });
  const id = randomUUID();
  const pending: PendingAttempt = {
    schemaVersion: 1,
    id,
    started: new Date().toISOString(),
    spec: options.spec,
    ...identity,
    sourceHash: source.hash,
    application,
  };
  const pendingPath = path.join(evidenceDirectory, `${id}.pending.json`);
  await publishJson(pendingPath, pending);
  const result = await runSuite({
    config: path.join(root, 'playwright.config.ts'),
    target: spec,
    checkout: root,
    project: 'chromium',
    timeout: options.timeout,
    workers: options.workers,
    locks: [],
    captureOutput: true,
    verification: { workspace: root },
    output: path.join(root, '.fleet/runs'),
  });
  let sourcesUnchanged = false;
  try {
    sourcesUnchanged =
      source.hash === (await workspaceSnapshot(root, scope)).hash &&
      JSON.stringify(application) ===
        JSON.stringify(await applicationSnapshot(config.applicationCheckout)) &&
      specHash === digest(await readFile(spec));
  } catch {
    // A concurrent deletion or invalid edit retains a non-passing completed observation.
  }
  let execution = { accepted: false, testCount: 0 };
  try {
    const report = JSON.parse(await readFile(path.join(result.output, 'playwright.json'), 'utf8'));
    const inventory = JSON.parse(
      await readFile(path.join(result.output, 'verification-execution.json'), 'utf8'),
    );
    execution = inspectExecution(report, inventory, { target: spec, project: 'chromium' });
  } catch {
    // Missing reports remain non-passing observations.
  }
  const observedPassing =
    result.test.verdict === 'passed' &&
    result.cleanup.complete &&
    sourcesUnchanged &&
    execution.accepted;
  const observation: Observation = {
    schemaVersion: 2,
    id,
    finished: new Date().toISOString(),
    ...identity,
    application,
    source,
    spec: options.spec,
    specHash,
    observedPassing,
    sourcesUnchanged,
    result: publicResult(result),
    toolchain: { bun: Bun.version, playwright: playwrightPackage.version },
    checkpoint: null,
  };
  if (observedPassing && source.dependencyMode === 'workspace-fallback') {
    observation.checkpointError = 'SOURCE_DEPENDENCIES_NOT_STATIC';
  } else if (observedPassing) {
    try {
      observation.checkpoint = await checkpoint(root, source);
    } catch {
      observation.checkpointError = 'LOCAL_CHECKPOINT_FAILED';
    }
  }
  const evidencePath = path.join(evidenceDirectory, `${id}.json`);
  await publishJson(evidencePath, observation);
  // Readers already suppress this pending ID once its complete observation exists.
  await rm(pendingPath, { force: true });
  return {
    ...observation.result,
    observedPassing,
    sourcesUnchanged,
    checkpoint: observation.checkpoint,
    checkpointError: observation.checkpointError,
    evidencePath,
  };
}

export async function readObservations(root: string): Promise<Observation[]> {
  const directory = await workspaceDirectory(root, '.fleet/evidence', { create: true });
  const records: Observation[] = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.json') || file.endsWith('.pending.json')) continue;
    try {
      const record = JSON.parse(
        await readFile(await workspaceFile(root, `.fleet/evidence/${file}`), 'utf8'),
      ) as Observation;
      if (
        (record.schemaVersion === 1 || record.schemaVersion === 2) &&
        typeof record.id === 'string' &&
        typeof record.finished === 'string' &&
        typeof record.spec === 'string' &&
        typeof record.environment === 'string' &&
        typeof record.targetOrigin === 'string' &&
        typeof record.parametersHash === 'string' &&
        record.source &&
        record.application &&
        record.result?.test &&
        record.result?.cleanup
      )
        records.push(record);
    } catch {
      // Historical partial writes do not hide valid records or pending attempts.
    }
  }
  records.sort((a, b) => b.finished.localeCompare(a.finished));
  return records;
}

export async function readPendingAttempts(
  root: string,
  observations?: Observation[],
): Promise<PendingAttempt[]> {
  const completed = new Set(
    (observations ?? (await readObservations(root))).map((record) => record.id),
  );
  const directory = await workspaceDirectory(root, '.fleet/evidence', { create: true });
  const pending: PendingAttempt[] = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.pending.json')) continue;
    try {
      const record = JSON.parse(
        await readFile(await workspaceFile(root, `.fleet/evidence/${file}`), 'utf8'),
      ) as PendingAttempt;
      if (
        record.schemaVersion === 1 &&
        typeof record.id === 'string' &&
        !completed.has(record.id) &&
        typeof record.started === 'string' &&
        typeof record.spec === 'string' &&
        typeof record.environment === 'string' &&
        typeof record.targetOrigin === 'string' &&
        typeof record.parametersHash === 'string' &&
        typeof record.sourceHash === 'string' &&
        record.application
      )
        pending.push(record);
    } catch {
      // Only atomically published, readable pending receipts describe admitted attempts.
    }
  }
  return pending.sort((a, b) => b.started.localeCompare(a.started));
}

function flowIdentity(record: Observation | PendingAttempt): string {
  return JSON.stringify([
    record.spec,
    record.environment,
    record.targetOrigin,
    record.deployment,
    record.parametersHash,
  ]);
}

export function hasNewerUnfinishedAttempt(
  observation: Observation,
  attempts: PendingAttempt[],
): boolean {
  const identity = flowIdentity(observation);
  const finished = Date.parse(observation.finished);
  return attempts.some(
    (attempt) => flowIdentity(attempt) === identity && Date.parse(attempt.started) > finished,
  );
}

export function latestFlowObservations(records: Observation[]): Observation[] {
  const latest = new Map<string, Observation>();
  for (const record of records) {
    const key = flowIdentity(record);
    if (!latest.has(key)) latest.set(key, record);
  }
  return [...latest.values()];
}

export async function flowStatus(root: string) {
  const config = await readWorkspace(root);
  const application = await applicationSnapshot(config.applicationCheckout);
  const records = await readObservations(root);
  const pendingAttempts = await readPendingAttempts(root, records);
  const snapshots = new Map<string, Promise<string | null>>();
  const currentHash = (spec: string) => {
    const existing = snapshots.get(spec);
    if (existing) return existing;
    const pending = workspaceSnapshot(root, { spec })
      .then((snapshot) => snapshot.hash)
      .catch(() => null);
    snapshots.set(spec, pending);
    return pending;
  };
  const flows = await Promise.all(
    latestFlowObservations(records).map(async (record) => {
      let status: string;
      if (hasNewerUnfinishedAttempt(record, pendingAttempts)) status = 'unfinished-attempt';
      else if (record.schemaVersion !== 2) status = 'historical-evidence';
      else if (
        record.source.hash !== (await currentHash(record.spec)) ||
        JSON.stringify(record.application) !== JSON.stringify(application)
      )
        status = 'changed-since-observation';
      else if (record.observedPassing) status = 'observed-passing';
      else if (record.result.test.verdict === 'failed') status = 'failed';
      else status = 'verification-incomplete';
      return {
        id: record.id,
        spec: record.spec,
        environment: record.environment,
        targetOrigin: record.targetOrigin,
        deployment: record.deployment,
        parametersHash: record.parametersHash,
        finished: record.finished,
        status,
        observedPassing: record.observedPassing,
        testVerdict: record.result.test.verdict,
        cleanupComplete: record.result.cleanup.complete,
        checkpoint: record.checkpoint,
        checkpointError: record.checkpointError,
        sourceDependencies: Object.keys(record.source.files ?? {}).sort(),
      };
    }),
  );
  return { flows, pendingAttempts };
}
