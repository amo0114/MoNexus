# Gray Release Workflow

Review date: 2026-05-14. Scope: M5 release switching for the self-hosted nginx + systemd/PM2 deployment target. This keeps release state in `/opt/monexus/releases`, `/opt/monexus/candidate`, and `/opt/monexus/current`; it does not add an application feature flag platform and does not change business code.

## Release Model

```text
/opt/monexus/
  candidate -> /opt/monexus/releases/<candidate-sha>
  current   -> /opt/monexus/releases/<active-sha>
  releases/
    <sha>/
      frontend/
      server/
```

- `deploy_candidate` builds the selected ref, uploads artifacts, extracts a release directory, installs production server dependencies, runs `prisma migrate deploy`, and updates `candidate`.
- `promote` switches `current` to `candidate` or to the provided `target_release`, restarts the runtime, and reloads nginx.
- `rollback` switches `current` to an existing `target_release`, restarts the runtime, and reloads nginx. It never runs a migration.
- `dry_run` remains `true` by default. With dry run enabled, the workflow renders the plan but does not open SSH or change the host.

## Candidate Publish Steps

1. Open GitHub Actions -> **Production Deploy** -> **Run workflow**.
2. Select `release_action=deploy_candidate`.
3. Select `ref` as `master`, a signed release tag, or an exact commit SHA.
4. Keep `dry_run=true` and confirm the plan shows `candidate_release=<resolved commit>` and `migration=will run during deploy_candidate only`.
5. Re-run with `dry_run=false` after confirming GitHub environment values are present.
6. Confirm the host now has:

```bash
ssh <deploy-user>@<host> '
  set -euo pipefail
  cd /opt/monexus
  readlink -f candidate
  test -f candidate/frontend/BUILD_INFO.json
  test -f candidate/server/dist/main.js
'
```

## Smoke Gate

The default candidate does not receive public traffic. Before promote:

1. Inspect `candidate/frontend/BUILD_INFO.json` and confirm the commit matches the workflow's `DEPLOY_COMMIT`.
2. Confirm `candidate/server/dist/main.js` exists and production dependencies installed without errors.
3. Confirm `prisma migrate deploy` completed during `deploy_candidate`. If it failed, do not promote; follow the migration fallback path in the rollback runbook.
4. If the host has an operator-managed candidate port, start the candidate manually against staging-safe env and smoke `/api/health/live` plus `/api/health/ready`.
5. If no candidate port exists, promote only during the release window and run the post-switch health check immediately.

## Promote / Switch Command

Use the workflow for the normal path:

```text
release_action=promote
target_release=<candidate-sha or empty to use candidate symlink>
dry_run=false
```

Equivalent host command:

```bash
ssh <deploy-user>@<host> '
  set -euo pipefail
  cd /opt/monexus
  release="$(basename "$(readlink -f candidate)")"
  ln -sfn "/opt/monexus/releases/${release}" current
  sudo systemctl restart monexus-api
  sudo nginx -t
  sudo systemctl reload nginx
'
```

For PM2 hosts:

```bash
ssh <deploy-user>@<host> '
  set -euo pipefail
  cd /opt/monexus
  release="$(basename "$(readlink -f candidate)")"
  ln -sfn "/opt/monexus/releases/${release}" current
  cd current/server
  pm2 reload monexus-api || pm2 start dist/main.js --name monexus-api
  sudo nginx -t
  sudo systemctl reload nginx
'
```

## Rollback Command

Use the workflow:

```text
release_action=rollback
target_release=<known-good-sha>
dry_run=false
```

Equivalent host command:

```bash
ssh <deploy-user>@<host> '
  set -euo pipefail
  cd /opt/monexus
  test -d releases/<known-good-sha>/server/dist
  ln -sfn /opt/monexus/releases/<known-good-sha> current
  sudo systemctl restart monexus-api
  sudo nginx -t
  sudo systemctl reload nginx
'
```

Rollback does not run `prisma migrate deploy`. If the bad release applied a schema migration, stop and use the A6 rollback runbook for backup restore rehearsal or forward fix.

## nginx / systemd / PM2 Notes

- nginx should keep serving `/opt/monexus/current/frontend` and proxying `/api/` to the single active backend process. No nginx config change is required for the default mechanism.
- systemd remains the preferred supervisor: `sudo systemctl restart monexus-api` after promote or rollback.
- PM2 is acceptable when the host already standardizes on it; reload `monexus-api` from `/opt/monexus/current/server`.
- Optional weighted nginx upstream or a second backend port can be added later for true traffic splitting, but it is not part of the M5 default because it requires extra process management and smoke routing.

## Handoff to A6 Rollback Runbook

A6 owns the full rollback decision tree, failed health check handling, migration fallback, backup restore rehearsal, and escalation handoff. This file provides the release action names and host switch commands A6 should reference once the gray release branch is merged.
