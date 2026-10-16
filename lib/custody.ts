import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { errorCode, errorMessage } from './errors.ts';
import type { BrowserCleanup, GroupCleanup, PressureObservation } from './types.ts';

const executeFile = promisify(execFile);
type Execute = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;
type Read = (file: string, encoding: 'utf8') => Promise<string>;
type Kill = (pid: number, signal: NodeJS.Signals | number) => unknown;
interface Probes {
  execute?: Execute;
  read?: Read;
  kill?: Kill;
}
interface BrowserGroups {
  groups: number[];
  registered: number[];
}
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Leases coordinate cooperating runners. They never replace database or port custody.
function defaultLeaseRoot(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Cooperative leases require a POSIX user identity.');
  return path.join(tmpdir(), `qa-fleet-${uid}`, 'locks');
}

export async function acquireLeases(resources: string[], root = defaultLeaseRoot()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const leases: string[] = [];
  try {
    for (const resource of [...new Set(resources)].sort()) {
      const digest = createHash('sha256').update(resource).digest('hex');
      const directory = path.join(root, digest);
      await mkdir(directory, { mode: 0o700 });
      leases.push(directory);
      await writeFile(
        path.join(directory, 'owner.json'),
        `${JSON.stringify({ resource, pid: process.pid, started: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
    }
  } catch (error) {
    await releaseLeases(leases);
    if (errorCode(error) === 'EEXIST')
      throw new Error(
        'Resource lease already held; inspect its owner before any manual retirement.',
      );
    throw error;
  }
  return leases;
}

export async function releaseLeases(leases: string[]) {
  for (const directory of [...leases].reverse()) await rm(directory, { recursive: true });
}

export async function observePressure(
  platform: string = process.platform,
  workers = 1,
  { execute = executeFile, read = readFile }: Probes = {},
): Promise<PressureObservation> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await execute(
        '/usr/sbin/sysctl',
        ['-n', 'kern.memorystatus_vm_pressure_level'],
        { timeout: 1000, maxBuffer: 1024 },
      );
      const value = Number(stdout.trim());
      if (value === 1 || value === 2)
        return { safe: true, source: 'macOS memorystatus', level: value };
      return {
        safe: false,
        source: 'macOS memorystatus',
        level: value === 4 ? 4 : null,
        reason: value === 4 ? 'critical memory pressure' : 'unknown memory pressure',
      };
    }
    if (platform === 'linux') {
      const text = await read('/proc/meminfo', 'utf8');
      const match = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
      const availableMiB = match ? Number(match[1]) / 1024 : null;
      const requiredMiB = workers * 512 + 256;
      return {
        safe: Number.isFinite(availableMiB) && availableMiB !== null && availableMiB >= requiredMiB,
        source: 'Linux MemAvailable floor',
        availableMiB,
        requiredMiB,
        reason: 'unknown or insufficient available memory',
      };
    }
    return { safe: false, source: platform, reason: 'unsupported pressure observation' };
  } catch (error) {
    return {
      safe: false,
      source: platform,
      reason: 'pressure observation failed',
      code: errorCode(error) ?? null,
    };
  }
}

export function groupPresent(group: number, kill: Kill = process.kill) {
  try {
    kill(-group, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

export async function browserGroups(
  marker: string,
  receiptsFile: string,
  { execute = executeFile, read = readFile, kill = process.kill }: Probes = {},
): Promise<BrowserGroups> {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,pgid=,command='], {
    // Process inspection may be delayed on a busy host; remain bounded and fail closed.
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const processes = stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  let receipts: { marker?: string; pid?: number }[] = [];
  try {
    const text = await read(receiptsFile, 'utf8');
    receipts = text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const registered = new Set(
    receipts
      .filter(
        (receipt): receipt is { marker: string; pid: number } =>
          receipt.marker === marker &&
          Number.isSafeInteger(receipt.pid) &&
          receipt.pid !== undefined &&
          receipt.pid > 1,
      )
      .map((receipt) => receipt.pid),
  );
  const groups = new Set<number>();
  for (const processRow of processes) {
    const group = Number(processRow[2]);
    if (processRow[3].split(/\s+/).includes(`--qa-fleet-custody=${marker}`)) {
      const leader = processes.find((row) => Number(row[1]) === group);
      if (!leader?.[3].split(/\s+/).includes(`--qa-fleet-custody=${marker}`))
        throw new Error('Marked browser group ownership is unconfirmed.');
      groups.add(group);
      registered.add(group);
    }
  }
  for (const pid of registered) {
    const row = processes.find((processRow) => Number(processRow[1]) === pid);
    if (
      row &&
      (Number(row[2]) !== pid || !row[3].split(/\s+/).includes(`--qa-fleet-custody=${marker}`))
    )
      throw new Error('Registered browser process group ownership changed.');
    if (groupPresent(pid, kill)) {
      if (!row)
        throw new Error(
          'Registered browser leader is absent but group is still present; custody unresolved.',
        );
      groups.add(pid);
    }
  }
  return { groups: [...groups], registered: [...registered] };
}

export async function retireBrowsers(
  marker: string,
  receiptsFile: string,
  {
    inspect = browserGroups,
    kill = process.kill,
    graceMilliseconds = 3000,
  }: { inspect?: typeof browserGroups; kill?: Kill; graceMilliseconds?: number } = {},
): Promise<BrowserCleanup> {
  try {
    const before = await inspect(marker, receiptsFile);
    const retirements: NonNullable<BrowserCleanup['retirements']> = before.groups.map((pid) => ({
      pid,
      signals: [],
      childReaped: null,
    }));
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const receipt of retirements) {
        if (groupPresent(receipt.pid, kill)) {
          const current = await inspect(marker, receiptsFile);
          if (!current.groups.includes(receipt.pid))
            throw new Error('Browser marker ownership no longer confirmed; no signal sent.');
          kill(-receipt.pid, signal);
          receipt.signals.push(signal);
        }
      }
      const deadline = performance.now() + graceMilliseconds;
      while (
        performance.now() < deadline &&
        retirements.some((receipt) => groupPresent(receipt.pid, kill))
      )
        await pause(25);
    }
    for (const receipt of retirements) {
      receipt.groupAbsent = !groupPresent(receipt.pid, kill);
      receipt.complete = receipt.groupAbsent;
    }
    const after = await inspect(marker, receiptsFile);
    return {
      complete: after.groups.length === 0 && retirements.every((receipt) => receipt.complete),
      registered: before.registered,
      remainingGroups: after.groups,
      retirements,
    };
  } catch (error) {
    return { complete: false, reason: errorMessage(error) };
  }
}

// A signal being sent is not proof of cleanup. Require child reap and whole-group absence.
export async function retireGroup(
  child: { pid: number },
  completion: Promise<unknown>,
  {
    graceMilliseconds = 3000,
    kill = process.kill,
  }: { graceMilliseconds?: number; kill?: Kill } = {},
): Promise<GroupCleanup> {
  let reaped = false;
  completion.then(() => {
    reaped = true;
  });
  const signals: NodeJS.Signals[] = [];
  const probeErrors: { phase: string; code: string }[] = [];
  let error: string | null = null;
  let present: boolean | null = null;

  // Retry only a read-only permission uncertainty, within the existing phase budget.
  // Unknown presence never authorizes a signal or escalation.
  const observe = async (phase: string, deadline: number): Promise<boolean | null> => {
    while (true) {
      try {
        present = groupPresent(child.pid, kill);
        return present;
      } catch (failure) {
        present = null;
        error = errorCode(failure) ?? errorMessage(failure);
        probeErrors.push({ phase, code: error });
        if (error !== 'EPERM' || performance.now() >= deadline) return null;
        await pause(Math.min(25, Math.max(0, deadline - performance.now())));
        if (performance.now() >= deadline) return null;
      }
    }
  };

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const deadline = performance.now() + graceMilliseconds;
    const before = await observe(`before ${signal}`, deadline);
    if (before === null) break;
    if (before) {
      try {
        kill(-child.pid, signal);
        signals.push(signal);
      } catch (failure) {
        // An actual signal permission failure is never retried or escalated.
        error = errorCode(failure) ?? errorMessage(failure);
        break;
      }
    }
    while (performance.now() < deadline) {
      const current = await observe(`after ${signal}`, deadline);
      if (current === null) break;
      if (reaped && !current)
        return { complete: true, childReaped: true, groupAbsent: true, signals, probeErrors };
      await pause(Math.min(25, Math.max(0, deadline - performance.now())));
    }
    if (present === null) break;
  }
  const groupAbsent = present === false;
  return {
    complete: reaped && groupAbsent,
    childReaped: reaped,
    groupAbsent,
    signals,
    error,
    probeErrors,
  };
}
