#!/usr/bin/env bash
# Full Merchandising Gate: ranking, points, asset regression, runtime/build.
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="${NODE20_BIN:-/root/.nvm/versions/node/v20.19.5/bin}:$PATH"
fail() { printf '[merch] FAIL: %s\n' "$*" >&2; exit 1; }
[[ "$(node --version)" == 'v20.19.5' ]] || fail "Node 20.19.5 required (got $(node --version))"
[[ "$(npm --version)" == 10.* ]] || fail "npm 10 required (got $(npm --version))"
git diff --check || fail 'git diff --check failed'

bash "$ROOT/scripts/verify-merchandising-ranking.sh"
bash "$ROOT/scripts/verify-merchandising-points.sh"
bash "$ROOT/scripts/verify-merchandising-assets.sh"

npm run check:runtime >/tmp/monexus-merch-runtime.log 2>&1 || fail 'root runtime check failed (raw log suppressed)'
npm run build >/tmp/monexus-merch-build.log 2>&1 || fail 'root build failed (raw log suppressed)'
(cd "$ROOT/server" && npm run check:runtime >/tmp/monexus-merch-server-runtime.log 2>&1) || fail 'server runtime check failed (raw log suppressed)'
(cd "$ROOT/server" && npm run build >/tmp/monexus-merch-server-build.log 2>&1) || fail 'server build failed (raw log suppressed)'
rm -f /tmp/monexus-merch-runtime.log /tmp/monexus-merch-build.log /tmp/monexus-merch-server-runtime.log /tmp/monexus-merch-server-build.log
printf '%s\n' '[merch] PASS: all merchandising gates green; DB/tmp cleanup delegated to child gates.'
