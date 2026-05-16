# MoNexus Operations Runbook

> Gray-launch operations playbook. Commands assume bash and the repo cloned at `$REPO_ROOT`.
> Replace placeholders (`<...>`) before running. Never paste secrets into this file.

## 1. Service Start and Stop

Dev stack (PostgreSQL container + backend + frontend) via helper script:

```bash
cd "$REPO_ROOT"
bash scripts/dev-up.sh            # start
bash scripts/dev-up.sh --seed     # start + reseed dev fixtures
```

Stop everything:

```bash
# Ctrl-C the dev-up.sh foreground (kills backend + frontend).
docker stop monexus-db            # stop PostgreSQL container
# Full teardown (removes container, keeps the named volume):
docker rm monexus-db
```

Restart the DB container without touching data:

```bash
docker start monexus-db
```

## 2. Health Check

The backend exposes `GET /api/health` and returns `{ status, db, time }`.

```bash
curl -fsS http://localhost:3000/api/health
# expected: {"status":"ok","db":"ok","time":"2026-05-12T..."}
```

If `db` is not `ok`, jump to section 10 (PostgreSQL connection failure).

## 3. Manual Backup

The backup script lives at `scripts/backup.sh` and uses `pg_dump`. Required and optional env:

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Postgres URL, e.g. `postgres://user:pass@host:5432/monexus` |
| `BACKUP_DIR` | no | `/var/backups/monexus` | Target directory |
| `RETENTION_DAYS` | no | `30` | Prune dumps older than N days |
| `RCLONE_REMOTE` | no | — | If set, `rclone copy` the new dump there |

Run:

```bash
export DATABASE_URL='postgres://monexus:<password>@db.internal:5432/monexus'
export BACKUP_DIR=/var/backups/monexus
bash scripts/backup.sh
# stdout: /var/backups/monexus/monexus-YYYYMMDDTHHMMSSZ.sql.gz
```

The script prints the final path on success. Verify size and integrity:

```bash
ls -lh "$BACKUP_DIR" | tail
gunzip -t /var/backups/monexus/monexus-YYYYMMDDTHHMMSSZ.sql.gz && echo "gzip OK"
```

## 4. Backup Restore Into Staging

Never restore over production. Use a staging DB.

```bash
STAGING_URL='postgres://monexus:<password>@staging-db.internal:5432/monexus_restore'
BACKUP=/var/backups/monexus/monexus-YYYYMMDDTHHMMSSZ.sql.gz

# Recreate the target DB (drops existing data).
psql "$STAGING_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

# Stream the dump back.
gunzip -c "$BACKUP" | psql "$STAGING_URL"

# Sanity: row counts on a couple of large tables.
psql "$STAGING_URL" -c 'SELECT COUNT(*) FROM "User";'
psql "$STAGING_URL" -c 'SELECT COUNT(*) FROM "PointLog";'
```

After verification, point a throwaway backend instance at `$STAGING_URL` and smoke key flows (login, redeem, settle).

## 5. Daily Cron Example

Place env in a private file (e.g. `/etc/monexus/backup.env`, mode `0600`, owned by the cron user):

```env
DATABASE_URL=postgres://monexus:<password>@db.internal:5432/monexus
BACKUP_DIR=/var/backups/monexus
RETENTION_DAYS=30
# RCLONE_REMOTE=s3-prod:monexus-backups/db
```

Cron entry (runs at 02:17 UTC daily, log to file):

```cron
17 2 * * * set -a; . /etc/monexus/backup.env; set +a; /opt/monexus/scripts/backup.sh >> /var/log/monexus/backup.log 2>&1
```

Quick sanity:

```bash
sudo -u monexus bash -lc 'set -a; . /etc/monexus/backup.env; set +a; /opt/monexus/scripts/backup.sh'
tail -n 20 /var/log/monexus/backup.log
```

## 6. Emergency User Point Adjustment

Preferred path: admin API (writes both `PointLog` and `AdminLog`).

```bash
ADMIN_TOKEN='<bearer-token-of-admin>'
curl -fsS -X POST "http://localhost:3000/api/admin/users/<userId>/adjust" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"delta": -100, "reason": "fraud reversal #1234"}'
```

Emergency fallback (DB direct, only when the API is unavailable). This bypasses audit — file an incident note.

```bash
psql "$DATABASE_URL" <<'SQL'
BEGIN;
UPDATE "User" SET points = points - 100 WHERE id = <userId>;
INSERT INTO "PointLog" ("userId", "delta", "reason", "createdAt")
  VALUES (<userId>, -100, 'manual emergency adjust', NOW());
COMMIT;
SQL
```

## 7. Emergency User Ban

Sets `User.status` to the Chinese sentinel `已封禁`. Banned users cannot log in or refresh.

Preferred path (admin API, once merged):

```bash
curl -fsS -X PUT "http://localhost:3000/api/admin/users/<userId>/ban" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason": "abuse report #4567"}'
```

Emergency fallback (DB direct + force refresh-token revocation):

```bash
psql "$DATABASE_URL" <<'SQL'
BEGIN;
UPDATE "User" SET status = '已封禁' WHERE id = <userId>;
DELETE FROM "RefreshToken" WHERE "userId" = <userId>;
COMMIT;
SQL
```

To unban: set `status = '正常'` (and let the user log in again to mint fresh tokens).

## 8. Merchant Suspension

```bash
curl -fsS -X PUT "http://localhost:3000/api/admin/merchants/<merchantId>/suspend" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

This sets `Merchant.status = 'suspended'` and writes `AdminLog`. The merchant retains access to their own settlement history but cannot list new products or accept new orders. To reactivate, an admin must explicitly re-approve via the admin console.

## 9. Logs to Inspect

| Component | Dev location | Prod location |
| --- | --- | --- |
| Backend stdout / stderr | foreground of `scripts/dev-up.sh` | `/var/log/monexus/backend.log` (systemd journald or your aggregator) |
| Backup script | terminal | `/var/log/monexus/backup.log` |
| PostgreSQL | `docker logs monexus-db` | DB host: `/var/log/postgresql/postgresql-*.log` |
| Frontend (dev only) | Vite terminal | — (static, served by CDN/edge in prod) |

Quick triage commands:

```bash
docker logs --tail=200 monexus-db
journalctl -u monexus-backend -n 200 --no-pager     # if managed by systemd
tail -n 200 /var/log/monexus/backend.log
```

## 10. PostgreSQL Connection Failure

Symptoms: `/api/health` reports `db: "error"`, backend logs show `ECONNREFUSED` / `PrismaClientInitializationError`.

Diagnosis ladder:

```bash
# 1) Is the container running?
docker ps --filter name=monexus-db

# 2) Can the host reach the port?
nc -zv 127.0.0.1 5432

# 3) Do credentials work?
psql "$DATABASE_URL" -c 'SELECT 1;'

# 4) Inspect DB-side errors.
docker logs --tail=200 monexus-db
```

Common causes:

- Container stopped → `docker start monexus-db`
- Password rotated but `DATABASE_URL` not updated → fix env, restart backend
- Wrong host (e.g. `localhost` vs. container DNS) → confirm with `psql`
- Disk full on DB host → section 11

If the DB is in recovery mode, do **not** truncate WAL — engage the DBA and restore from the latest section-3 backup into a staging instance first.

## 11. Disk Full

```bash
df -h
du -sh /var/backups/monexus/* | sort -h | tail
du -sh /var/log/* | sort -h | tail
```

Mitigations (least destructive first):

1. Lower `RETENTION_DAYS` temporarily and rerun `scripts/backup.sh` so it prunes:
   ```bash
   RETENTION_DAYS=7 bash scripts/backup.sh
   ```
2. Manually delete the oldest dumps:
   ```bash
   ls -t /var/backups/monexus/monexus-*.sql.gz | tail -n +15 | xargs -r rm -v
   ```
3. Rotate or truncate large log files (do not delete an in-use file — truncate it):
   ```bash
   sudo truncate -s 0 /var/log/monexus/backend.log
   ```
4. If PostgreSQL is the culprit (`/var/lib/postgresql/...`), engage the DBA — do not `rm` inside the data directory.

## 12. Port Occupied

`scripts/dev-up.sh` expects backend on `3000`, frontend on `5173`, DB on `5432`.

```bash
# Identify the squatter.
sudo lsof -i :3000
sudo lsof -i :5173
sudo lsof -i :5432

# Or with ss:
sudo ss -ltnp | grep -E ':(3000|5173|5432)\\b'

# Kill (only after confirming the PID is yours):
kill <PID>          # graceful
kill -9 <PID>       # last resort
```

If `monexus-db` is occupying `5432`, either reuse it or stop it before starting a competing Postgres:

```bash
docker stop monexus-db
```

## 13. Rollback Procedure

For a bad deploy on the backend:

```bash
cd "$REPO_ROOT"
git fetch --all --tags
git log --oneline -n 10                                  # find the last known-good SHA
BAD=<bad-sha>; GOOD=<good-sha>

# 1) Code rollback via revert (preserves history, plays nicely with CI).
git checkout main
git revert --no-edit "$BAD"
git push origin main

# 2) Schema rollback (only if the bad release ran a migration).
#    Restore the section-3 backup into staging FIRST, validate, then promote.
#    Never run "prisma migrate resolve --rolled-back" on prod without a fresh dump in hand.

# 3) Redeploy.
#    Trigger your normal deploy pipeline against the reverted commit.

# 4) Verify.
curl -fsS https://<prod-host>/api/health
```

For a frontend-only rollback, redeploy the previous build artifact — no DB action needed.

Post-rollback: write an incident note (what, when, blast radius, follow-up tickets) and link the relevant commits and log excerpts. Schedule a postmortem within 48 hours.

## 14. Email Configuration (M3)

M3 replaces the dev-only console mailer with a real SMTP adapter (nodemailer). The console fallback stays alive for local development so you can run the app without an SMTP relay.

### Selection rule

The selector lives in `server/src/config/index.ts`:

| `SMTP_HOST` | Adapter | What happens |
| --- | --- | --- |
| unset / empty | `console` | Each send logs the payload (to / subject / text snippet) via the structured logger. No network egress. |
| set | `smtp` | `nodemailer` opens a connection to that host using the supplied port / security / credentials. |

`SMTP_FROM` (or `SMTP_USER` as a fallback) becomes the `From:` header. In production, `SMTP_HOST` + a from address is **required** — boot fails fast if `SMTP_HOST` is set but neither `SMTP_FROM` nor `SMTP_USER` is.

### Env variables

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SMTP_HOST` | prod only | — | SMTP server hostname; opts into real delivery |
| `SMTP_PORT` | no | `587` | Submission port (`587` STARTTLS / `465` implicit TLS / `25` MTA-only) |
| `SMTP_SECURE` | no | `false` | `true` for implicit TLS (port 465); `false` lets nodemailer STARTTLS on 587 |
| `SMTP_USER` | provider-dep. | — | Auth username — leave empty for relays that accept unauthenticated submissions |
| `SMTP_PASS` | provider-dep. | — | Auth password — pair with `SMTP_USER` |
| `SMTP_FROM` | yes if `SMTP_HOST` set | `SMTP_USER` | `From:` header. Verified / DMARC-aligned addresses only |
| `APP_BASE_URL` | no | `FRONTEND_ORIGIN` | Base URL injected into reset / verify links inside emails |

### Local dev: MailHog

MailHog is a single-binary SMTP catcher with a web UI — emails are caught instead of delivered.

```bash
docker run --rm --name mailhog \
  -p 1025:1025 -p 8025:8025 \
  mailhog/mailhog

# Backend env (server/.env):
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM=noreply@monexus.local
# (no SMTP_USER / SMTP_PASS needed)

# Trigger a password reset, then open http://localhost:8025 — the
# message shows up with full HTML + headers.
```

### Production providers

Use the provider's documentation for the canonical values — these are starting points.

| Provider | Host | Port | Secure | Notes |
| --- | --- | --- | --- | --- |
| AWS SES SMTP | `email-smtp.<region>.amazonaws.com` | `587` | `false` (STARTTLS) | SMTP credentials are SES-specific, **not** IAM root keys. Domain / from-address must be verified in SES first. |
| Mailtrap (staging) | `sandbox.smtp.mailtrap.io` | `2525` | `false` | Inbox is a sandbox — safe for QA, never points at real users. |
| Gmail SMTP | `smtp.gmail.com` | `465` | `true` | Requires app-password or OAuth proxy; rate-limited; production-discouraged. |
| Self-hosted Postfix | depends | `587` | `false` | Ensure SPF / DKIM / DMARC are aligned — providers drop unauthenticated mail. |

### Verification recipe

```bash
# Backend hot-load env, then trigger a reset for a test user:
curl -fsS -X POST http://localhost:3000/api/auth/password-reset/request \
  -H 'Content-Type: application/json' \
  -d '{"email":"qa+reset@example.com"}'

# Expected:
# - SMTP_HOST unset: backend log line "[mailer/console] -> qa+reset@example.com subject=..."
# - SMTP_HOST set:   MailHog UI shows message (dev) or provider's outbound log confirms delivery (prod).
# - Sentry: no error events for `password reset` if delivery succeeded.
```

If the SMTP handshake fails (auth / TLS / DNS), nodemailer throws and the request returns 500 — check structured logs for the underlying error code (`EAUTH`, `ETIMEDOUT`, `ENOTFOUND`) before re-trying.

## 15. Object Storage (M3)

M3-A2 replaces the in-memory uploads adapter with a real S3-compatible client (`@aws-sdk/client-s3`). The in-memory adapter stays alive for local dev / tests so you can run without provisioning a bucket.

### Selection rule

| Env state | Adapter | Notes |
| --- | --- | --- |
| All of `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` set | `s3` | Real PUT / GET to the bucket. |
| Any of the four missing | `memory` | Process-local Map. Lost on restart. Safe for dev / tests only. |

Production refuses to boot in `memory` mode — `server/src/config/index.ts` enforces this when `NODE_ENV=production`.

### Env variables

| Var | Required (prod) | Default | Purpose |
| --- | --- | --- | --- |
| `STORAGE_ENDPOINT` | yes | — | S3 endpoint URL (MinIO / R2 / S3 / OSS / Backblaze) |
| `STORAGE_REGION` | no | `us-east-1` | Required by the SDK signer; most non-AWS providers accept any non-empty value |
| `STORAGE_BUCKET` | yes | — | Bucket name |
| `STORAGE_ACCESS_KEY` | yes | — | Access key |
| `STORAGE_SECRET_KEY` | yes | — | Secret key |
| `STORAGE_PUBLIC_URL_BASE` | no | derived | Public URL prefix served to the frontend. Set when you front the bucket with a CDN / custom domain. |
| `STORAGE_FORCE_PATH_STYLE` | no | `true` | `true` for MinIO / R2 / Backblaze. Set `false` for AWS S3 modern endpoints (virtual-hosted style). |

### Local dev: MinIO

```bash
docker run --rm --name minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minio \
  -e MINIO_ROOT_PASSWORD=minio_dev_password \
  quay.io/minio/minio server /data --console-address ':9001'

# Create the bucket once (via UI at http://localhost:9001 with the
# credentials above, or via mc CLI):
docker exec minio mc alias set local http://localhost:9000 minio minio_dev_password
docker exec minio mc mb local/monexus-uploads

# server/.env:
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_BUCKET=monexus-uploads
STORAGE_ACCESS_KEY=minio
STORAGE_SECRET_KEY=minio_dev_password
STORAGE_PUBLIC_URL_BASE=http://localhost:9000/monexus-uploads
STORAGE_FORCE_PATH_STYLE=true
```

### Production providers

| Provider | Endpoint | `FORCE_PATH_STYLE` | Notes |
| --- | --- | --- | --- |
| AWS S3 | `https://s3.<region>.amazonaws.com` | `false` | Modern endpoints prefer virtual-hosted style; bucket name must be DNS-compatible. |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `true` | Region literal: `auto`. Public read via R2 public bucket or workers. |
| Backblaze B2 (S3 API) | `https://s3.<region>.backblazeb2.com` | `true` | Egress to Cloudflare via Bandwidth Alliance is free. |
| MinIO (self-host) | `http://minio:9000` | `true` | Use `https://` once you front it with a reverse proxy + certs. |

### Verification recipe

```bash
# After uploading a product image via the admin UI, watch the
# request-id header in the backend log and confirm S3 PUT:
curl -fsS -X POST http://localhost:3000/api/admin/products/<id>/icon \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@/path/to/icon.png"

# Then look for the uploaded object via the provider's tooling:
docker exec minio mc ls local/monexus-uploads/  # MinIO
aws s3 ls "s3://$STORAGE_BUCKET/"                # AWS
```

`STORAGE_PUBLIC_URL_BASE` is what the frontend renders in `<img src>` — confirm browser DevTools resolves it without a 403 (signed URLs are not used for product imagery).

## 16. CI Pipeline (M3)

M3-A3 wires a `.github/workflows/ci.yml` that runs on every PR and every push to `master`. There is no CD yet (deferred to M4 once the production target is decided).

### Jobs

| Job | Step | Notes |
| --- | --- | --- |
| `build` | `npm ci`, `npm run build`, `npm --prefix server ci`, `npm --prefix server run build` | Catches TS regressions in both root frontend and `server/`. |
| `test` | `postgres:16` service container, `npm --prefix server run test` | Real Postgres; ≥82 backend tests. Run order matters because some tests share a schema reset hook. |

The Postgres service uses `monexus_test` as DB name, `monexus` as user, and a throwaway password — the workflow injects `DATABASE_URL` accordingly.

### Adding secrets

Secrets land in **Settings → Secrets and variables → Actions** on GitHub. The current workflow does **not** read any secrets — production-only env (SMTP, real Sentry DSN, real S3 creds) gets added when the deployment job lands. Suggested names when CD arrives:

- `PROD_SMTP_HOST`, `PROD_SMTP_USER`, `PROD_SMTP_PASS`
- `PROD_SENTRY_DSN`, `PROD_VITE_SENTRY_DSN`
- `PROD_STORAGE_*`

Never commit production credentials to `.env.example`.

### Branch protection (recommended)

After the workflow goes green at least once:

1. Settings → Branches → Add rule for `master`.
2. Require status checks to pass: enable `CI / build` and `CI / test`.
3. Require linear history (matches the existing PR-merge workflow).

### Re-running locally

```bash
# Reproduce the test job locally:
docker run --rm -d --name monexus-ci-pg \
  -e POSTGRES_USER=monexus -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=monexus_test \
  -p 5433:5432 postgres:16
DATABASE_URL='postgresql://monexus:ci@localhost:5433/monexus_test' \
  npm --prefix server test
docker stop monexus-ci-pg
```

## 17. Error Reporting (Sentry / GlitchTip)

M2 GA shipped both backend and frontend Sentry integration; M3 documents the setup.

### Backend

- Hooked in `server/src/lib/observability/*` and initialized in `server/src/app.ts`.
- Set `SENTRY_DSN` to your Sentry / self-hosted GlitchTip project DSN to enable event forwarding.
- Errors from Express middlewares + unhandled rejections flow automatically. The request-id header (`x-request-id`) is attached to each event for cross-referencing with logs.

### Frontend

- Hooked in `src/lib/sentry.ts` and initialized in `src/main.tsx`.
- `VITE_SENTRY_DSN` is baked at **build time** (Vite) — changing it requires a rebuild, not a redeploy of a static bundle.
- A React error boundary at the root catches render-time failures (`src/components/ErrorBoundary.tsx`).

### Verify a live DSN

```bash
# Backend: force an error and confirm it lands in Sentry.
curl -fsS -X POST http://localhost:3000/api/internal/_sentry-smoke 2>/dev/null || true
# (no such endpoint exists by design — use a test deploy and an
#  intentional throw inside a known route guarded by an admin token)

# Frontend: paste into the JS console on a built page:
window.Sentry?.captureException(new Error('sentry smoke'));
# Expect: the event appears in the project's "Issues" list within ~1 minute.
```

### Self-hosted GlitchTip

GlitchTip is API-compatible with Sentry — set the DSN the same way. The platform tag and source map upload (frontend) work as long as your GlitchTip is on a recent release. Configure source map upload as a CI step once CD is in place; do it manually until then with `sentry-cli` or `glitchtip-cli`.

If the DSN is set but events never arrive: check egress firewall, check the DSN host (must include `/` after the project id), and check that the React app is built **after** the env var was injected.

## 18. Auth Performance — User Status Cache (M3)

M3-A5 adds an in-memory LRU cache for `User.status` to skip the per-request Prisma lookup that M2.1 introduced. The cache lives in `server/src/lib/userStatusCache.ts` and is consumed by `requireActiveUser` middleware.

### Tuning

| Var | Default | Effect |
| --- | --- | --- |
| `USER_STATUS_CACHE_TTL_SEC` | `60` | Entry TTL. `0` disables the cache (every request reads Prisma — pre-M3 behavior). |

The cache holds up to ~10 000 entries with LRU eviction; `getCached` re-inserts on hit to refresh recency.

### Trade-off

| Scenario | Behavior |
| --- | --- |
| Admin bans a user | `banUser` invalidates the cache entry **before** committing — next request sees `已封禁` and 403s immediately. |
| Admin unbans a user | Same path: cache cleared, next request reads `正常`. |
| User changes password | `changePassword` invalidates explicitly. |
| Raw DB edit (`UPDATE "User" SET status = …`) | Cache only catches up after TTL — up to `USER_STATUS_CACHE_TTL_SEC` seconds of stale state. |

Set TTL to `0` in operator environments where status mutations happen out-of-band (e.g. an external admin tool writing Prisma directly). Otherwise leave the default.

### Diagnostics

The cache has no metric output yet (deferred to M4 observability work). To estimate hit ratio in production, temporarily drop TTL to `0`, watch `requireActiveUser` latency in your APM, then restore TTL.

## 19. refreshTokenMaxAgeDays Semantics (M3)

M3-A4 wires the `refreshTokenMaxAgeDays` system config key (admin-editable via `PUT /api/admin/config/{key}`) into the actual refresh-token mint path.

### What "takes effect" means

- Reading the config returns the live value via `getRefreshTokenMaxAgeMs()`.
- **Newly-issued** refresh tokens (after login / refresh / register / verify-email-and-auto-login) use the new value for both DB `expiresAt` and Set-Cookie `Max-Age`.
- **Already-issued** refresh tokens **keep their original `expiresAt`** — there is no DB-wide UPDATE on config change. This is intentional: rotating the value to a smaller number must not retroactively shorten live sessions without an explicit operator decision.

### Forcing logout

To shorten effective session length for a specific user **immediately**, use one of:

```bash
# 1) Ban + unban — revokes all refresh tokens, user must log in again.
curl -fsS -X PUT "http://localhost:3000/api/admin/users/<userId>/ban" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"force re-auth for shortened-TTL rollout"}'
curl -fsS -X PUT "http://localhost:3000/api/admin/users/<userId>/unban" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 2) Or: have the user change their password (same revocation effect).
```

To force a global rotation, run a manual SQL on the refresh-token table — coordinate with the team first, file an incident note, and clear the user-status cache (`docker restart monexus-backend`) afterwards so banned states aren't held stale.

## 20. Operator Audit Log (M3)

M3-A6 + A7 add an operator-facing audit log surface: a paginated, filterable read API over `AdminLog` plus an "操作审计" tab in the admin console UI. The pre-existing `/api/admin/logs` endpoint still exists and still returns `PointLog` — it has been renamed in the UI as "积分流水" to keep the two streams distinct.

### Endpoint

`GET /api/admin/audit?page=&pageSize=&adminId=&action=&fromDate=&toDate=`

- All params optional; defaults are `page=1` and `pageSize=20` (max 100).
- `action` is an **exact** match (e.g. `ban`, `unban`, `config_update`, `point_adjust`, `merchant_approve`).
- `fromDate` / `toDate` are `YYYY-MM-DD`; `toDate` is treated as end-of-day inclusive.
- Returns `{items, total, page, pageSize}` — see `AdminLogList` in `docs/superpowers/specs/monexus-api-openapi.json`.

### Common queries

```bash
ADMIN_TOKEN='<bearer-token-of-admin>'
BASE=http://localhost:3000

# Everything in the last 24h
curl -fsS "$BASE/api/admin/audit?fromDate=$(date -u +%F)" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Bans only
curl -fsS "$BASE/api/admin/audit?action=ban" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# What did admin id 7 do this week
curl -fsS "$BASE/api/admin/audit?adminId=7&fromDate=$(date -u -d '7 days ago' +%F)" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Frontend

The "操作审计" tab in `AdminPage.tsx` exposes the same filters as form controls — operators can drill in without touching curl. The "积分流水" tab next to it is the historical `/api/admin/logs` view, kept for backwards compatibility with operator muscle memory.

## 21. E2E Testing (M4)

We use Playwright (chromium-only) for end-to-end coverage of the 3 highest-value user paths: register → login → profile, daily check-in, and product-detail → exchange modal. The suite is intentionally tiny (3 tests) and will only be expanded when a regression escapes review.

### Run locally

```bash
# In one shell: backend
cd server && npm run dev   # :3000

# In another: frontend
npm run dev                # :5173

# In a third: tests (one-time browser install)
npx playwright install --with-deps chromium

# Headless
npm run e2e

# Interactive dev mode
npm run e2e:ui
```

The Playwright config lives at `playwright.config.ts`; specs live at `e2e/*.spec.ts`. The runner expects both 3000 and 5173 to already be up — it does **not** start them itself.

### Read CI failures

GitHub Actions → failed `e2e` job → bottom of the page → `playwright-report` artifact. Download → unzip → open `index.html` → see screenshots, traces, and console logs for each failed test.

### Add a new test

Don't create page objects yet. Until we cross ~10 tests, inline selectors in a new `e2e/<name>.spec.ts` and match existing patterns in `e2e/auth.spec.ts`. Each test should self-bootstrap (register an inline user with a unique email) — no shared seed data, no test ordering, no cleanup hooks.

## 22. CD Pipeline (M4)

M4 introduces the first half of CD: build-and-package on manual trigger. The second half (real deployment target + post-deploy smoke + rollback) lands in M5.

### Trigger a build

GitHub → Actions → **"CD Build Artifact"** → Run workflow → optionally override `ref` (default `master`) → Run.

Build runs for ~3-5 minutes. Two artifacts are produced and retained 30 days:

- `frontend-dist-<sha>` — Vite output, `BUILD_INFO.json` stamped with commit + build timestamp.
- `server-dist-<sha>` — compiled server + `package.json` + `prisma/`, ready for `npm ci && npx prisma migrate deploy` at the deploy target.

### Repo-level vars to set before the first production build

Settings → Secrets and variables → Actions → **Variables** tab:

- `VITE_API_URL` — production API origin (e.g., `https://api.monexus.example.com`).
- `VITE_SENTRY_DSN` — frontend Sentry DSN (public; same one used in dev `.env.local`).

These are **vars** (not secrets) because the frontend bundle embeds them — they are visible to anyone with the bundle anyway. Marking them as secrets would just make CI logs noisier without adding any real protection.

### M5 roadmap

M5 will add: target deployment step (ssh / k8s / etc.), smoke check post-deploy, and a rollback workflow that rebuilds and redeploys a previous `ref`.

## 23. Metrics & Prometheus (M4)

The server exposes `GET /api/metrics` in Prometheus text exposition format. Default Node.js process metrics (CPU, RSS, event-loop lag, GC, FD count, …) **plus** two custom HTTP-layer metrics:

- `monexus_http_requests_total{method, route, status_code}` — counter.
- `monexus_http_request_duration_seconds{method, route, status_code}` — histogram (buckets: 5ms / 10ms / 25ms / 50ms / 100ms / 250ms / 500ms / 1s / 2.5s / 5s / 10s).

The `route` label uses Express's matched route pattern (`/api/products/:id`) not the raw path (`/api/products/123`) to bound cardinality.

### Production setup — protect with a bearer token

Set `METRICS_TOKEN` in the server environment:

```bash
# Generate a strong random token
METRICS_TOKEN=$(openssl rand -hex 32)
```

When set, `/api/metrics` requires `Authorization: Bearer <token>`. When unset, the endpoint is open to anyone who can reach the port — acceptable for dev / private network behind a firewall, **NOT** for production exposure.

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: monexus
    scheme: https
    scrape_interval: 30s
    metrics_path: /api/metrics
    bearer_token: <METRICS_TOKEN value>
    static_configs:
      - targets: ['api.monexus.example.com']
```

### Useful queries

- Request rate by route: `sum by (route) (rate(monexus_http_requests_total[1m]))`
- P95 latency by route: `histogram_quantile(0.95, sum by (le, route) (rate(monexus_http_request_duration_seconds_bucket[5m])))`
- Error rate: `sum(rate(monexus_http_requests_total{status_code=~"5.."}[5m])) / sum(rate(monexus_http_requests_total[5m]))`

## 24. Database Backup (M4)

GitHub Actions runs `pg_dump` against production daily at **02:17 UTC** and uploads a gzipped SQL dump as a 7-day-retention artifact. Manual trigger is also available for ad-hoc backups before risky changes.

### One-time secret setup

1. In your production PostgreSQL, create a read-only backup role:

   ```sql
   CREATE ROLE monexus_backup WITH LOGIN PASSWORD '<strong random>';
   GRANT CONNECT ON DATABASE monexus TO monexus_backup;
   GRANT USAGE ON SCHEMA public TO monexus_backup;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO monexus_backup;
   GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO monexus_backup;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO monexus_backup;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO monexus_backup;
   ```

2. GitHub → Settings → Secrets and variables → Actions → **New repository secret**:
   - Name: `BACKUP_DATABASE_URL`
   - Value: `postgresql://monexus_backup:<password>@<host>:5432/monexus?sslmode=require`

The workflow refuses to run if this secret is missing — it fails fast rather than silently producing an empty dump.

### Trigger a manual backup

GitHub → Actions → **"Database Backup"** → Run workflow. Useful before any risky schema migration or before a production rollback rehearsal.

### Restore from a backup artifact

```bash
# 1. Download the artifact from the run's summary page
unzip db-backup-20260513T021700Z.zip   # produces monexus-backup-20260513T021700Z.sql.gz

# 2. Restore into a target database (e.g., a fresh staging DB)
gunzip -c monexus-backup-*.sql.gz | psql "$RESTORE_TARGET_URL"

# 3. Verify
psql "$RESTORE_TARGET_URL" -c "SELECT count(*) FROM \"User\";"
```

The `--clean --if-exists` flags on `pg_dump` mean the dump can be replayed against a database that already has the schema — useful for refreshing staging from prod.

### Retention & M5 roadmap

7 days is the M4 floor — set deliberately low while we settle on encryption and storage location. M5 will add: longer retention via off-region object storage, encryption at rest (`age` or `gpg`), and a quarterly automated restore-to-scratch-DB verification job.

## 25. Web Vitals (M4)

The frontend reports Core Web Vitals (LCP, CLS, INP, FCP, TTFB) to Sentry on **production builds only** when `VITE_SENTRY_DSN` is set. Disabled in dev mode to avoid HMR noise and quota burn.

### Find them in Sentry

- **Performance** → filter by transaction or by tag `webvital.lcp.rating` / `webvital.inp.rating` / etc.
- Each metric is reported three ways:
  - **Breadcrumb** — visible in Issues alongside the user's session trail.
  - **Measurement** — numeric value indexed in Performance dashboards.
  - **Tag** — `webvital.<metric>.rating = good | needs-improvement | poor`, useful for grouping.

### Standard thresholds (Google)

| Metric | Good   | Needs improvement | Poor    |
|--------|--------|-------------------|---------|
| LCP    | ≤2.5s  | ≤4.0s             | >4.0s   |
| INP    | ≤200ms | ≤500ms            | >500ms  |
| CLS    | ≤0.1   | ≤0.25             | >0.25   |
| FCP    | ≤1.8s  | ≤3.0s             | >3.0s   |
| TTFB   | ≤0.8s  | ≤1.8s             | >1.8s   |

### Sampling

We don't filter at collection time — every page reports its vitals. Volume is controlled by Sentry's `tracesSampleRate` in `src/lib/sentry.ts` (default `0.1` = 10% of transactions). If quota becomes an issue, lower that rate first — don't add custom filtering on the frontend.

### Suggested dashboards (operator follow-up)

- **LCP rating distribution week-over-week** — weekly trend of good / needs / poor share.
- **INP P95 by route** — find pages with slow interactivity.
- **CLS by build** — catch layout-shift regressions per deploy.

M4 only collects the data; building these dashboards in Sentry is an operator follow-up.

## 26. Health Endpoints (M4)

M4 split the old single `/api/health` into two semantically distinct routes. **This section supersedes section 2 for any caller written after M4** — section 2 is kept for historical context.

| Route | Always 200? | Touches DB? | Use case |
|-------|-------------|-------------|----------|
| `GET /api/health/live` | Yes (when process is up) | No | k8s `livenessProbe`, "restart this container?" |
| `GET /api/health/ready` | No (200 / 503) | Yes (2s ping) | k8s `readinessProbe`, LB health check, "route traffic here?" |
| `GET /api/health` | Yes | No | **DEPRECATED** — alias of `/live` for backwards compatibility |

### Why split

The classic anti-pattern is a single conflated endpoint: a slow DB causes liveness to fail → orchestrator restarts healthy app instances → cascading failure. Splitting means: if the DB is slow, readiness fails (LB stops routing traffic to this instance) but liveness stays green (instance stays alive, can recover when DB comes back).

### Quick verify

```bash
BASE=http://localhost:3000

curl -fsS "$BASE/api/health/live"   # {"status":"live","uptime":...,"timestamp":...}
curl -fsS "$BASE/api/health/ready"  # {"status":"ready","checks":{"database":"ok","config":"ok"},...}
curl -fsS "$BASE/api/health"        # alias of /live, identical body
```

### Kubernetes example

```yaml
livenessProbe:
  httpGet:
    path: /api/health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3   # 30s grace before kill

readinessProbe:
  httpGet:
    path: /api/health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 2   # 10s grace before LB stops routing
```

### Migration from M3 monitors

External monitors (Sentry, Pingdom, Uptime Robot, etc.) configured against `/api/health` keep working — they hit the alias, which behaves like `/live`. Update them:

- → `/api/health/ready` if you want them to **alert on DB issues**.
- → `/api/health/live` if you want them to **only alert on "process is dead"**.

The `/api/health` alias will stay through M5 to avoid forcing a coordinated cutover. Plan to remove it in M6+ once all known external probes are migrated.

## 27. M5 Production Deploy

M5 chooses the self-hosted nginx + systemd/PM2 target from `docs/operations/deployment-target.md`. The default host layout is:

```text
/opt/monexus/
  candidate -> /opt/monexus/releases/<candidate-sha>
  current   -> /opt/monexus/releases/<active-sha>
  releases/
    <sha>/
      frontend/
      server/
```

Production entry point: GitHub Actions -> **Production Deploy** -> **Run workflow**.

Use `release_action=deploy_candidate` for a new artifact build. Keep `dry_run=true` first, confirm the resolved `DEPLOY_COMMIT`, then rerun with `dry_run=false` only after the selected GitHub environment has deploy values configured.

Required production host checks before the first live deploy:

- nginx serves `/opt/monexus/current/frontend` and proxies `/api/` to the backend process.
- Node.js 20, npm, tar, curl, PostgreSQL access, and either systemd or PM2 are available.
- A non-root deploy user can write `/opt/monexus/releases` and restart only `monexus-api`.
- TLS and DNS are already configured for frontend and API origins.

The deploy workflow builds frontend and backend, generates Prisma client with the server package, packages artifacts, prepares a release directory, runs `prisma migrate deploy` during `deploy_candidate` only, and updates `candidate`.

## 28. M5 Production Secrets

Use GitHub Actions Environments named `staging` and `production` as documented in `docs/operations/secrets-management.md`.

Minimum operator setup:

1. GitHub -> Settings -> Environments -> create `staging` and `production`.
2. Protect `production` with at least one required reviewer and restrict it to `master` and release tags.
3. Put credentials in environment secrets, not environment variables.
4. Put public build-time values such as `VITE_API_URL` and `VITE_SENTRY_DSN` in environment variables because Vite embeds them into the frontend bundle.
5. Never paste secret values into docs, PR comments, issue comments, screenshots, or workflow logs.

Key groups to verify before production:

| Group | Required examples | Consumer |
| --- | --- | --- |
| Deploy | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_PRIVATE_KEY` | Production Deploy workflow |
| Backend runtime | `DATABASE_URL`, `JWT_SECRET`, `SENTRY_DSN`, SMTP/storage values | deploy host env and backend process |
| Metrics | `METRICS_TOKEN` | backend runtime and scrape target |
| Backup | `BACKUP_DATABASE_URL`, `RESTORE_TARGET_URL` | backup workflow and restore rehearsal |
| Alert routing | `ALERT_SLACK_WEBHOOK_URL`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` | Alert Routing Test and incident procedure |

Rotate secrets by changing GitHub environment values or host runtime env, restarting only the consuming component, and recording secret version identifiers rather than values.

## 29. M5 Sentry Alert Rules

`docs/operations/sentry-alert-rules.md` defines the production alert rules built on the M4 Sentry, metrics, and web-vitals foundation.

| Rule | Severity | Window | Routing label |
| --- | --- | --- | --- |
| `MoNexus Backend error spike` | P1 | 5 minutes | `backend-error-p1` |
| `MoNexus Release regression after deploy` | P1 | 30 minutes after deploy | `release-regression-p1` |
| `MoNexus API P95 latency` | P2, critical can escalate | 10 minutes | `api-latency-p2` |
| `MoNexus Frontend LCP poor` | P2 | 15 minutes | `frontend-vitals-p2` |
| `MoNexus Frontend INP poor` | P2 | 15 minutes | `frontend-vitals-p2` |
| `MoNexus Frontend CLS poor` | P2 | 15 minutes | `frontend-vitals-p2` |

Manual setup checklist:

1. Create rules in Sentry for `staging` first.
2. Use the exact rule names, thresholds, owners, and routing labels from the focused doc.
3. Validate staging with temporary low thresholds, then restore production thresholds.
4. Use `.github/workflows/sentry-alert-check.yml` only as a read-only dry-run/helper. It validates documented rule names and optional Sentry API read access; it does not create or mutate alert rules.

If backend Sentry performance transactions are not available yet, keep the API P95 Sentry rule in dry-run documentation and use the M4 Prometheus latency query operationally.

## 30. M5 Alert Routing

`docs/operations/alert-routing.md` is the source of truth for routing labels, severity policy, Slack/email fallback, and first responder ownership.

Severity policy:

- P1 urgent: Slack incident channel first, email fallback, assign an owner within 10 minutes. PagerDuty is optional for production P0/P1 only and is not a default M5 dependency.
- P2 team notification: Slack team channel first, email fallback, watch the next alert window before escalating.

Routing matrix:

| Label | Owner | Default path |
| --- | --- | --- |
| `backend-error-p1` | Backend on-call | Slack urgent route, email fallback |
| `release-regression-p1` | Release manager | Slack urgent route, email fallback |
| `api-latency-p2` | Backend on-call | Slack team notification, email fallback |
| `frontend-vitals-p2` | Frontend on-call | Slack team notification, email fallback |

Test notification procedure:

1. GitHub Actions -> **Alert Routing Test** -> **Run workflow**.
2. Use `staging`, keep `dry_run=true`, and choose a representative routing label.
3. Confirm missing webhook/email values only print the plan and exit without failure.
4. Configure `ALERT_SLACK_WEBHOOK_URL` in the selected environment, then rerun with `dry_run=false`.
5. Confirm the Slack message reaches the expected channel. Email fallback remains an operator procedure; do not add mailbox passwords to the repo.

## 31. M5 Gray Release

M5 uses release directories plus `candidate` and `current` symlinks; it does not add an application feature flag platform. Full commands live in `docs/operations/gray-release.md`.

Normal flow:

```text
release_action=deploy_candidate
ref=<branch-tag-or-sha>
dry_run=true
```

After reviewing the dry-run plan, rerun with `dry_run=false` to prepare `/opt/monexus/candidate`.

Smoke gate before promote:

- `candidate/frontend/BUILD_INFO.json` exists and matches the resolved commit.
- `candidate/server/dist/main.js` exists.
- `prisma migrate deploy` finished during `deploy_candidate`.
- If a candidate-only backend port exists, smoke `/api/health/live` and `/api/health/ready` there.

Promote:

```text
release_action=promote
target_release=<candidate-sha or empty to use candidate symlink>
dry_run=false
```

Rollback:

```text
release_action=rollback
target_release=<known-good-sha>
dry_run=false
```

`promote` and `rollback` restart the runtime and reload nginx, but they do not run migrations.

## 32. M5 Post-deploy Smoke

Run these checks after promote, rollback, or any host env change:

```bash
curl -fsS https://<api-origin>/api/health/live
curl -fsS https://<api-origin>/api/health/ready
curl -fsS https://<frontend-origin>/BUILD_INFO.json
```

Then verify the operator-facing signals:

- `BUILD_INFO.json` commit equals the promoted or rolled-back release id.
- Sentry receives no new `release-regression-p1` events for the current release window.
- `/api/metrics` remains scrapeable by the approved monitoring target.
- nginx config validates with `sudo nginx -t` if the host was touched.
- `systemctl status monexus-api` or `pm2 status` shows the backend process healthy.

If `/api/health/live` fails, inspect the process supervisor and recent backend logs. If `/api/health/ready` fails, treat database/config readiness as degraded and do not restart-loop the API while the dependency is down.

## 33. M5 Rollback / Migration Fallback

Use `docs/operations/rollback-runbook.md` for the full decision tree. This runbook keeps only the operator entry points.

Start with the workflow path when GitHub Actions is available:

```text
release_action=rollback
target_release=<known-good-sha>
dry_run=false
```

Host fallback when GitHub Actions is unavailable:

```bash
GOOD=<known-good-sha>
ssh <deploy-user>@<host> "
  set -euo pipefail
  cd /opt/monexus
  test -d releases/${GOOD}/frontend
  test -d releases/${GOOD}/server/dist
  ln -sfn /opt/monexus/releases/${GOOD} current
  sudo systemctl restart monexus-api
  sudo nginx -t
  sudo systemctl reload nginx
"
```

Migration fallback policy:

- Do not promise or run `prisma migrate down` in production.
- Do not handwrite a down migration during an incident.
- If a migration failed before applying, keep `current` on the previous release and fix the candidate.
- If a migration applied and the app is broken, freeze further deploys, take a fresh backup, rehearse restore in staging, and prefer a forward fix unless restore is clearly safer.
- Keep alert routing open until health checks and the next Sentry alert window recover.

Backup restore rehearsal stays in staging first:

```bash
RESTORE_TARGET_URL='<staging-restore-url>'
BACKUP=monexus-backup-YYYYMMDDTHHMMSSZ.sql.gz

psql "$RESTORE_TARGET_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c "$BACKUP" | psql "$RESTORE_TARGET_URL"
```

## 34. M5 OpenAPI Decision

A7 owns the final OpenAPI decision note. If `docs/operations/openapi-m5-note.md` is present, link it from release notes and use it as the source of truth.

Expected M5 decision: no OpenAPI bump. M5 adds GitHub Actions workflows and operations documents, but no public `/api/*` endpoint, request schema, response schema, auth behavior, or error contract. Keep `docs/superpowers/specs/monexus-api-openapi.json` at `v1.3.0` unless A7 finds a real contract change.

Bump to `v1.4.0` only when a future change adds or changes a public HTTP endpoint or externally visible API behavior.

## 35. M6 Fulfillment Domain Overview

M6 is a domain refactor, not a UI patch. It introduces a fulfillment state machine, splits order DTOs by role, gates settlement on fulfillment status, and exposes a public `registry` so the frontend stops hardcoding labels. The corresponding API contract is captured in `docs/operations/openapi-m6-note.md` (OpenAPI bumped to `v1.4.0`); the corresponding UI contract is in `docs/operations/m6-gemini-ui-contract.md`.

### 35.1 Fulfillment modes

Each product carries a `deliveryMode` flag that decides how an order moves from `pending` to `delivered`:

| Mode | Inventory required | Who delivers | Path |
| --- | --- | --- | --- |
| `instant_inventory` | yes — preloaded `InventoryItem` rows | the system, inside the redeem transaction | order is created already `delivered`, `DeliveryRecord` holds the claimed credential, `stock--`, `sales++`. |
| `manual_service` | no | the merchant, asynchronously | order is created `pending`; merchant calls `start_fulfillment` → `processing` → `deliver` → `delivered`. |

The mode lives on `Product.deliveryMode` and is mirrored on every order response so the user / merchant UI can branch without looking up the product separately. New products default to `instant_inventory` (matches the M5 catalogue).

### 35.2 Order state machine

`server/src/modules/orders/fulfillment.ts` is the single source of truth. Legal transitions only:

```text
pending      → processing
processing   → delivered
delivered    → disputed   | closed
disputed     → processing | closed
closed       → (terminal)
```

Anything outside this graph throws `400 BAD_REQUEST` (`非法订单状态流转: <from> -> <to>`). The legacy value `completed` is normalized to `delivered` both when filtering (`?status=completed` is accepted as an alias) and when serializing (a row stored as `completed` is returned as `delivered`). Do **not** introduce other historical aliases without updating `normalizeOrderStatus`.

Every transition writes an `OrderStatusEvent` row capturing actor user, actor role (`user` / `merchant` / `admin` / `system`), `fromStatus`, `toStatus`, an action key (e.g. `order.created.instant_inventory`, `merchant.fulfillment.start`, `user.dispute`), and optional public / internal notes. The user-detail response surfaces these as `timeline`; merchant / admin detail surface them as `statusEvents`. Orders that predate M2 (no events recorded) synthesize a single-element fallback so the UI never sees an empty array.

### 35.3 Delivery content visibility

`DeliveryRecord.content` holds the user-facing credential (card secret / activation code / node info). M6 narrows where it leaks:

| Endpoint | Role | `delivery.content` visible? |
| --- | --- | --- |
| `GET /api/orders` | user (self) | no |
| `GET /api/orders/{id}` | user (owner only; non-owner gets 404) | yes — the buyer is allowed to read what they bought |
| `GET /api/merchant/orders` | merchant | no |
| `GET /api/merchant/orders/{id}` | merchant (own orders only; 404 otherwise) | no — merchants must never see platform-stocked credentials |
| `GET /api/admin/orders` | admin | no |
| `GET /api/admin/orders/{id}` | admin | yes — kept for forensic / customer-support work |

Serializer enforcement lives in `server/src/modules/orders/serializers.ts` (`serializeUserOrderList` / `serializeUserOrderDetail` / `serializeMerchantOrder` / `serializeAdminOrderList` / `serializeAdminOrderDetail`). If you add a new order-returning route, route it through one of these — do not write a fresh inline serializer.

When a merchant performs manual fulfillment, the `deliveryContent` they supply in the request body is written into `DeliveryRecord.content`. That is sensitive on the request side; do not log it in plaintext and do not echo it back in any merchant list response.

### 35.4 Merchant fulfillment actions

After A1-A6 the merchant surface has three explicit action endpoints. Each is gated by the state machine in §35.2.

| Action | Endpoint | Allowed `from` | New status | Notes |
| --- | --- | --- | --- | --- |
| Start fulfillment | `POST /api/merchant/orders/{id}/fulfillment/start` | `pending` | `processing` | Available for both `instant_inventory` and `manual_service` orders that ended up stuck in `pending` (e.g. instant-inventory legacy backfill). |
| Deliver | `POST /api/merchant/orders/{id}/fulfillment/deliver` | `processing` | `delivered` | **Only valid when `product.deliveryMode = manual_service`.** Hitting it on an `instant_inventory` order returns `400 BAD_REQUEST` (`只有人工服务订单可由商家履约交付`). |
| Respond to dispute | `POST /api/merchant/orders/{id}/fulfillment/respond-dispute` | `disputed` | `processing` (`resolution=resume`) or `closed` (`resolution=close`) | The `resolution` field is required; anything other than `resume` / `close` is rejected by the Zod schema. |

The merchant order detail / list response carries `availableActions: string[]` derived from the current status + delivery mode (`getAvailableActions` in `server/src/modules/merchant/service.ts`). The UI must drive button enabled/disabled state from this array — never compute it client-side from the status string. Possible values: `start_fulfillment`, `deliver`, `respond_dispute`. An empty array means the order has no pending merchant action (already delivered, closed, or instant-inventory order).

The corresponding user-side actions live on `POST /api/orders/{id}/dispute` (only valid from `delivered`) and `POST /api/orders/{id}/close` (valid from `delivered` or `disputed`). The non-owner case returns `404`, not `403`, to preserve the existing "do not leak resource existence" invariant.

### 35.5 Settlement gating

Merchant settlements are no longer payable purely because they sit in `pending`. `getSettlementEligibility(orderStatus)` (`server/src/modules/merchant/service.ts`) gates payability on the linked order's fulfillment status:

| Order status | `payable` | `blockReason` |
| --- | --- | --- |
| `delivered` | `true` | `null` |
| `closed` | `true` | `null` |
| `pending` | `false` | `订单待处理，暂不可结算` |
| `processing` | `false` | `订单履约中，暂不可结算` |
| `disputed` | `false` | `订单争议中，暂不可结算` |
| (anything else) | `false` | `订单状态不可结算` (defensive fallback) |

`GET /api/merchant/settlements` now returns `Settlement` enriched with `{payable, blockReason}` on every row. `POST /api/admin/settlements/batch-settle` enforces the same gate server-side: any selected settlement whose linked order is not payable (or whose own status is not `pending`) causes the whole batch to fail `400 BAD_REQUEST` (`存在不可结算的记录`). Do not loosen this — disputed and unfulfilled orders never pay out.

### 35.6 Registry + system config

Two complementary layers feed runtime registries:

- **Code-level enum + labels + tones** — `server/src/lib/businessRegistry.ts`. Holds the canonical `productTypes`, `deliveryModes`, `orderStatuses`, `settlementStatuses` arrays with `{value, label, tone}` shape. Any new state / mode / product type starts here.
- **Operator-tunable values** — `server/src/lib/systemConfig.ts` + `SystemConfig` table. Holds `defaultPageSize`, `maxPageSize`, `lowStockThreshold` (plus the existing M3 auth knobs). Admins edit these through `PUT /api/admin/config/{key}`; defaults fall back to the registry constants when the row is absent or zero.

The frontend reads both from `GET /api/config/registry` (no auth — public read-only). Response shape (`ConfigRegistry` in OpenAPI):

```json
{
  "productTypes":      [{ "value": "邀请码", "label": "邀请码", "deliveryModes": ["instant_inventory", "manual_service"] }, ...],
  "deliveryModes":     [{ "value": "instant_inventory", "label": "即时库存发货", "tone": "success" }, ...],
  "orderStatuses":     [{ "value": "pending", "label": "待处理", "tone": "warning" }, ...],
  "settlementStatuses":[{ "value": "pending", "label": "待结算", "tone": "warning" }, ...],
  "pagination":        { "defaultPageSize": 20, "maxPageSize": 100 },
  "inventory":         { "lowStockThreshold": 5 }
}
```

The UI contract (`docs/operations/m6-gemini-ui-contract.md`) requires every status label and tone to be read from this payload — no hardcoded "已交付" / "待处理" / "争议中" strings in `src/pages/*` or `src/components/*`.

Inspection cheatsheet:

```bash
# Live registry
curl -fsS http://localhost:3000/api/config/registry | jq .

# Operator-tunable values (auth required)
curl -fsS http://localhost:3000/api/admin/config -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Update a value, e.g. raise the low-stock threshold to 10
curl -fsS -X PUT http://localhost:3000/api/admin/config/lowStockThreshold \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"value": 10}'
```

## 36. M6 Smoke Checklist

Run before A0 opens the PR from `integration/m6-rc` to `master`, and after every promote / rollback that touches the M6 surface. Tick items in order — the later checks assume earlier ones passed.

### 36.1 Build + tests

```bash
cd "$REPO_ROOT"
npm run build                                                 # frontend tsc + vite
cd server && npm run build && cd ..                           # backend tsc
cd server && TEST_DATABASE_URL='postgresql://monexus:<dev-password>@localhost:5432/monexus_test' npm test && cd ..
```

All three must be green. The server test suite includes the fulfillment state machine, delivery privacy, merchant ops, and registry coverage.

### 36.2 Delivery privacy boundary

```bash
USER_TOKEN='<bearer-of-buyer>'
MERCHANT_TOKEN='<bearer-of-merchant-who-owns-the-product>'
ADMIN_TOKEN='<bearer-of-admin>'
BASE=http://localhost:3000
ORDER_ID=<order-id-with-delivered-content>

# User list: no content
curl -fsS "$BASE/api/orders" -H "Authorization: Bearer $USER_TOKEN" | jq '.[0].delivery'

# User detail: content present
curl -fsS "$BASE/api/orders/$ORDER_ID" -H "Authorization: Bearer $USER_TOKEN" | jq '.delivery'

# Merchant list + detail: no content in either
curl -fsS "$BASE/api/merchant/orders"             -H "Authorization: Bearer $MERCHANT_TOKEN" | jq '.items[0].delivery'
curl -fsS "$BASE/api/merchant/orders/$ORDER_ID"  -H "Authorization: Bearer $MERCHANT_TOKEN" | jq '.delivery'

# Admin list: no content; admin detail: content present
curl -fsS "$BASE/api/admin/orders"             -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.[0].delivery'
curl -fsS "$BASE/api/admin/orders/$ORDER_ID"  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.delivery'
```

Pass: only user-detail and admin-detail responses include `delivery.content`. Fail: stop and re-test — this is the A1 invariant.

### 36.3 Instant inventory still works

Pick an active `instant_inventory` product with `availableStock > 0`, redeem it as a normal user:

```bash
curl -fsS -X POST "$BASE/api/orders" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"productId": <id>}' | jq .
```

Pass criteria: response `status="delivered"`, `deliveryMode="instant_inventory"`, `deliveryContent` populated, `balanceAfter` decreased by `price`. DB side: a fresh `PointLog`, a `Settlement(pending)` if the product has a merchant, `stock` decremented, an `InventoryItem` flipped to `sold`.

### 36.4 Manual service full lifecycle

Pick or create a `manual_service` product, then walk the state machine end-to-end:

```bash
# 1) User redeem → pending
ORDER_ID=$(curl -fsS -X POST "$BASE/api/orders" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"productId": <manual-id>}' | jq -r .orderId)

# 2) Merchant start → processing
curl -fsS -X POST "$BASE/api/merchant/orders/$ORDER_ID/fulfillment/start" \
  -H "Authorization: Bearer $MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"publicNote":"handling now"}'

# 3) Merchant deliver → delivered
curl -fsS -X POST "$BASE/api/merchant/orders/$ORDER_ID/fulfillment/deliver" \
  -H "Authorization: Bearer $MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"deliveryContent":"<credential>","publicNote":"done"}'

# 4) User dispute → disputed (optional)
curl -fsS -X POST "$BASE/api/orders/$ORDER_ID/dispute" -H "Authorization: Bearer $USER_TOKEN"

# 5) Merchant respond → resume back to processing OR close
curl -fsS -X POST "$BASE/api/merchant/orders/$ORDER_ID/fulfillment/respond-dispute" \
  -H "Authorization: Bearer $MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"resolution":"close","publicNote":"refunded out of band"}'

# 6) User close (from delivered or disputed)
curl -fsS -X POST "$BASE/api/orders/$ORDER_ID/close" -H "Authorization: Bearer $USER_TOKEN"
```

Pass: each response carries the new status and an updated `availableActions`. The user detail's `timeline` has one event per transition. The merchant detail's `statusEvents` mirrors the same events with `actorRole` set correctly.

### 36.5 Settlement gating

```bash
curl -fsS "$BASE/api/merchant/settlements" -H "Authorization: Bearer $MERCHANT_TOKEN" | jq '.[0:3]'
```

Pass: every row carries `payable` (boolean) and `blockReason` (string or null). Rows linked to `disputed` / `pending` / `processing` orders must have `payable=false` and a non-null reason. Rows linked to `delivered` / `closed` orders must have `payable=true` and `blockReason=null`.

Then try to batch-settle a `disputed` row:

```bash
curl -fsS -X POST "$BASE/api/admin/settlements/batch-settle" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"settlementIds":[<id-of-disputed-row>]}'
```

Pass: `400 BAD_REQUEST` with body `存在不可结算的记录`. The settlement must remain `pending` in the DB.

### 36.6 Merchant product list — filters + low stock

```bash
curl -fsS "$BASE/api/merchant/products?page=1&pageSize=20&q=节点&deliveryMode=instant_inventory&lowStock=true" \
  -H "Authorization: Bearer $MERCHANT_TOKEN" | jq '.items[:3], .total, .page, .pageSize'
```

Pass: response is an envelope (`{items,total,page,pageSize}`), each item carries `availableStock`, `lowStock`, `deliveryMode`. With `lowStock=true`, only rows where `deliveryMode=instant_inventory` and `availableStock <= lowStockThreshold` come back.

### 36.7 Inventory import — preview then commit

```bash
# Preview: identifies empty lines, in-request dupes, existing dupes
curl -fsS -X POST "$BASE/api/merchant/products/<id>/inventory/preview" \
  -H "Authorization: Bearer $MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"abc\n\nabc\ndef"}' | jq .

# Commit: rejects entire batch if dupes remain
curl -fsS -X POST "$BASE/api/merchant/products/<id>/inventory" \
  -H "Authorization: Bearer $MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"abc\n\nabc\ndef"}'
```

Pass: preview returns `emptyRows=1`, `duplicateRows=1`, `validRows=2`, `canImport=false`. Commit returns `400 VALIDATION_ERROR` with `duplicateRows=...` / `existingDuplicateRows=...` rows under `details`. After cleaning the input (`{"text":"def"}` only), commit returns `imported=1` and `product.stock` increments by 1.

### 36.8 Registry consumption

```bash
curl -fsS "$BASE/api/config/registry" | jq 'keys'
```

Pass: keys include `productTypes`, `deliveryModes`, `orderStatuses`, `settlementStatuses`, `pagination`, `inventory`. Then load the merchant order list page in a browser and verify every status pill renders with its registry-driven `tone` (e.g. `disputed` → danger, `delivered` → success). No raw Chinese label is hardcoded in `src/components/*` — `rg -n '已交付|待处理|争议中|已关闭' src` should return nothing.

## 37. M6 Failure Handling

### 37.1 Invalid state transition

Symptom: client gets `400 BAD_REQUEST` with body `非法订单状态流转: <from> -> <to>`.

Diagnosis:

1. Check the current `Order.status` directly in the DB.
2. Cross-check against `legalTransitions` in `server/src/modules/orders/fulfillment.ts`.
3. If the UI offered the action, the merchant detail's `availableActions` was either ignored or stale — `availableActions` is the authoritative button-enable signal. File a frontend bug, not a backend one.

Recovery: no action needed on the order. The state is unchanged because the transition is wrapped in a Prisma transaction and aborted before any side effect.

### 37.2 Stuck `pending` / `processing`

Symptom: a `manual_service` order has been `pending` or `processing` for longer than the merchant SLA, no merchant action.

Diagnosis:

```bash
psql "$DATABASE_URL" -c "
  SELECT o.id, o.status, o.\"createdAt\", o.\"merchantId\", m.name AS merchant_name
  FROM \"Order\" o
  LEFT JOIN \"Merchant\" m ON m.id = o.\"merchantId\"
  WHERE o.status IN ('pending','processing')
    AND o.\"createdAt\" < NOW() - INTERVAL '24 hours'
  ORDER BY o.\"createdAt\" ASC LIMIT 50;
"
```

Recovery (operator path):

1. Reach out to the merchant (audit + ban or DM via your operator channel — not in scope of this runbook).
2. If the merchant is unreachable, an admin can step in via DB direct transition. The admin path **must** also write an `OrderStatusEvent` so the timeline stays consistent. Until a dedicated admin route exists, do this through a manual `psql` transaction:

   ```sql
   BEGIN;
   UPDATE "Order" SET status='closed' WHERE id=<orderId>;
   INSERT INTO "OrderStatusEvent" ("orderId","actorRole","fromStatus","toStatus","action","publicNote","createdAt")
     VALUES (<orderId>, 'admin', '<from>', 'closed', 'admin.manual.close', '<reason>', NOW());
   COMMIT;
   ```

3. Reverse any settlement state if needed (e.g. refund points to user via `POST /api/admin/users/<userId>/adjust`). Refunds inside an admin-driven close are a manual decision — there is no automatic credit reversal in M6.

### 37.3 Disputed order resolution

Symptom: `disputed` order with both parties refusing to act.

Decision tree:

- Buyer was wrong → merchant calls `respond-dispute` with `resolution=close`. Settlement stays payable (because `closed` is payable).
- Merchant was wrong → admin issues a `POST /api/admin/users/<userId>/adjust` refund and merchant calls `respond-dispute` with `resolution=close`. The settlement remains payable on the merchant's side; the admin refund is a separate `PointLog` entry against the user.
- Need a third-party hold → leave the order in `disputed`. Settlements linked to it remain `payable=false` until resolved. Do not force-close just to unblock a payout.

### 37.4 Blocked settlement

Symptom: `POST /api/admin/settlements/batch-settle` returns `400` `存在不可结算的记录`.

Diagnosis:

```bash
curl -fsS "$BASE/api/admin/settlements?status=pending" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.[] | select(.id == <id>)'
```

If `status != pending`, the row already settled — drop it from the batch. Otherwise inspect the linked order:

```bash
psql "$DATABASE_URL" -c "SELECT id, status FROM \"Order\" WHERE id=<orderId>;"
```

If the order is `pending` / `processing` / `disputed`, the gate is correct — wait for fulfillment to finish or for the dispute to resolve. Do not bypass the gate with raw SQL; settlement reconciliation depends on the order-state invariant.

### 37.5 Bad registry / system config value

Symptom: frontend cannot load `/api/config/registry`, or pagination / low-stock behavior looks wrong.

Diagnosis ladder:

1. `curl -fsS http://localhost:3000/api/config/registry` — if 5xx, the backend cannot reach the `SystemConfig` table; jump to §10 (Postgres connection).
2. `curl -fsS "$BASE/api/admin/config" -H "Authorization: Bearer $ADMIN_TOKEN" | jq .` — confirm `defaultPageSize`, `maxPageSize`, `lowStockThreshold` are sane positive integers.
3. Repair via the admin API rather than DB direct:

   ```bash
   curl -fsS -X PUT "$BASE/api/admin/config/defaultPageSize" \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"value": 20}'
   ```

   `getSystemConfigValue` falls back to the `businessRegistry` defaults when a config row is absent or zero (20 / 100 / 5), so the system continues to work even if a row is deleted.

If the issue is a missing `productTypes` / `orderStatuses` entry (e.g. a product carries a type that isn't in the registry), fix the registry in code — do not insert ad-hoc rows in `SystemConfig`. The labels / tones layer is intentionally code-only so that PR review catches drift.

### 37.6 Where this links

- API contract: `docs/operations/openapi-m6-note.md` (OpenAPI `v1.4.0`).
- UI contract for Gemini: `docs/operations/m6-gemini-ui-contract.md`.
- Privacy boundary rationale: §35.3 above + the A1 commit message on `integration/m6-rc`.
- M5 deployment / rollback / smoke continues to apply unchanged (§§27-33). M6 does not require a separate rollback flow — a code revert + the M5 rollback workflow is sufficient because no destructive schema change was introduced (additive only: new tables for `OrderStatusEvent`, new columns on `Product` / `Order`).
