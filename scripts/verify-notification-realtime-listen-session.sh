#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 (T-INF-002) — AC-RT-029 / CHK-INF-007 production LISTEN
# session gate wrapper.
#
# Reads a git-ignored production-like env file (xtrace off) and runs the actual-
# role gate (server/scripts/verify-notification-realtime-listen-session.mjs).
# Requires: RT_SESSION_DATABASE_URL, RT_SESSION_ROLE, optional
# RT_SESSION_ENDPOINT_CLASS / RT_SESSION_REVISION / RT_SESSION_ARTIFACT.
#
# Any missing/expired evidence, role mismatch, pid-distinct != 1, missed round
# or permission failure returns non-zero and MUST block enabling realtime.
set -euo pipefail

ENV_FILE="${RT_SESSION_ENV_FILE:-.env.notification-realtime.production-like}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[gate] missing production-like env file: $ENV_FILE" >&2
  exit 1
fi

set +x
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

true

: "${RT_SESSION_DATABASE_URL:?RT_SESSION_DATABASE_URL is required}"
: "${RT_SESSION_ROLE:?RT_SESSION_ROLE is required}"

# Record the evidence artifact/revision + timestamp (redacted) for CHK-INF-007.
revision="${RT_SESSION_REVISION:-$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo unknown)}"
endpoint_class="${RT_SESSION_ENDPOINT_CLASS:-session_pool}"
echo "[gate] artifact_revision=${revision} endpoint_class=${endpoint_class} at $(date -u +%FT%TZ)"

cd "$(dirname "$0")/../server"
export RT_SESSION_ENDPOINT_CLASS="$endpoint_class"
export RT_SESSION_REVISION="$revision"
node scripts/verify-notification-realtime-listen-session.mjs
