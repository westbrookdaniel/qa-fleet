import { homedir } from 'node:os';
import path from 'node:path';
import { installLocal } from '../lib/local-install.ts';

const root = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
let prefix = path.join(homedir(), '.local');
let skillDirectory = path.join(
  process.env.CODEX_HOME || path.join(homedir(), '.codex'),
  'skills/qa-fleet',
);

try {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') {
      console.log(`Usage: bun run install:local [--prefix DIRECTORY] [--skill-dir DIRECTORY]

Build first with bun run build. Installs the complete dist/ runtime to
PREFIX/share/qa-fleet/runtime and links PREFIX/bin/qa-fleet. PREFIX defaults to ~/.local.
Copies skills/qa-fleet to --skill-dir, defaulting to $CODEX_HOME/skills/qa-fleet
(~/.codex/skills/qa-fleet when CODEX_HOME is unset).

Reruns replace only installer-owned runtime/skill targets. Other data in
PREFIX/share/qa-fleet remain outside the replaceable runtime directory. Previous
runtime and skill trees are retained at the recovery paths printed after each update.
Chromium installation is separate. Shell startup files are never changed.`);
      process.exit(0);
    }
    if (argument !== '--prefix' && argument !== '--skill-dir') {
      throw new Error(`Unknown installer argument: ${argument}`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing directory for ${argument}`);
    if (argument === '--prefix') prefix = path.resolve(value);
    else skillDirectory = path.resolve(value);
  }

  const installed = await installLocal({
    runtimeSource: path.join(root, 'dist'),
    skillSource: path.join(root, 'skills/qa-fleet'),
    prefix,
    skillDirectory,
  });
  console.log(`Installed runtime: ${installed.runtimeDirectory}`);
  console.log(`Installed command: ${installed.launcher}`);
  console.log(`Installed skill: ${installed.skillDirectory}`);
  for (const recovery of installed.recoveryDirectories) {
    console.log(`Retained previous installation: ${recovery}`);
  }
  const binDirectory = path.dirname(installed.launcher);
  if (!(process.env.PATH ?? '').split(path.delimiter).includes(binDirectory)) {
    const quotedDirectory = `'${binDirectory.replaceAll("'", "'\\''")}'`;
    console.log(`Add the command to this shell: export PATH=${quotedDirectory}:"$PATH"`);
  }
  console.log('Run qa-fleet --help. Install Playwright Chromium separately before browser replay.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
