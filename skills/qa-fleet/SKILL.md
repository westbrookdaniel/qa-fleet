---
name: qa-fleet
description: Build, reuse, replay, and diagnose browser QA flows in a QA Fleet workspace using ordinary Playwright specs and TypeScript helpers.
---

# QA Fleet

Turn a scoped browser check into an executable flow that another agent or developer can inspect and replay. Fleet is a model-free CLI; the caller chooses the behavior, authors the assertions, and interprets the evidence.

## Establish the target

Use the user's requested behavior, application checkout, target URL or deployment, account, and allowed effects as the run contract. Carry forward any action budget or exclusions. Resolve missing details that affect the run before browser dispatch; an existing helper or signed-in session does not expand the request.

Find the intended QA workspace and read its setup notes, `fleet.json`, `package.json`, and Playwright configuration. A workspace is a separate local Git repository outside the application checkout. Check the current application branch and running target rather than assuming the configured checkout is what the server runs.

For a new workspace, inspect `qa-fleet init --help`, then use `qa-fleet init <new-directory> --app-checkout <application-repo>`. The parent directory must exist. Prepare the target services, browser installation, and authentication through the available authorized workflow. Keep local auth in the workspace's ignored `.auth/` directory.

## Reuse and author

Search `specs/` and `parts/` for the requested behavior, then read the relevant source and its callers. If a curated `catalog/` exists, bounded `catalog search` and `catalog show` can narrow discovery; source is authoritative and metadata is optional.

Write ordinary Playwright tests under `specs/`. Import `test` and `expect` from the workspace's `fixtures.ts` so Fleet can account for browser ownership. Import exported TypeScript helpers from `parts/` directly, with normal arguments and return values. Extract a helper when it captures useful behavior shared by flows; keep flow-specific acceptance assertions in the spec.

Assert the requested outcome using observed UI and suitable existing data. After navigation, wait for destination content or controls to become visible, then for tables to finish loading before reading rows. A missing busy attribute by itself does not establish readiness. For slow applications, raise the timeouts in the workspace's `playwright.config.ts` rather than per assertion. A changed URL alone does not establish that the destination is usable. For requested write flows, make domain cleanup explicit in fixtures and preserve the user's mutation budget.

Preserve a valid flow's source when a run is blocked by the target or data. If repairing a flow, retain its acceptance behavior and useful assertions; a different route or weaker assertion can hide the original failure.

## Verify and diagnose

Use the workspace's installed command contract; `bun run fleet --help` exposes its CLI. A typical bounded run is:

```sh
bun run typecheck
bun run fleet verify --spec specs/example.spec.ts \
  --environment local --timeout 120 --workers 1
bun run fleet status
```

Give a shell verification call up to 30 seconds before yielding. If it is still running, use a similarly bounded wait instead of repeated one-second polls; every model-mediated poll can resend substantial context.

Set the configured target inputs before running. Use an accurate environment label and `--deployment <id>` when a remote deployment is identified. Choose the timeout and workers for the authorized run. `status --maintenance` reports flows affected by source changes without executing them.

Read the verification result and relevant browser evidence before changing code. Separate:

- **Application behavior:** the same user action fails in a normal signed-in browser on the same target and data.
- **Harness behavior:** locator, timing, setup, fixture, or runner behavior prevents the intended interaction or observation.
- **Environment or data:** target availability, authentication, permissions, or required records prevent the acceptance case from running.

When the cause is uncertain and a normal browser route is available within scope, reproduce the same interaction there. Treat a harness-only failure as unresolved until evidence distinguishes it. Direct Playwright replay is also available through `bun run test -- specs/example.spec.ts --project chromium`; it runs the source without Fleet observations or automatic checkpoints. Choose another execution only when it resolves a specific question within the remaining action budget.

## Report what the run proves

Report the flow, target, observed assertions, and evidence location. Keep the test verdict, owned-process cleanup, application-data cleanup, and local Git checkpoint outcome separate. Inspect `test`, `cleanup`, `observedPassing`, `sourcesUnchanged`, `checkpoint`, and `checkpointError`; an unfinished attempt establishes neither a passing flow nor successful cleanup.

Passing evidence belongs to the executed flow and its recorded environment and source. An imported helper is a dependency, not independent proof that the helper ran or passed. A local checkpoint preserves source and does not establish deployment, CI, or release.

Leave a usable spec and helper source with a precise passing, failing, blocked, or unrun status. Include the remaining recovery step when needed. Fleet checkpoints are local; sharing or pushing the workspace is a separate action.

## Caller integration

Declare `export const appSources = ['src/components/feature/**'] as const` in
specs or transitive imported parts to scope application maintenance. Fleet reads
literal arrays with the compiler AST and never executes helper metadata.
Undeclared flows retain whole-checkout invalidation. Use
`status --maintenance --app-base origin/main` to select kept flows intersecting
the application diff even before evidence exists; `undeclared` means unknown.
`FLEET_APPLICATION_CHECKOUT` can point this selector at a worktree.

Pass a caller-produced doctor receipt with `verify --target-identity <json-file>`.
Fleet records the JSON verbatim and its hash; status displays it. The receipt
is caller-asserted, not independent proof Fleet checked the running stack.
