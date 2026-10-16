# Validation

`bun run test:all` runs the full suite locally; there is no CI, so run it before merging. All browser checks use disposable synthetic pages with external requests blocked; nothing touches a real application or auth state.

| Check | What it covers |
| --- | --- |
| `bun run typecheck`, `bun run lint` | Strict TypeScript, Biome lint and format. |
| `bun test ./test` | Custody, cancellation, traces, selection, timing, evidence, catalog, maintenance and install regressions. |
| `bun run build` | Host-compiled CLI with Playwright sidecars and the portable workspace runtime archive. |
| `bun run test:install` | Disposable local install, skill copy, relocated CLI, suite collection from outside the checkout. |
| Runner replay | `specs/replay.spec.ts` through the source and compiled runner: exact selection, two workers, no retries, 60s deadline. |
| `scripts/verification-replay.ts <dir> --direct` | Ordinary helper verification (fixtures, return values, loops, nested steps, branches, checkpoints, direct replay) and rejected-observation controls: skips, expected failures, retries, wrong assertions, mutated or deleted source, and overridden browser custody must never produce a passing observation or checkpoint. |
| `scripts/compiled-replay.ts <dir>` | A workspace created by the compiled CLI, moved to a new path, cloned, freshly installed from its lockfile, typechecked and verified again. |

The integration scripts each need a fresh absolute directory whose parent exists; they refuse an existing one and write `summary.json` with `completed: true` only when every assertion held. Expected-failure controls pass when Fleet correctly refuses them.

For changes to cancellation, protected traces or executable packaging, also check by hand: real cancellation mid-run, auth success/failure artifact audits, compiled replay after moving `dist/`, JavaScript spec/config selection, and refusal of ambient `.env`/Bun config.

Results hold for the pinned Bun, Playwright and Chromium versions on the platform that ran them. Builds are host-specific.
