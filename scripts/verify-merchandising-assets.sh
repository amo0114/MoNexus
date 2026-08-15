#!/usr/bin/env bash
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
files=(); for f in e2e/product-gallery-interactions.spec.ts e2e/merchant-inventory.spec.ts; do [[ -f "$f" ]] && files+=("$f"); done
(( ${#files[@]} > 0 )) || { printf '%s\n' '[merch-assets] BLOCKED: no existing catalog asset E2E; Deferred is not PASS' >&2; exit 2; }
[[ -x node_modules/.bin/playwright ]] || { printf '%s\n' '[merch-assets] BLOCKED: Playwright unavailable' >&2; exit 2; }
printf '[merch-assets] command: playwright test %s\n' "${files[*]}"
set +e
npx playwright test "${files[@]}"
rc=$?
set -e
((rc==0)) || { printf '[merch-assets] FAIL: playwright exit %d\n' "$rc" >&2; exit "$rc"; }
