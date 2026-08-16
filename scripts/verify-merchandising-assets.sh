#!/usr/bin/env bash
# Asset regression gate. Image2 concept/runtime asset delivery is Deferred by
# AMD-CMI-012; this gate runs existing real catalog asset E2E and says so.
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="${NODE20_BIN:-/root/.nvm/versions/node/v20.19.5/bin}:$PATH"
[[ "$(node --version)" == 'v20.19.5' ]] || { printf '[merch-assets] BLOCKED: Node 20.19.5 required (got %s)\n' "$(node --version)" >&2; exit 2; }
[[ "$(npm --version)" == 10.* ]] || { printf '[merch-assets] BLOCKED: npm 10 required (got %s)\n' "$(npm --version)" >&2; exit 2; }
[[ -x "$ROOT/node_modules/.bin/playwright" ]] || { printf '%s\n' '[merch-assets] BLOCKED: Playwright unavailable' >&2; exit 2; }

files=()
for file in e2e/product-gallery-interactions.spec.ts; do
  [[ -f "$ROOT/$file" ]] && files+=("$file")
done
(( ${#files[@]} > 0 )) || { printf '%s\n' '[merch-assets] BLOCKED: no existing catalog asset E2E' >&2; exit 2; }

printf '%s\n' '[merch-assets] Image2 concept/runtime asset card is Deferred; running catalog asset regression only.'
printf '[merch-assets] isolated command: CATALOG_OPS_PLAYWRIGHT_CONFIG=playwright.catalog-assets.config.ts bash scripts/verify-catalog-ops-e2e.sh %s\n' "${files[*]}"
set +e
CATALOG_OPS_PLAYWRIGHT_CONFIG='playwright.catalog-assets.config.ts' \
  bash "$ROOT/scripts/verify-catalog-ops-e2e.sh" "${files[@]}"
rc=$?
set -e
(( rc == 0 )) || { printf '[merch-assets] FAIL: isolated catalog asset E2E exited %d\n' "$rc" >&2; exit "$rc"; }
printf '%s\n' '[merch-assets] PASS: asset regression green; Deferred Image2 scope remains disclosed.'
