import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { WorkspaceInputError } from './errors.ts';
import { runtimeDependencyFile, workspaceRuntimeDirectory } from './runtime.ts';

export type SourceScope = { spec: string };

const ignoredDirectories = new Set([
  '.git',
  '.auth',
  '.fleet',
  'node_modules',
  'generated',
  'playwright-report',
  'test-results',
]);
const runtimePackages = new Set(['@playwright/test', 'playwright', 'playwright-core']);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// Use the actual compiler for type-only dependencies. Driving a lexer without
// parser context can stall on regex literals; this subprocess has a hard bound.
async function compilerSources(
  root: string,
  entrypoints: string[],
): Promise<{ files: string[]; appSources?: string[] }> {
  const runtime = workspaceRuntimeDirectory(root);
  const dependencies = await realpath(path.join(root, 'node_modules'));
  const privateDirectory = path.join(root, '.fleet');
  await mkdir(privateDirectory, { recursive: true });
  if ((await lstat(privateDirectory)).isSymbolicLink())
    throw new WorkspaceInputError('Source inspection directory must not be a symbolic link.');
  const temporary = await mkdtemp(path.join(privateDirectory, 'source-inspection-'));
  const configuration = path.join(temporary, 'tsconfig.json');
  // Preserve workspace path aliases and resolution settings while limiting the
  // compiler roots to this flow. Project-wide include patterns would defeat scope.
  await writeFile(
    configuration,
    JSON.stringify({
      extends: path.join(root, 'tsconfig.json'),
      compilerOptions: { noEmit: true, skipLibCheck: true },
      files: entrypoints.map((file) => path.resolve(root, file)),
      include: [],
      exclude: [],
    }),
    { flag: 'wx' },
  );
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [
        '--no-env-file',
        '--no-install',
        `--config=${path.join(runtime, 'bunfig.toml')}`,
        '--eval',
        `const { API } = await import(${JSON.stringify(runtimeDependencyFile(runtime, 'typescript', 'dist/api/async/api.js'))});
const ast = await import(${JSON.stringify(runtimeDependencyFile(runtime, 'typescript', 'dist/ast/index.js'))});
const api = new API({ cwd: ${JSON.stringify(root)} });
try {
  const snapshot = await api.updateSnapshot({ openProjects: [${JSON.stringify(configuration)}] });
  const project = snapshot.getProject(${JSON.stringify(configuration)});
  if (!project) throw new Error('Missing compiler project');
  const files = await project.program.getSourceFileNames();
  let declared = false;
  const patterns = new Set();
  for (const file of files) {
    if (!file.startsWith(${JSON.stringify(root + path.sep)}) || file.includes('/node_modules/')) continue;
    const source = await project.program.getSourceFile(file);
    for (const statement of source.statements) {
      if (!ast.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ast.isIdentifier(declaration.name) || declaration.name.text !== 'appSources') continue;
        if (!(statement.modifierFlags & ast.ModifierFlags.Export) || !(statement.declarationList.flags & ast.NodeFlags.Const))
          throw new Error('appSources must be an exported const');
        let value = declaration.initializer;
        // The compiler AST represents as-const as a type reference.
        if (value && ast.isAsExpression(value) && value.type.typeName?.text === 'const') value = value.expression;
        if (!value || !ast.isArrayLiteralExpression(value) || value.elements.some(e => !ast.isStringLiteral(e)))
          throw new Error('appSources must be a string-literal array');
        declared = true;
        for (const element of value.elements) patterns.add(element.text);
      }
    }
  }
  console.log(JSON.stringify({ files, ...(declared ? { appSources: [...patterns].sort() } : {}) }));
} finally { await api.close(); }`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BUN_BE_BUN: '1' },
      },
    );
  } catch {
    throw new WorkspaceInputError(
      'Source dependency inspection failed or exceeded 10 seconds. Typecheck the workspace.',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const files: string[] = [];
  const inspected = JSON.parse(output) as { files: string[]; appSources?: string[] };
  for (const filename of inspected.files) {
    const resolved = await realpath(filename);
    if (resolved.startsWith(`${dependencies}${path.sep}`)) continue;
    const runtimeFile = path.relative(await realpath(runtime), resolved);
    if (['fixtures.ts'].includes(runtimeFile)) continue;
    files.push(await containedSource(root, filename));
  }
  return { files, appSources: inspected.appSources };
}

async function containedSource(root: string, file: string): Promise<string> {
  const relative = path.relative(root, path.resolve(root, file));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new WorkspaceInputError('QA source imports must stay inside the workspace.');
  if (
    relative
      .split(path.sep)
      .some((segment) => ignoredDirectories.has(segment) || segment.startsWith('.env'))
  )
    throw new WorkspaceInputError(
      'QA source imports must not include private runtime or authentication files.',
    );
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new WorkspaceInputError('QA source imports must not traverse symbolic links.');
  }
  if (!(await lstat(current)).isFile())
    throw new WorkspaceInputError('QA source imports must resolve to regular files.');
  return relative.split(path.sep).join('/');
}

// A conservative fallback still excludes authentication, local environment values and artifacts.
// It is not a claim to detect arbitrary filesystem/network inputs used by JavaScript.
export async function publicWorkspaceFiles(root: string, directory = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name) || entry.name.startsWith('.env')) continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new WorkspaceInputError('QA source files must not contain symbolic links.');
    if (entry.isDirectory()) files.push(...(await publicWorkspaceFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function importedSources(root: string, entrypoints: string[]) {
  const workspace = await realpath(root);
  const runtime = workspaceRuntimeDirectory(workspace);
  const visited = new Set<string>();
  let fallback = false;
  async function visit(filename: string): Promise<void> {
    const file = await containedSource(workspace, filename);
    if (visited.has(file)) return;
    visited.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const contents = await readFile(path.join(workspace, file), 'utf8');
    // Deliberately broad: comments may cause a conservative fallback, never missed imports.
    if (/\b(?:import|require)\s*\(/.test(contents)) fallback = true;
    const loader = file.endsWith('tsx') ? 'tsx' : file.endsWith('jsx') ? 'jsx' : 'ts';
    const transpiler = new Bun.Transpiler({
      loader,
      treeShaking: false,
      trimUnusedImports: false,
      deadCodeElimination: false,
    });
    let imports: ReturnType<Bun.Transpiler['scanImports']>;
    try {
      imports = transpiler.scanImports(contents);
    } catch {
      throw new WorkspaceInputError(
        'QA source imports could not be parsed. Typecheck the workspace.',
      );
    }
    for (const imported of imports) {
      if (builtins.has(imported.path) || runtimePackages.has(imported.path)) continue;
      if (file === 'fixtures.ts' && imported.path === '@qa-fleet/runtime/fixtures') {
        const fixture = Bun.resolveSync(imported.path, workspace);
        if ((await realpath(fixture)) !== path.join(runtime, 'fixtures.ts'))
          throw new WorkspaceInputError('Workspace fixture must use the pinned Fleet runtime.');
        continue;
      }
      if (!imported.path.startsWith('.') && !path.isAbsolute(imported.path)) {
        fallback = true;
        continue;
      }
      let resolved: string;
      try {
        // Check existing lexical path segments before resolution erases any symlinks.
        let lexical = path.resolve(path.dirname(path.join(workspace, file)), imported.path);
        const relativeImport = path.relative(workspace, lexical);
        if (
          relativeImport === '..' ||
          relativeImport.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeImport)
        )
          throw new WorkspaceInputError('QA source imports must stay inside the workspace.');
        lexical = workspace;
        for (const segment of relativeImport.split(path.sep)) {
          lexical = path.join(lexical, segment);
          const entry = await lstat(lexical).catch(() => null);
          if (entry?.isSymbolicLink())
            throw new WorkspaceInputError('QA source imports must not traverse symbolic links.');
        }
        resolved = Bun.resolveSync(imported.path, path.dirname(path.join(workspace, file)));
      } catch (error) {
        if (error instanceof WorkspaceInputError) throw error;
        throw new WorkspaceInputError('A QA source import is missing. Typecheck the workspace.');
      }
      await visit(resolved);
    }
  }
  for (const entry of entrypoints) await visit(entry);
  const compiled = await compilerSources(workspace, entrypoints);
  for (const file of compiled.files) await visit(file);
  return {
    files: fallback ? await publicWorkspaceFiles(workspace) : [...visited],
    staticFiles: [...visited],
    // Dynamic imports leave the application scope unknown too.
    appSources: fallback ? undefined : compiled.appSources,
    dependencyMode: fallback ? ('workspace-fallback' as const) : ('static-imports' as const),
  };
}
