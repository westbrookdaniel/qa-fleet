import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceInputError } from './errors.ts';
import {
  applicationSnapshot,
  digest,
  hasNewerUnfinishedAttempt,
  latestFlowObservations,
  type Observation,
  readObservations,
  readPendingAttempts,
  workspaceRuntimeHash,
  workspaceSnapshot,
} from './evidence.ts';
import { assertWorkspaceRuntime, readWorkspace, workspaceFile } from './workspace.ts';

function publicSourcePath(file: string): boolean {
  return (
    !path.isAbsolute(file) &&
    !file.includes('\\') &&
    !file.includes('\0') &&
    file
      .split('/')
      .every(
        (segment) =>
          segment &&
          segment !== '..' &&
          segment !== '.' &&
          !['.git', '.auth', '.fleet', 'node_modules'].includes(segment) &&
          !segment.startsWith('.env'),
      )
  );
}

/** A replay plan derived from recorded dependencies; it never executes or repairs a flow. */
export async function maintenanceReport(
  root: string,
  options: { limit?: number; offset?: number } = {},
) {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new WorkspaceInputError(
      'Maintenance limit must be 1..100 and offset must be nonnegative.',
    );
  await assertWorkspaceRuntime(root);
  const config = await readWorkspace(root);
  const [records, application, runtimeHash] = await Promise.all([
    readObservations(root),
    applicationSnapshot(config.applicationCheckout),
    workspaceRuntimeHash(root),
  ]);
  const currentFileHashes = new Map<string, Promise<string | null>>();
  type Snapshot = Awaited<ReturnType<typeof workspaceSnapshot>>;
  const currentSources = new Map<string, Promise<Snapshot | null>>();
  const currentSource = (record: Observation) => {
    const key = record.spec;
    const cached = currentSources.get(key);
    if (cached) return cached;
    const pending = workspaceSnapshot(root, { spec: record.spec }).catch(() => null);
    currentSources.set(key, pending);
    return pending;
  };
  const hashFile = (file: string) => {
    const cached = currentFileHashes.get(file);
    if (cached) return cached;
    const pending = publicSourcePath(file)
      ? workspaceFile(root, file)
          .then(readFile)
          .then(digest)
          .catch(() => null)
      : Promise.resolve(null);
    currentFileHashes.set(file, pending);
    return pending;
  };
  const pendingAttempts = await readPendingAttempts(root, records);

  const flows = await Promise.all(
    latestFlowObservations(records).map(async (record) => {
      const reasons: string[] = record.schemaVersion === 2 ? [] : ['historical-evidence'];
      if (hasNewerUnfinishedAttempt(record, pendingAttempts)) reasons.push('unfinished-attempt');
      const changedFiles: string[] = [];
      const missingFiles: string[] = [];
      const addedFiles: string[] = [];
      const removedDependencies: string[] = [];
      const files = record.source.files;
      const validFiles =
        files &&
        !Array.isArray(files) &&
        typeof files === 'object' &&
        Object.keys(files).length > 0 &&
        Object.values(files).every((hash) => typeof hash === 'string');
      if (!validFiles) reasons.push('source-evidence-incomplete');
      else {
        await Promise.all(
          Object.entries(files).map(async ([file, expected]) => {
            const actual = await hashFile(file);
            if (actual === null) missingFiles.push(file);
            else if (actual !== expected) changedFiles.push(file);
          }),
        );
      }
      // New files can change import resolution without modifying an old dependency.
      // Use verification's resolver so maintenance and observed status share a scope.
      const current = await currentSource(record);
      if (!current) reasons.push('source-inspection-failed');
      else if (validFiles) {
        addedFiles.push(...Object.keys(current.files).filter((file) => !(file in files)));
        removedDependencies.push(...Object.keys(files).filter((file) => !(file in current.files)));
        if (addedFiles.length > 0 || removedDependencies.length > 0)
          reasons.push('source-dependencies-changed');
      }
      // Older observations may omit the executable spec from their dependency hashes.
      if (!(record.spec in (validFiles ? files : {}))) {
        const actualSpec = await hashFile(record.spec);
        if (actualSpec === null) missingFiles.push(record.spec);
        else if (actualSpec !== record.specHash) changedFiles.push(record.spec);
      }
      if (changedFiles.length > 0) reasons.push('source-changed');
      if (missingFiles.length > 0) reasons.push('source-missing');
      if (record.source.runtimeHash !== runtimeHash) reasons.push('runtime-changed');
      if (JSON.stringify(record.application) !== JSON.stringify(application))
        reasons.push('application-checkout-changed');
      if (record.result.test.verdict !== 'passed') reasons.push('last-run-not-passed');
      if (!record.result.cleanup.complete) reasons.push('cleanup-incomplete');
      if (!record.observedPassing) reasons.push('verification-incomplete');
      if (record.checkpointError) reasons.push('checkpoint-failed');
      if (
        record.source.dependencyMode === 'workspace-fallback' ||
        current?.dependencyMode === 'workspace-fallback'
      )
        reasons.push('dependencies-not-static');
      return {
        spec: record.spec,
        environment: record.environment,
        targetOrigin: record.targetOrigin,
        deployment: record.deployment,
        parametersHash: record.parametersHash,
        latestFinished: record.finished,
        reasons,
        changedFiles: changedFiles.sort(),
        missingFiles: missingFiles.sort(),
        addedFiles: addedFiles.sort(),
        removedDependencies: removedDependencies.sort(),
      };
    }),
  );
  const replayCandidates = flows
    .filter((flow) => flow.reasons.length > 0)
    .sort(
      (a, b) => a.spec.localeCompare(b.spec) || a.parametersHash.localeCompare(b.parametersHash),
    );
  const nextOffset = offset + limit < replayCandidates.length ? offset + limit : null;
  return {
    schemaVersion: 2,
    summary: {
      recordedFlowScopes: flows.length,
      replayNeeded: replayCandidates.length,
      unchangedFlowScopes: flows.length - replayCandidates.length,
      pendingAttempts: pendingAttempts.length,
    },
    limit,
    offset,
    nextOffset,
    replayCandidates: replayCandidates.slice(offset, offset + limit),
    pendingAttempts: pendingAttempts.slice(0, limit),
    pendingAttemptsTruncated: pendingAttempts.length > limit,
    interpretation:
      'Replay candidates reflect recorded source and target scopes, not current server health. Source dependencies do not prove helper execution. Pending attempts have no finalized test or cleanup verdict. Nothing was executed or rewritten.',
  };
}
