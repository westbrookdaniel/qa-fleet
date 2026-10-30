import { parseArgs } from 'node:util';
import { addPart, getParts, type PartContract, searchParts } from './catalog.ts';
import { WorkspaceInputError } from './errors.ts';
import { flowStatus, verifyFlow } from './evidence.ts';
import { maintenanceReport } from './maintenance.ts';
import { initializeWorkspace, readWorkspace } from './workspace.ts';

export const workspaceUsage = `QA workspaces:
  qa-fleet init <directory> --app-checkout <app-repo>
  qa-fleet catalog search [--workspace <directory>] [--query <words>] [--kind fixture|action|assertion|flow] [--limit <1..100>] [--offset <0..>]
  qa-fleet catalog show [--workspace <directory>] --id <helper-id> [--id <another-id> ...]
  qa-fleet catalog add [--workspace <directory>] --file <metadata.json>
  qa-fleet verify [--workspace <directory>] --spec specs/<name>.spec.ts --environment <label> --timeout <1..900> --workers <1..4> [--deployment <id>] [--target-identity <json-file>]
  qa-fleet status [--workspace <directory>] [--maintenance [--app-base <git-ref>] [--limit <1..100>] [--offset <0..>]]

Commands return JSON. FLEET_BASE_URL selects the authorized application target.
--workspace defaults to the current directory only when it contains valid fleet.json.
Write ordinary specs using test and expect from ../fixtures.ts. Import helpers and call
those functions directly. Fixtures, arguments, return values and assertions are TypeScript.
The optional catalog supports bounded metadata discovery; source is authoritative.
Search matches every query word in id/kind/summary. Use nextOffset to continue.
Show accepts up to 100 distinct ids. Registration never executes helper source.
Verification records flow results, source dependencies and a local Git checkpoint.
An imported helper is a dependency, not proof that it executed or passed independently.
Status shows flow evidence and unfinished attempts. --maintenance lists affected flows.
No remote is configured and nothing is pushed. Read docs/WORKSPACES.md for details.
`;

export async function workspaceMain(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      'app-checkout': { type: 'string' },
      query: { type: 'string' },
      id: { type: 'string', multiple: true },
      kind: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      maintenance: { type: 'boolean' },
      'app-base': { type: 'string' },
      'target-identity': { type: 'string' },
      file: { type: 'string' },
      spec: { type: 'string' },
      environment: { type: 'string' },
      deployment: { type: 'string' },
      timeout: { type: 'string' },
      workers: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(workspaceUsage);
    return;
  }
  const command = positionals[0];
  const commandOptions: Record<string, string[]> = {
    init: ['app-checkout'],
    status: ['workspace', 'maintenance', 'limit', 'offset', 'app-base'],
    verify: [
      'workspace',
      'spec',
      'environment',
      'deployment',
      'timeout',
      'workers',
      'target-identity',
    ],
  };
  if (command !== 'catalog') {
    const allowed = commandOptions[command];
    if (!allowed || Object.keys(values).some((option) => !allowed.includes(option)))
      throw new WorkspaceInputError('Invalid options for this workspace command.');
  }
  let result: unknown;
  if (command === 'init') {
    if (positionals.length !== 2 || !values['app-checkout'])
      throw new WorkspaceInputError('Invalid init arguments.');
    result = await initializeWorkspace({
      directory: positionals[1],
      applicationCheckout: values['app-checkout'],
    });
  } else {
    let workspace = values.workspace;
    if (workspace === undefined) {
      try {
        await readWorkspace(process.cwd());
        workspace = process.cwd();
      } catch {
        throw new WorkspaceInputError(
          'Pass --workspace <directory>, or run from a directory containing valid fleet.json.',
        );
      }
    }
    if (!workspace) throw new WorkspaceInputError('--workspace must not be empty.');
    if (command === 'catalog' && positionals.length === 2) {
      const action = positionals[1];
      const allowedOptions: Record<string, string[]> = {
        search: ['workspace', 'query', 'kind', 'limit', 'offset'],
        show: ['workspace', 'id'],
        add: ['workspace', 'file'],
      };
      const allowed = allowedOptions[action];
      if (!allowed || Object.keys(values).some((option) => !allowed.includes(option)))
        throw new WorkspaceInputError('Invalid options for this catalog command.');
      if (action === 'search') {
        const page = await searchParts(workspace, {
          query: values.query,
          kind: values.kind as PartContract['kind'] | undefined,
          limit: values.limit === undefined ? undefined : Number(values.limit),
          offset: values.offset === undefined ? undefined : Number(values.offset),
        });
        result = page;
      } else if (action === 'show' && values.id) {
        const items = (await getParts(workspace, values.id)).map((contract) => ({ contract }));
        result = items.length === 1 ? items[0] : items;
      } else if (action === 'add' && values.file) {
        result = { contract: await addPart(workspace, values.file), status: 'registered' };
      } else throw new WorkspaceInputError('Invalid catalog arguments.');
    } else if (command === 'status' && positionals.length === 1) {
      if (
        !values.maintenance &&
        (values.limit !== undefined ||
          values.offset !== undefined ||
          values['app-base'] !== undefined)
      )
        throw new WorkspaceInputError('Status pagination requires --maintenance.');
      result = values.maintenance
        ? await maintenanceReport(workspace, {
            appBase: values['app-base'],
            limit: values.limit === undefined ? undefined : Number(values.limit),
            offset: values.offset === undefined ? undefined : Number(values.offset),
          })
        : await flowStatus(workspace);
    } else if (
      command === 'verify' &&
      values.spec &&
      values.environment &&
      positionals.length === 1
    ) {
      const timeout = Number(values.timeout);
      const workers = Number(values.workers);
      if (
        !Number.isInteger(timeout) ||
        timeout < 1 ||
        timeout > 900 ||
        !Number.isInteger(workers) ||
        workers < 1 ||
        workers > 4
      )
        throw new WorkspaceInputError('Verify requires explicit bounded timeout and workers.');
      const verified = await verifyFlow({
        workspace,
        spec: values.spec,
        environment: values.environment,
        deployment: values.deployment,
        targetIdentity: values['target-identity'],
        timeout,
        workers,
      });
      process.exitCode = verified.observedPassing && !verified.checkpointError ? 0 : 1;
      result = verified;
    } else throw new WorkspaceInputError('Invalid workspace command.');
  }
  console.log(JSON.stringify(result));
}
