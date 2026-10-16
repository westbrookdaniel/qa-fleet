# Independent Playwright workspaces

Fleet scaffolds a local repository outside the application checkout. Its core is ordinary exported TypeScript helpers plus ordinary Playwright specs. Use source search to find helpers; a curated catalog is optional. Neither helper reuse nor flow verification requires metadata registration.

## Author and replay

1. `qa-fleet init <new-directory> --app-checkout <application-repo>` creates the repository.
2. Set `FLEET_BASE_URL` to the authorized target. If needed, prepare ignored `.auth/state.json` through the approved login workflow.
3. Import `test` and `expect` from the workspace's `fixtures.ts`. Import helper functions normally and call them directly. Signatures, return values, custom fixtures, loops and branches are TypeScript.
4. Run `bun run typecheck`, then `bun run fleet verify --spec specs/<name>.spec.ts --environment <label> --timeout 120 --workers 1`. Supply `--deployment <id>` for an identified remote deployment.
5. Inspect `test`, `cleanup`, `observedPassing`, `sourcesUnchanged`, `checkpoint` and `checkpointError` separately. `status` summarizes flow evidence; `status --maintenance` identifies flows whose dependencies need replay.

Commands return JSON. `--workspace` defaults only to a current directory with valid `fleet.json`; it never searches parent directories. Metadata-only commands with an explicit workspace do not require a running application or installed runtime.

Use `bun run test -- specs/<name>.spec.ts --project chromium` for direct Playwright replay without the controller. This runs the same assertions and owned browser fixture but does not produce Fleet observations or automatic checkpoints. Wholly browser-free tests do not satisfy Fleet's browser custody requirement.

## Shared table helpers

For tables that replace rows during search or pagination, take one DOM snapshot of rendered text per assertion poll. Enumerating row locators and awaiting each cell can leave a reader waiting on a row that has disappeared. Use the same rendered-text normalization for baseline and filtered identities; `textContent` can join adjacent name and email elements differently from `innerText`.

Keep each poll callback non-waiting and put the deadline on the outer assertion. Require a visible, idle table with data rows or its explicit empty state; a URL change or an empty row array alone is insufficient. Assert positive and negative membership in the same snapshot. When retaining a locator for a later action, bind it to a unique observed identity and fail on ambiguity rather than silently targeting the same row number after sorting.

A helper that waits for readiness should return the snapshot it actually observed. Flow-specific assertions still belong in the spec: page labels, sort direction, known fixture membership and restoration establish the requested behavior. Preserve a regression that fails under the original race when hardening a shared helper, then replay the affected real flows.

## Repository layout

| Path | Purpose |
| --- | --- |
| `parts/` | Reusable exported functions with normal TypeScript signatures. |
| `specs/` | Authored tests and their assertions. |
| `fixtures.ts` | Ordinary Playwright fixture reexport; owns browser lifecycle. |
| `catalog/` | Optional curated discovery metadata. |
| `fleet.json` | Workspace identity and relative application checkout. |
| `vendor/qa-fleet-runtime-<version>-<sha256>.tgz` | Exact portable runtime; content identity avoids same-version package-cache collisions. |
| `package.json`, `bun.lock` | Pinned runtime, Playwright and compiler dependencies. |
| `.auth/`, `.env*` | Ignored local authentication/configuration. |
| `.fleet/` | Ignored evidence, pending attempts and browser reports. |

After cloning, install with `bun install --frozen-lockfile --ignore-scripts`, typecheck, and install the pinned Chromium separately. `FLEET_APPLICATION_CHECKOUT` overrides the relative application path locally. The runtime, test CLI and fixtures must resolve the workspace's single pinned Playwright installation.

## Optional catalog

A catalog entry is documentation for an exported function:

```json
{
  "schemaVersion": 1,
  "id": "navigation.open-dashboard",
  "kind": "action",
  "summary": "Open the dashboard and wait for its heading.",
  "module": "parts/navigation.ts",
  "exportName": "openDashboard",
  "inputs": { "page": "Playwright Page" },
  "effects": ["Navigates the existing browser page."],
  "examples": ["await openDashboard(page)"]
}
```

`kind` is `fixture`, `action`, `assertion` or `flow`. `inputs` documents the actual signature; it is not runtime argument validation. `effects` makes navigation, writes or cleanup visible to a reader. Metadata does not prove authorization, runtime state, execution or correctness. Source remains authoritative.

`catalog search --query <words>` matches every word against identifier, kind or summary and ranks metadata. Default output is ten matches; `--limit` accepts 1–100 and `--offset` follows `nextOffset`. `catalogRevision` identifies the snapshot. `catalog show --id <id>` accepts up to 100 distinct repeated IDs. `catalog add --file <metadata.json>` validates metadata and contained source paths without executing source. Identical registration is idempotent; conflicting IDs never overwrite an entry.

Publication writes a complete temporary file then links it exclusively into the catalog. Interrupted temporary files do not become visible entries. This is atomic publication of one entry, not a transaction across several registrations.

## Flow evidence and dependencies

Passing verification requires an actual nonempty, complete test inventory, one expected passing result per selected test, no retries/skips/expected failures, owned browser cleanup and stable QA/application source during execution. The reporter cross-checks the normal Playwright report; test names or step labels alone are not proof.

Evidence applies to a **flow**, target origin, environment, deployment and hashed target parameters. A static import is a dependency, including helpers from untaken branches. Fleet makes no claim that every dependency executed or passed independently. Assertions establish behavior only to the extent they actually test it.

Snapshots include the spec, transitive local imports, type-only dependencies, scaffold configuration and runtime. An unrelated helper addition does not invalidate a statically scoped flow; changing an imported helper does. Newly shadowing imports are resolved again so maintenance can identify dependency changes. Runtime identity includes Bun version and pinned package/source content.

Dynamic imports, `require` or unknown package imports trigger conservative workspace scope. Such flows may execute, but automatic checkpointing reports `SOURCE_DEPENDENCIES_NOT_STATIC` rather than silently omitting uncertain dependencies. Compiler inspection has a ten-second bound. These hashes do not capture arbitrary filesystem/network inputs or prove that an application server runs the checked-out revision.

`status --maintenance` reports affected flows and changed/missing/added/removed dependencies. It never executes or repairs tests. Historical records remain evidence of their original run; a runtime change requires fresh verification. A later failure, incomplete cleanup or unfinished attempt must be considered alongside older passing evidence.

Before browser dispatch, verification durably records a pending attempt. Completed evidence is published atomically under the same identity; a matching completed record suppresses a leftover pending receipt. Interruption before final publication remains visible as an unfinished attempt. It establishes neither a test failure nor successful cleanup and grants no process-retirement authority.

## Checkpoints and privacy

A successful eligible verification creates a local Git checkpoint of the immutable source bytes used by the flow. It preserves unrelated staged files and advances HEAD only if no concurrent commit won the race. A checkpoint failure is separate from passing browser evidence. Nothing is pushed.

Authentication, environment files and runtime reports stay ignored. Source inspection rejects escaped imports and symbolic-link paths; checkpointing uses an explicit allowlist and refuses uncertain dependencies. Trace-off does not redact reports. Avoid sensitive test titles and attachments, and review artifacts before sharing.

Cooperative locks and owned process cleanup prevent overlapping Fleet resources from being mistaken for safe concurrency. They do not isolate external services, authorize app writes or restore application data. Keep domain cleanup in fixtures.

## Execution and cleanup

`verify` supplies workspace evidence and checkpoints. Use `run` when an existing ordinary spec needs explicit project, trace, output, or shared-resource controls:

```sh
qa-fleet run --config playwright.config.ts --target specs/replay.spec.ts \
  --project chromium --checkout . --timeout 30 --workers 2
```

Specs use Fleet's browser fixture for process custody. The runner selects the exact file and project, disables retries and dependency projects, and rejects `test.only`. Timeout is 1–900 seconds; workers are 1–4. `qa-fleet --help` lists trace, timing, output, and resource-lock options. `--quiet` captures Playwright output privately and leaves one JSON result on stdout.

Reports live under `.qa-fleet-results/run-*`, or ignored `.fleet/runs/run-*` for verification. Scaffold traces, screenshots, and videos start off. Trace-off does not redact assertion errors or reports; inspect target-specific artifacts before sharing. Completed test statuses and global error counts are saved incrementally in the private verification report. An interrupted report remains incomplete and cannot certify a pass or create a passing checkpoint.

Timeout, cancellation, or unsafe memory pressure retires owned CLI/browser process groups. Cleanup requires CLI reap and actual group absence. Unresolved ownership retains cooperative leases for investigation. TERM/KILL grace and inspection are bounded, although OS descheduling can extend wall time.

A sandbox can deny the host pressure or process APIs before browser launch. Preserve that attempt as not run, then use the authorized host execution path with the same limits when available. Carry that environment requirement into subsequent runs; keep the pressure and cleanup guards enabled.

Memory checks detect distress; they are not CPU/RSS limits. Checkout leases are automatic. Optional `db:<identity>` and `port:<identity>` locks coordinate Fleet runners, not external services or database rows. Process cleanup does not establish data restoration.
