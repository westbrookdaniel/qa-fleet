import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WorkspaceInputError } from './errors.ts';

export interface PartContract {
  schemaVersion: 1;
  id: string;
  kind: 'fixture' | 'action' | 'assertion' | 'flow';
  summary: string;
  module: string;
  exportName: string;
  inputs: Record<string, string>;
  effects: string[];
  examples?: string[];
}

const idPattern = /^[a-z][a-z0-9.-]*$/;
const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const reservedNames = new Set(
  'await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield'.split(
    ' ',
  ),
);
const contractKeys = new Set([
  'schemaVersion',
  'id',
  'kind',
  'summary',
  'module',
  'exportName',
  'inputs',
  'effects',
  'examples',
]);
const maxContractBytes = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 4000 &&
    !value.includes('\0')
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    identifierPattern.test(value) &&
    !reservedNames.has(value)
  );
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && idPattern.test(value);
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256 || !value.every(isText))
    throw new WorkspaceInputError(`Part contract has invalid ${field}.`);
  return value;
}

function parseContract(value: unknown): PartContract {
  if (!isRecord(value) || Object.keys(value).some((key) => !contractKeys.has(key)))
    throw new WorkspaceInputError('Part contract must contain supported metadata fields only.');
  if (value.schemaVersion !== 1)
    throw new WorkspaceInputError('Part contract schemaVersion must be 1.');
  if (!isId(value.id)) throw new WorkspaceInputError('Part contract has an invalid id.');
  if (
    value.kind !== 'fixture' &&
    value.kind !== 'action' &&
    value.kind !== 'assertion' &&
    value.kind !== 'flow'
  )
    throw new WorkspaceInputError('Part contract has an invalid kind.');
  if (!isText(value.summary)) throw new WorkspaceInputError('Part contract needs a summary.');
  if (!isIdentifier(value.exportName))
    throw new WorkspaceInputError('Part contract has an invalid exportName.');
  if (typeof value.module !== 'string')
    throw new WorkspaceInputError('Part contract needs a module path.');
  const segments = value.module.split('/');
  if (
    segments[0] !== 'parts' ||
    segments.length < 2 ||
    !value.module.endsWith('.ts') ||
    value.module.includes('\\') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new WorkspaceInputError('Part module must be a relative parts/ TypeScript path.');
  if (
    !isRecord(value.inputs) ||
    Object.keys(value.inputs).length > 256 ||
    Object.entries(value.inputs).some(
      ([key, description]) => !isIdentifier(key) || !isText(description),
    )
  )
    throw new WorkspaceInputError('Part contract has invalid inputs.');
  return {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    summary: value.summary,
    module: value.module,
    exportName: value.exportName,
    inputs: Object.fromEntries(Object.entries(value.inputs)) as Record<string, string>,
    effects: strings(value.effects, 'effects'),
    ...(value.examples === undefined ? {} : { examples: strings(value.examples, 'examples') }),
  };
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function workspaceRoot(workspace: string): Promise<string> {
  try {
    const root = await realpath(workspace);
    if (!(await stat(root)).isDirectory()) throw new WorkspaceInputError();
    return root;
  } catch {
    throw new WorkspaceInputError('QA workspace must be an existing directory.');
  }
}

async function containedPath(root: string, file: string): Promise<string> {
  let resolved: string;
  try {
    const target = path.join(root, file);
    const directory = await realpath(path.dirname(target));
    resolved = path.join(directory, path.basename(target));
    // Bun/macOS can realpath a regular file to a temporary hard-link name being removed.
    // Resolve explicit symlinks while preserving the published regular file's name.
    if ((await lstat(resolved)).isSymbolicLink()) resolved = await realpath(resolved);
  } catch {
    throw new WorkspaceInputError('Catalogue or part source is missing or inaccessible.');
  }
  if (!isWithin(root, resolved))
    throw new WorkspaceInputError('Catalogue and part sources must stay inside the workspace.');
  return resolved;
}

async function readContract(file: string): Promise<PartContract> {
  let value: unknown;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxContractBytes) throw new WorkspaceInputError();
    const source = await readFile(file, 'utf8');
    if (Buffer.byteLength(source) > maxContractBytes) throw new WorkspaceInputError();
    value = JSON.parse(source);
  } catch {
    throw new WorkspaceInputError(
      'Part metadata must be a readable JSON file no larger than 64 KiB.',
    );
  }
  return parseContract(value);
}

async function validateModule(root: string, contract: PartContract): Promise<void> {
  const source = await containedPath(root, contract.module);
  try {
    if (!(await stat(source)).isFile()) throw new WorkspaceInputError();
  } catch {
    throw new WorkspaceInputError('Part module must be an existing file.');
  }
}

function validateUniqueIds(parts: PartContract[]): void {
  const ids = new Set<string>();
  for (const part of parts) {
    if (ids.has(part.id)) throw new WorkspaceInputError('Catalogue contains duplicate part ids.');
    ids.add(part.id);
  }
}

async function catalogDirectory(root: string): Promise<string | null> {
  try {
    await lstat(path.join(root, 'catalog'));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw new WorkspaceInputError('Catalogue directory is inaccessible.');
  }
  const directory = await containedPath(root, 'catalog');
  try {
    if (!(await stat(directory)).isDirectory()) throw new WorkspaceInputError();
  } catch {
    throw new WorkspaceInputError('Catalogue must be an accessible directory.');
  }
  return directory;
}

export async function readCatalog(workspace: string): Promise<PartContract[]> {
  const root = await workspaceRoot(workspace);
  const directory = await catalogDirectory(root);
  if (!directory) return [];
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    throw new WorkspaceInputError('Catalogue directory is inaccessible.');
  }
  const parts: PartContract[] = [];
  for (const file of files) {
    const contractPath = await containedPath(root, path.join('catalog', file));
    const contract = await readContract(contractPath);
    await validateModule(root, contract);
    parts.push(contract);
  }
  validateUniqueIds(parts);
  return parts.sort((left, right) => left.id.localeCompare(right.id));
}

export async function getParts(workspace: string, ids: string[]): Promise<PartContract[]> {
  if (ids.length < 1 || ids.length > 100 || !ids.every(isId))
    throw new WorkspaceInputError('Show requires 1 to 100 valid part ids.');
  if (new Set(ids).size !== ids.length)
    throw new WorkspaceInputError('Show requires distinct part ids.');
  const parts = new Map((await readCatalog(workspace)).map((part) => [part.id, part]));
  return ids.map((id) => {
    const part = parts.get(id);
    if (!part) throw new WorkspaceInputError('Part was not found in the catalogue.');
    return part;
  });
}

export interface PartSearchOptions {
  query?: string;
  kind?: PartContract['kind'];
  limit?: number;
  offset?: number;
}

function relevance(part: PartContract, query: string, terms: string[]): number {
  const id = part.id.toLowerCase();
  if (query && id === query) return 10_000;
  const summary = part.summary.toLowerCase();
  const idWords = new Set(id.split(/[.-]/));
  const summaryWords = new Set(summary.split(/[^a-z0-9]+/));
  let score = query && summary.includes(query) ? 20 : 0;
  let matchedIdWords = 0;
  for (const term of terms) {
    if (idWords.has(term)) {
      score += 30;
      matchedIdWords += 1;
    } else if (id.includes(term)) score += 10;
    if (summaryWords.has(term)) score += 5;
    if (part.kind === term) score += 3;
  }
  // Prefer identifiers focused on the requested terms over a related, more qualified operation.
  return score + (30 * matchedIdWords) / idWords.size;
}

export async function searchParts(workspace: string, options: PartSearchOptions = {}) {
  const query = options.query ?? '';
  const limit = options.limit ?? 10;
  const offset = options.offset ?? 0;
  if (typeof query !== 'string' || query.length > 4000 || query.includes('\0'))
    throw new WorkspaceInputError('Search query must be at most 4000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new WorkspaceInputError('Search limit must be an integer from 1 to 100.');
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new WorkspaceInputError('Search offset must be a non-negative safe integer.');
  if (
    options.kind !== undefined &&
    !['fixture', 'action', 'assertion', 'flow'].includes(options.kind)
  )
    throw new WorkspaceInputError('Search kind must be fixture, action, assertion, or flow.');
  const normalizedQuery = query.toLowerCase().trim();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const catalog = await readCatalog(workspace);
  const matches = catalog
    .filter((part) => {
      if (options.kind && part.kind !== options.kind) return false;
      const searchable = `${part.id} ${part.kind} ${part.summary}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    })
    .map((part) => ({ part, score: relevance(part, normalizedQuery, terms) }))
    .sort((left, right) => right.score - left.score || left.part.id.localeCompare(right.part.id));
  const items = matches.slice(offset, offset + limit).map(({ part }) => ({
    id: part.id,
    kind: part.kind,
    summary: part.summary,
  }));
  const hasMore = offset + items.length < matches.length;
  return {
    query: normalizedQuery,
    kind: options.kind ?? null,
    catalogRevision: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
    totalMatches: matches.length,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + items.length : null,
    items,
  };
}

export async function addPart(workspace: string, contractFile: string): Promise<PartContract> {
  const root = await workspaceRoot(workspace);
  const contract = await readContract(contractFile);
  await validateModule(root, contract);
  const parts = await readCatalog(root);
  const existing = parts.find((part) => part.id === contract.id);
  if (existing) {
    if (isDeepStrictEqual(existing, contract)) return existing;
    throw new WorkspaceInputError('Catalogue contains duplicate part ids with different metadata.');
  }
  validateUniqueIds([...parts, contract]);
  let directory = await catalogDirectory(root);
  if (!directory) {
    try {
      await mkdir(path.join(root, 'catalog'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new WorkspaceInputError('Catalogue directory could not be created.');
    }
    // A concurrent first registration may create it; validate that winner before use.
    directory = await catalogDirectory(root);
  }
  if (!directory) throw new WorkspaceInputError('Catalogue directory could not be created.');
  const destination = path.join(directory, `${contract.id}.json`);
  const temporary = path.join(directory, `.${contract.id}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(contract, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    // Readers see complete JSON; link also refuses to replace a concurrent winner.
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const saved = await readContract(await containedPath(root, path.relative(root, destination)));
      if (isDeepStrictEqual(saved, contract)) return saved;
      throw new WorkspaceInputError(
        'Catalogue contains duplicate part ids with different metadata.',
      );
    }
    throw new WorkspaceInputError(
      'Part could not be saved; catalogue files are never overwritten.',
    );
  } finally {
    await rm(temporary, { force: true });
  }
  return contract;
}
