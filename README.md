# QA Fleet

**Stop throwing away your agent's browser QA.**

Every time a coding agent checks a feature in the browser, it rediscovers the same login, the same navigation, the same "wait for the table to load" trick, then the transcript scrolls away. Next time, it starts from zero.

QA Fleet keeps that work. Each check becomes an ordinary Playwright spec built from shared TypeScript helpers, saved in a local QA repo next to your app. The next agent (or you) finds the helpers, reuses them, and replays the flow in seconds. When a shared helper changes, Fleet tells you exactly which flows to re-run.

```text
you / Claude / Codex ──► writes specs/*.spec.ts using parts/*.ts
                              │
                    qa-fleet verify ──► bounded run, owned browser, JSON verdict
                              │
                    passing flow ──► local Git checkpoint of the exact sources used
                              │
          edit a helper later ──► qa-fleet status --maintenance ──► "these 4 flows need replay"
```

## Why it's different

- **Just Playwright.** No DSL, no recipe format, no runtime magic. Specs run directly with `playwright test`. If you stop using Fleet, you keep a normal test suite.
- **No model inside.** The CLI is deterministic. Your agent decides what to test and interprets results; Fleet runs it safely and records what happened.
- **Knows what's stale.** Each passing flow is recorded against a hash of its spec, every helper it imports, its config and the runtime. Change one helper and `status --maintenance` lists only the affected flows.
- **Separate, explicit results.** Test verdict, browser cleanup, "sources unchanged during the run" and checkpoint are reported separately. A green test with a failed cleanup is not a clean pass.
- **Safe to run on your laptop.** Hard timeouts, worker limits, refusal under memory pressure, and owned browser process groups that are always torn down. No orphaned Chromium.
- **Stays local.** The QA workspace is its own Git repo outside your app checkout. Fleet configures no remote and pushes nothing.

## Install

Requires Git and **Bun 1.4.0** on macOS or Linux.

```sh
git clone https://github.com/westbrookdaniel/qa-fleet.git && cd qa-fleet
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run install:local                                   # Codex: ~/.codex/skills/qa-fleet
bun run install:local --skill-dir ~/.claude/skills/qa-fleet   # or Claude Code
export PATH="$HOME/.local/bin:$PATH"
qa-fleet --help
```

This installs the CLI to `~/.local` (change with `--prefix`) plus the [companion skill](skills/qa-fleet/SKILL.md) that teaches your agent the workflow. Re-running updates in place and keeps the previous version as a recovery copy.

## Quick start

Create a QA workspace for your app (outside the app checkout):

```sh
qa-fleet init ../my-app-qa --app-checkout /path/to/my-app
cd ../my-app-qa
bun --no-env-file --no-install node_modules/@playwright/test/cli.js install chromium
export FLEET_BASE_URL='http://localhost:3000'
```

Fleet doesn't start your app or touch its branches. If login is needed, save a Playwright storage state to the ignored `.auth/state.json`.

Then either ask your agent:

> Use $qa-fleet in `../my-app-qa` to check that a project opens from the project list. Reuse existing helpers, make no data changes, leave a replayable spec, and report the verdict, cleanup and checkpoint separately.

…or write a flow yourself:

```ts
// parts/dashboard.ts — reusable helper
import { expect, type Page } from '@playwright/test';

export async function openDashboard(page: Page) {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}
```

```ts
// specs/dashboard.spec.ts — the acceptance check
import { test, expect } from '../fixtures.ts';
import { openDashboard } from '../parts/dashboard.ts';

test('dashboard links to projects', async ({ page }) => {
  await openDashboard(page);
  await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
});
```

Run it:

```sh
bun run typecheck
bun run fleet verify --spec specs/dashboard.spec.ts --environment local --timeout 120 --workers 1
```

## The daily loop

| Command | What it does |
| --- | --- |
| `bun run fleet verify --spec <file> ...` | Run one flow under Fleet; save evidence in `.fleet/` and checkpoint on pass. |
| `bun run fleet status` | Latest result for every flow. |
| `bun run fleet status --maintenance` | Flows whose spec, helpers, config or runtime changed since they last passed. |
| `bun run fleet catalog search --query <words>` | Optional metadata search once `parts/` gets big. |
| `bun run test -- <file> --project chromium` | Plain Playwright replay, without Fleet evidence or checkpoints. |

Workspaces vendor their exact runtime and lockfile, so a clone only needs `bun install --frozen-lockfile --ignore-scripts` and Chromium.

**Scope.** Fleet is built for supervised, explicitly scoped QA with one worker. It's not an unattended QA bot. Browser cleanup does not mean app data was restored, so put domain cleanup in fixtures for write flows.

More detail: [workspaces, catalog, evidence and execution limits](docs/WORKSPACES.md).

## Develop

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck && bun run lint && bun test ./test   # fast
bun run test:all                                       # full suite incl. browser replays (needs Chromium)
```

There is no CI: run `bun run test:all` before merging. See [validation](docs/VALIDATION.md) for what each check covers. Builds are host-specific; distribute the whole `dist/` directory.

## License

[MIT](LICENSE)
