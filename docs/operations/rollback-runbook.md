# Rollback Runbook

Review date: 2026-05-14. Scope: M5 production rollback for the self-hosted nginx + systemd/PM2 target. This runbook covers artifact rollback, frontend rollback, server rollback, env rollback, failed health checks, Prisma migration fallback, backup restore rehearsal, forward fix policy, and escalation handoff.

## Dependency Note

This branch is based on Wave 1. `docs/operations/gray-release.md` is not present here yet. The commands below use the A1 release directory and `current` symlink model from `docs/operations/deployment-target.md`. A5 合入后由 A8/协调员补齐 gray release 引用.

## Rollback Decision Tree

1. Is the incident tied to the latest deploy artifact?
   - Yes: roll back `current` to the last known-good release and smoke health.
   - No: continue diagnosis; do not switch releases just to clear an alert.
2. Is the impact frontend-only?
   - Yes: artifact rollback can use the previous release's `frontend` directory without database action.
   - No: treat as server rollback and include backend health checks.
3. Did the bad deploy run a Prisma migration?
   - Yes: do not assume schema rollback. Freeze further deploys, rehearse backup restore in staging, and prefer a forward fix.
   - No: release symlink rollback is the default recovery path.
4. Are health checks failing after rollback?
   - Yes: keep current on the known-good release, inspect runtime env, process supervisor, nginx, logs, and database readiness.
   - No: keep monitoring Sentry and alert routing until the next alert window stays clear.

## Identify Candidate Artifacts

```bash
ssh <deploy-user>@<host> '
  set -euo pipefail
  cd /opt/monexus
  ls -1 releases | tail -n 10
  readlink -f current
  test -f current/frontend/BUILD_INFO.json
  cat current/frontend/BUILD_INFO.json
'
```

Use `BUILD_INFO.json`, deploy workflow history, and Sentry release context to identify:

- bad release SHA
- last known-good release SHA
- whether the bad release ran a migration
- whether the incident maps to `backend-error-p1`, `release-regression-p1`, `api-latency-p2`, or `frontend-vitals-p2`

## Artifact / Frontend Rollback

Use this path when the bad release affects static assets, routing, or client-side behavior and the backend is healthy.

```bash
GOOD=<known-good-sha>
ssh <deploy-user>@<host> "
  set -euo pipefail
  cd /opt/monexus
  test -d releases/${GOOD}/frontend
  ln -sfn /opt/monexus/releases/${GOOD} current
  sudo nginx -t
  sudo systemctl reload nginx
"
```

Smoke:

```bash
curl -fsS https://<frontend-origin>/BUILD_INFO.json
curl -fsS https://<api-origin>/api/health/live
```

If the backend process is not restarted, verify that the frontend rollback did not point to an incompatible API contract. If it did, switch to full server artifact rollback.

## Server Artifact Rollback

Use this path when API errors, latency, or release regression alerts point to the backend artifact.

Systemd host:

```bash
GOOD=<known-good-sha>
ssh <deploy-user>@<host> "
  set -euo pipefail
  cd /opt/monexus
  test -d releases/${GOOD}/server/dist
  ln -sfn /opt/monexus/releases/${GOOD} current
  sudo systemctl restart monexus-api
  sudo nginx -t
  sudo systemctl reload nginx
"
```

PM2 host:

```bash
GOOD=<known-good-sha>
ssh <deploy-user>@<host> "
  set -euo pipefail
  cd /opt/monexus
  test -d releases/${GOOD}/server/dist
  ln -sfn /opt/monexus/releases/${GOOD} current
  cd current/server
  pm2 reload monexus-api || pm2 start dist/main.js --name monexus-api
  sudo nginx -t
  sudo systemctl reload nginx
"
```

Smoke:

```bash
curl -fsS https://<api-origin>/api/health/live
curl -fsS https://<api-origin>/api/health/ready
curl -fsS https://<frontend-origin>/BUILD_INFO.json
```

## Env Rollback

Runtime env lives on the deploy host and GitHub environment values are inventoried in `docs/operations/secrets-management.md`. Do not paste secret values into the repo or incident thread.

1. Identify the exact env change and owner: backend runtime, deploy workflow, PostgreSQL, JWT, SMTP, storage, metrics, backup, Sentry, or alert routing.
2. Revert the host env file or GitHub Environment variable/secret to the last known-good value.
3. Restart only the component that consumes the env:
   - backend runtime: restart `monexus-api`
   - frontend `VITE_*`: rebuild and deploy a new candidate/artifact
   - deploy-only value: rerun the deploy workflow dry run first
4. Smoke `/api/health/live`, `/api/health/ready`, and the affected workflow.
5. Record the old and new secret version identifiers, not the secret value.

## Failed Health Check Handling

If `/api/health/live` fails:

1. Check process supervisor state: `sudo systemctl status monexus-api` or `pm2 status`.
2. Inspect recent logs for boot errors, missing env, port conflicts, or unhandled exceptions.
3. Keep nginx pointed at the last known-good `current` release while investigating.

If `/api/health/ready` fails:

1. Treat database or config readiness as degraded, not necessarily a dead process.
2. Check PostgreSQL connectivity from the host and confirm the runtime `DATABASE_URL` points to the intended database.
3. Do not restart-loop the API if readiness is failing because the database is unavailable.

If frontend `BUILD_INFO.json` does not match the intended release:

1. Confirm the `current` symlink target.
2. Reload nginx after fixing the symlink.
3. Clear CDN cache only after verifying the host serves the expected artifact.

## Prisma Migration Failure Fallback

There is no promised `prisma migrate down` production path. Do not handwrite a down migration during an incident. Do not run `prisma migrate down` or equivalent ad hoc schema reversal commands in production.

If `prisma migrate deploy` fails before applying a migration:

1. Keep `current` on the previous release.
2. Fix migration packaging or database connectivity in a new candidate.
3. Re-run staging first.

If a migration applied and the app is broken:

1. Stop promoting or redeploying until the DBA/Ops owner is present.
2. Keep a fresh production backup before any manual database action.
3. Restore the latest backup into staging using the restore rehearsal below.
4. Validate whether data loss, schema incompatibility, or a forward fix is safer.
5. Prefer a forward fix migration and application patch over destructive rollback.

## Backup Restore Rehearsal

Never restore over production as the first step. Rehearse in staging:

```bash
RESTORE_TARGET_URL='<staging-restore-url>'
BACKUP=monexus-backup-YYYYMMDDTHHMMSSZ.sql.gz

psql "$RESTORE_TARGET_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c "$BACKUP" | psql "$RESTORE_TARGET_URL"
psql "$RESTORE_TARGET_URL" -c 'SELECT COUNT(*) FROM "User";'
psql "$RESTORE_TARGET_URL" -c 'SELECT COUNT(*) FROM "PointLog";'
```

After restore, point a staging backend at `RESTORE_TARGET_URL`, run health checks, and smoke login, redeem, merchant order handling, and admin views before considering any production database recovery.

## Forward Fix Policy

Use a forward fix when:

- the release artifact can be patched faster than restoring data
- a migration already changed production schema
- rollback would create more incompatibility than it removes
- alerts are P2 and the system is still serving core flows

Forward fix steps:

1. Create a small patch commit.
2. Build and publish a candidate release.
3. Smoke in staging or on the candidate host path.
4. Promote only after the first responder and owner agree.
5. Keep the incident thread open until Sentry and health checks stay green.

## Escalation / Alert Routing Handoff

Use `docs/operations/sentry-alert-rules.md` for rule definitions and labels. A4 owns final routing details; if `docs/operations/alert-routing.md` is not present yet, use this temporary mapping:

| Alert label | Severity | First responder |
| --- | --- | --- |
| `backend-error-p1` | P1 | Backend on-call |
| `release-regression-p1` | P1 | Release manager |
| `api-latency-p2` | P2 | Backend on-call |
| `frontend-vitals-p2` | P2 | Frontend on-call |

P1 incidents require an urgent Slack/email route and an assigned owner. P2 incidents require team notification and monitoring for the next alert window. A8 should replace this temporary handoff with a link to A4's routing procedure after Wave 2 is merged.
