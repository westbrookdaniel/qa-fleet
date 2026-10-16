import { constants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const ownershipFile = '.qa-fleet-install.json';

export interface LocalInstallOptions {
  runtimeSource: string;
  skillSource: string;
  prefix: string;
  skillDirectory: string;
}

interface InstallTarget {
  destination: string;
  component: 'runtime' | 'skill' | 'launcher';
  source?: string;
  staging?: string;
  hadPrevious?: boolean;
  installed?: boolean;
  recoveryDirectory?: string;
}

async function statIfPresent(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function overlaps(first: string, second: string) {
  const relative = path.relative(second, first);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalDirectory(directory: string): Promise<string> {
  if (await statIfPresent(directory)) return realpath(directory);
  return path.join(await canonicalDirectory(path.dirname(directory)), path.basename(directory));
}

async function canonicalDestination(destination: string) {
  const absolute = path.resolve(destination);
  return path.join(await canonicalDirectory(path.dirname(absolute)), path.basename(absolute));
}

async function assertOwnedTarget(target: InstallTarget, launcherLinks: string[]) {
  const stat = await statIfPresent(target.destination);
  if (!stat) return;
  if (target.component === 'launcher') {
    if (stat.isSymbolicLink() && launcherLinks.includes(await readlink(target.destination))) return;
  } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
    try {
      const marker = JSON.parse(
        await readFile(path.join(target.destination, ownershipFile), 'utf8'),
      );
      if (
        marker.package === 'qa-fleet' &&
        marker.schemaVersion === 1 &&
        marker.component === target.component
      ) {
        return;
      }
    } catch {
      // Missing or unreadable ownership never authorizes replacement.
    }
  }
  throw new Error(`Refusing to replace an unrelated installation target: ${target.destination}`);
}

/** Install complete sidecars and the skill together, restoring the prior install on failure. */
export async function installLocal(options: LocalInstallOptions, replace = rename) {
  const runtimeSource = await realpath(options.runtimeSource);
  const skillSource = await realpath(options.skillSource);
  const prefix = await canonicalDirectory(path.resolve(options.prefix));
  // Program updates replace only runtime/; other user data under share/qa-fleet is left alone.
  const installationDirectory = await canonicalDestination(path.join(prefix, 'share/qa-fleet'));
  const runtimeDirectory = await canonicalDestination(path.join(installationDirectory, 'runtime'));
  for (const source of [runtimeSource, skillSource]) {
    if (overlaps(installationDirectory, source) || overlaps(source, installationDirectory)) {
      throw new Error(`Installation target overlaps source files: ${installationDirectory}`);
    }
  }
  const existingContainer = await statIfPresent(installationDirectory);
  if (existingContainer) {
    const marker =
      existingContainer.isDirectory() && !existingContainer.isSymbolicLink()
        ? await readFile(path.join(installationDirectory, ownershipFile), 'utf8').catch(() => '')
        : '';
    let owned = false;
    try {
      const parsed = JSON.parse(marker);
      owned =
        parsed.package === 'qa-fleet' &&
        parsed.schemaVersion === 1 &&
        ['runtime', 'container'].includes(parsed.component);
    } catch {
      /* An unrelated data directory must remain untouched. */
    }
    if (!owned)
      throw new Error(
        `Refusing to replace an unrelated installation target: ${installationDirectory}`,
      );
  }
  const launcher = await canonicalDestination(path.join(prefix, 'bin/qa-fleet'));
  const skillDirectory = await canonicalDestination(options.skillDirectory);
  const launcherLink = path.relative(
    path.dirname(launcher),
    path.join(runtimeDirectory, 'qa-fleet'),
  );
  const launcherLinks = [
    launcherLink,
    path.relative(path.dirname(launcher), path.join(installationDirectory, 'qa-fleet')),
  ];
  const targets: InstallTarget[] = [
    { destination: runtimeDirectory, component: 'runtime', source: runtimeSource },
    { destination: skillDirectory, component: 'skill', source: skillSource },
    { destination: launcher, component: 'launcher' },
  ];
  for (const target of targets) {
    for (const source of [runtimeSource, skillSource]) {
      if (overlaps(target.destination, source) || overlaps(source, target.destination)) {
        throw new Error(`Installation target overlaps source files: ${target.destination}`);
      }
    }
    for (const other of targets) {
      if (target !== other && overlaps(target.destination, other.destination)) {
        throw new Error(`Installation targets overlap: ${target.destination}`);
      }
    }
    await assertOwnedTarget(target, launcherLinks);
  }

  // A marker identifies an installation, not ownership of every file later added to it.
  // Successful updates keep old trees until the user explicitly removes them.
  const recoveryDirectories: string[] = [];
  const build = JSON.parse(await readFile(path.join(runtimeSource, 'build.json'), 'utf8'));
  if (build.platform !== process.platform || build.arch !== process.arch) {
    throw new Error('The built runtime does not match this platform and architecture.');
  }
  await access(path.join(runtimeSource, 'qa-fleet'), constants.X_OK);
  await access(path.join(runtimeSource, 'portable-runtime.tgz'));
  await access(path.join(runtimeSource, 'node_modules/@playwright/test/cli.js'));
  await access(path.join(skillSource, 'SKILL.md'));

  try {
    // Stage every component before replacing any existing installation.
    for (const target of targets) {
      await mkdir(path.dirname(target.destination), { recursive: true });
      target.staging = await mkdtemp(
        path.join(path.dirname(target.destination), '.qa-fleet-stage-'),
      );
      const payload = path.join(target.staging, 'payload');
      if (target.source) {
        await cp(target.source, payload, { recursive: true, verbatimSymlinks: true });
        await writeFile(
          path.join(payload, ownershipFile),
          `${JSON.stringify({ package: 'qa-fleet', schemaVersion: 1, component: target.component })}\n`,
        );
      } else {
        await symlink(launcherLink, payload);
      }
    }
    for (const target of targets) await assertOwnedTarget(target, launcherLinks);
    for (const target of targets) {
      const staging = target.staging as string;
      if (await statIfPresent(target.destination)) {
        await replace(target.destination, path.join(staging, 'previous'));
        target.hadPrevious = true;
        if (target.component !== 'launcher') {
          target.recoveryDirectory = staging;
          recoveryDirectories.push(path.join(staging, 'previous'));
        }
      }
      await replace(path.join(staging, 'payload'), target.destination);
      target.installed = true;
    }
    // Old installers recognize only component=runtime and now refuse to replace this parent.
    const containerMarker = path.join(targets[0].staging as string, 'container-marker');
    await writeFile(
      containerMarker,
      `${JSON.stringify({ package: 'qa-fleet', schemaVersion: 1, component: 'container' })}\n`,
    );
    await replace(containerMarker, path.join(installationDirectory, ownershipFile));
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const target of [...targets].reverse()) {
      try {
        if (target.installed) await rm(target.destination, { recursive: true, force: true });
        if (target.hadPrevious) {
          await replace(path.join(target.staging as string, 'previous'), target.destination);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      // Preserve staging directories containing recoverable previous installations.
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Installation failed; previous files remain in the .qa-fleet-stage-* directories.',
      );
    }
    for (const target of targets) {
      if (target.staging) await rm(target.staging, { recursive: true, force: true });
    }
    throw error;
  }
  for (const target of targets) {
    if (target.staging && !target.recoveryDirectory) {
      await rm(target.staging, { recursive: true, force: true });
    }
  }
  return { installationDirectory, runtimeDirectory, launcher, skillDirectory, recoveryDirectories };
}
