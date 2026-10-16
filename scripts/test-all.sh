#!/usr/bin/env bash
# Full check: static, unit, build, install and browser replays. There is no CI; run this before merging.
set -euo pipefail
cd "$(dirname "$0")/.."
required=$(cat .bun-version)
command -v bun >/dev/null || { echo "Install Bun $required and put it on PATH." >&2; exit 1; }
[[ "$(bun --version)" == "$required" ]] || { echo "Requires Bun $required." >&2; exit 1; }
# Integration scripts refuse existing directories, so give them fresh ones outside the checkout.
scratch=$(mktemp -d "${TMPDIR:-/tmp}/qa-fleet-check.XXXXXXXX")
echo "Integration output: $scratch"
export CI=true
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run lint
bun test ./test
bun run build
bun run test:install
bun --no-env-file --no-install --config=./bunfig.toml bin/qa-fleet.ts run --config playwright.config.ts --target specs/replay.spec.ts --project chromium --checkout . --timeout 60 --workers 2
./dist/qa-fleet run --config dist/playwright.config.ts --target dist/specs/replay.spec.ts --project chromium --checkout dist --timeout 60 --workers 2
bun --no-env-file scripts/verification-replay.ts "$scratch/verification" --direct
bun --no-env-file scripts/compiled-replay.ts "$scratch/compiled"
echo 'All checks passed.'
