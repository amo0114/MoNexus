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
