#!/usr/bin/env bash
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail(){ printf '[merch] FAIL: %s\n' "$*" >&2; exit 1; }
[[ "$(node -p 'process.versions.node')" == 20.19.5 ]] || fail 'Node 20.19.5 required'; [[ "$(npm --version)" == 10.* ]] || fail 'npm 10 required'
printf '[merch] runtime gate: node %s npm %s\n' "$(node --version)" "$(npm --version)"
git diff --check || fail 'whitespace errors'
bash scripts/verify-merchandising-ranking.sh
bash scripts/verify-merchandising-points.sh
bash scripts/verify-merchandising-assets.sh
if [[ "${MERCH_SKIP_BUILD:-false}" != true ]]; then npm run build; fi
printf '%s\n' '[merch] PASS: all gates'
