#!/usr/bin/env bash
set -euo pipefail

# verify-quick: 只验证受当前变更影响的测试，小改动不付全量价。
#
# 用法：
#   npm run verify:quick                        # 受影响的后端集成测试 + 前端单测
#   npm run verify:quick -- e2e/foo.spec.ts     # 追加运行指定 e2e spec
#
# 变更范围 = merge-base(HEAD, $VERIFY_BASE) 之后的提交 + 工作区/暂存区 + 未跟踪文件。
# 全量验证（与 CI 等价）仍用 npm run verify:local。分层策略见 docs/testing-policy.md。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/server"

TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public}"
JWT_SECRET="${JWT_SECRET:-local-jwt-secret-at-least-32-characters-long}"
FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:5173}"
API_RATE_LIMIT_MAX="${API_RATE_LIMIT_MAX:-3000}"
REDIS_ENABLED="${REDIS_ENABLED:-false}"
VERIFY_BASE="${VERIFY_BASE:-origin/develop}"

if [[ "$TEST_DATABASE_URL" != *"monexus_test"* && "${ALLOW_NON_TEST_DB:-false}" != "true" ]]; then
  echo "[ERROR] TEST_DATABASE_URL must point at a disposable test database." >&2
  echo "        Current value: $TEST_DATABASE_URL" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "[INFO] Checking local runtime"
npm run check:runtime

E2E_SPECS=()
for arg in "$@"; do
  case "$arg" in
    *.spec.ts) E2E_SPECS+=("$arg") ;;
    *) echo "[WARN] Ignoring unrecognized argument: $arg (expected e2e/*.spec.ts)" ;;
  esac
done

BASE_COMMIT=""
if git rev-parse --verify --quiet "$VERIFY_BASE" >/dev/null; then
  BASE_COMMIT="$(git merge-base HEAD "$VERIFY_BASE" 2>/dev/null || true)"
else
  echo "[WARN] VERIFY_BASE=$VERIFY_BASE not found; only uncommitted changes are considered."
fi

mapfile -t CHANGED < <(
  {
    if [[ -n "$BASE_COMMIT" ]]; then git diff --name-only "$BASE_COMMIT" HEAD; fi
    git diff --name-only
    git diff --name-only --cached
    git ls-files --others --exclude-standard
  } | sort -u
)

SERVER_SRC=()
SERVER_TESTS=()
FRONTEND_SRC=()
FRONTEND_TESTS=()
SCHEMA_CHANGED=false

for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  [[ -f "$f" ]] || continue # 已删除的文件无法喂给 vitest related
  case "$f" in
    server/prisma/*) SCHEMA_CHANGED=true ;;
    server/src/*.test.ts) SERVER_TESTS+=("${f#server/}") ;;
    server/src/*.ts) SERVER_SRC+=("${f#server/}") ;;
    src/*.test.ts|src/*.test.tsx) FRONTEND_TESTS+=("$f") ;;
    src/*.ts|src/*.tsx) FRONTEND_SRC+=("$f") ;;
  esac
done

NEED_DB=false
if [[ "$SCHEMA_CHANGED" == "true" || ${#SERVER_SRC[@]} -gt 0 || ${#SERVER_TESTS[@]} -gt 0 || ${#E2E_SPECS[@]} -gt 0 ]]; then
  NEED_DB=true
fi

if [[ "$NEED_DB" == "true" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "[ERROR] Missing required command: docker" >&2
    exit 1
  fi
  # 复用已在运行的容器（可能由其他 compose 项目实例创建，compose up 会撞名）。
  if docker ps --filter "name=monexus-db" --filter "status=running" --format '{{.Names}}' | grep -qx 'monexus-db'; then
    echo "[INFO] Reusing running PostgreSQL container"
  else
    echo "[INFO] Starting PostgreSQL container"
    docker compose up -d postgres >/dev/null
  fi
  docker exec monexus-db sh -c 'createdb -U "$POSTGRES_USER" monexus_test 2>/dev/null || true' || true
fi

if [[ "$SCHEMA_CHANGED" == "true" ]]; then
  echo "[INFO] Prisma schema/migrations changed: regenerating client and migrating test DB"
  (cd "$BACKEND_DIR" && DATABASE_URL="$TEST_DATABASE_URL" npm run db:generate)
  (cd "$BACKEND_DIR" && DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate:deploy)
  echo "[WARN] Schema changes can affect tests beyond the module graph;"
  echo "       CI runs the full backend suite on your PR, or run verify:local before merging."
fi

RAN_ANYTHING=false

# --changed 覆盖"改动的测试文件"与"经模块图关联的测试"两类;先 list 计数,
# 改动落在中枢模块(如被 app.ts 间接引用)时相关集会膨胀成全量,超过阈值
# 就止损:只跑直接改动的测试文件,全量交给 CI(PR 的 server/** 过滤器必跑)。
VERIFY_QUICK_MAX_FILES="${VERIFY_QUICK_MAX_FILES:-25}"
CHANGED_ARGS=(--changed)
if [[ -n "$BASE_COMMIT" ]]; then
  CHANGED_ARGS=(--changed "$BASE_COMMIT")
fi

if [[ ${#SERVER_SRC[@]} -gt 0 || ${#SERVER_TESTS[@]} -gt 0 ]]; then
  COUNT=$(cd "$BACKEND_DIR" && TEST_DATABASE_URL="$TEST_DATABASE_URL" \
    npx vitest list "${CHANGED_ARGS[@]}" --filesOnly | wc -l)
  if [[ "$COUNT" -eq 0 ]]; then
    echo "[INFO] No backend tests affected by the change set."
  elif [[ "$COUNT" -le "$VERIFY_QUICK_MAX_FILES" ]]; then
    echo "[INFO] Running $COUNT affected backend test file(s)"
    (cd "$BACKEND_DIR" && TEST_DATABASE_URL="$TEST_DATABASE_URL" REDIS_ENABLED="$REDIS_ENABLED" \
      API_RATE_LIMIT_MAX="$API_RATE_LIMIT_MAX" npx vitest run "${CHANGED_ARGS[@]}")
    RAN_ANYTHING=true
  else
    echo "[WARN] Change set affects $COUNT/$(find "$BACKEND_DIR/src" -name '*.test.ts' | wc -l) backend test files (central module touched)."
    echo "       Skipping the local sweep — CI runs the full backend suite on your PR,"
    echo "       or run: npm run verify:local:no-e2e"
    if [[ ${#SERVER_TESTS[@]} -gt 0 ]]; then
      echo "[INFO] Still running ${#SERVER_TESTS[@]} directly changed backend test file(s)"
      (cd "$BACKEND_DIR" && TEST_DATABASE_URL="$TEST_DATABASE_URL" REDIS_ENABLED="$REDIS_ENABLED" \
        API_RATE_LIMIT_MAX="$API_RATE_LIMIT_MAX" npx vitest run "${SERVER_TESTS[@]}")
      RAN_ANYTHING=true
    fi
  fi
fi

if [[ ${#FRONTEND_SRC[@]} -gt 0 || ${#FRONTEND_TESTS[@]} -gt 0 ]]; then
  COUNT=$(npx vitest list "${CHANGED_ARGS[@]}" --filesOnly | wc -l)
  if [[ "$COUNT" -eq 0 ]]; then
    echo "[INFO] No frontend tests affected by the change set."
  else
    echo "[INFO] Running $COUNT affected frontend test file(s)"
    npx vitest run "${CHANGED_ARGS[@]}"
    RAN_ANYTHING=true
  fi
fi

if [[ ${#E2E_SPECS[@]} -gt 0 ]]; then
  echo "[INFO] Resetting and seeding test database for E2E"
  (cd "$BACKEND_DIR" && DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate reset --force --skip-seed)
  (cd "$BACKEND_DIR" && DATABASE_URL="$TEST_DATABASE_URL" npm run db:seed:force)
  echo "[INFO] Running E2E spec(s): ${E2E_SPECS[*]}"
  DATABASE_URL="$TEST_DATABASE_URL" \
    JWT_SECRET="$JWT_SECRET" \
    FRONTEND_ORIGIN="$FRONTEND_ORIGIN" \
    COOKIE_SECURE=false \
    npx playwright test "${E2E_SPECS[@]}"
  RAN_ANYTHING=true
fi

if [[ "$RAN_ANYTHING" == "false" ]]; then
  echo "[INFO] No affected tests for the current change set (base: ${BASE_COMMIT:-none})."
  echo "       Docs/config-only changes are covered by CI path filtering."
fi

echo "[INFO] verify:quick passed"
