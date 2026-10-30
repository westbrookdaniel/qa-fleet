import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceInputError } from './errors.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function git(root: string, args: string[]): string[] {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}
export function matchesAppSource(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(file));
}
export function validateAppSources(patterns: string[]): void {
  for (const pattern of patterns) {
    if (
      !pattern ||
      path.isAbsolute(pattern) ||
      pattern.includes('\\') ||
      pattern.includes('\0') ||
      pattern
        .split('/')
        .some(
          (segment) =>
            ['..', '.', '.git', '.auth', 'node_modules'].includes(segment) ||
            segment.startsWith('.env'),
        ) ||
      pattern.startsWith('!')
    )
      throw new WorkspaceInputError(
        'appSources must contain public checkout-relative glob patterns.',
      );
  }
}
export async function applicationSources(root: string, patterns: string[]) {
  validateAppSources(patterns);
  const files: Record<string, string> = {};
  const checkout = await realpath(root);
  const candidates = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  for (const file of [...new Set(candidates)].sort()) {
    if (!matchesAppSource(file, patterns)) continue;
    const full = path.join(checkout, file);
    const stat = await lstat(full).catch(() => null);
    if (!stat) continue;
    const resolved = await realpath(full);
    if (!stat.isFile() || resolved !== full)
      throw new WorkspaceInputError(
        'Declared application sources must be regular files without symlinks.',
      );
    files[file] = hash(await readFile(full));
  }
  return { patterns, files, hash: hash(JSON.stringify(files)) };
}
export function applicationDiff(root: string, base: string) {
  const mergeBase = execFileSync('git', ['-C', root, 'merge-base', '--', base, 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const changedFiles = [
    ...new Set([
      ...git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase, '--']),
      ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]),
  ].sort();
  return { base, mergeBase, changedFiles };
}
