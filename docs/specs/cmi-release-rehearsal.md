# CMI release rehearsal — G-CAT / MERCH-PR-010

Status: **PASS for the staging-only rehearsal**. The immutable target was exercised,
100 canary/latency samples passed, fallback and code rollback passed, and the known-good
baseline was restored. Production promotion, production traffic, and backup-restore
remain outside this rehearsal.
This is a release/operator document only. It does not add a feature flag, production
traffic split, schema change, or migration.

## Scope and source of truth

The rehearsal covers the CMI merchant path identified as `G-CAT` / `MERCH-PR-010`,
using the isolated staging Compose workflow in `.github/workflows/staging-deploy.yml`.
The legacy `candidate`/`current` symlink procedure in `docs/operations/gray-release.md`
is not a production alternative: that document explicitly scopes it to nginx +
systemd/PM2 hosts, while the current production route is Compose. Recovery decisions,
migration caution, health checks, and backup restore rehearsal follow
`docs/operations/rollback-runbook.md`.

## Local dry-run / command validation evidence

The following validation was performed locally on 2026-08-15. It is static/local
validation only; it does not replace the live workflow evidence below.

```bash
git diff --check
bash -n scripts/staging-compose.sh
bash -n scripts/run-notification-realtime-staging-rehearsal.sh
```

Workflow input validation confirmed by inspection: `deploy` and
`realtime_rehearsal` require a 40-character lowercase SHA; `rollback` requires a
40-character `target_release`; live realtime rehearsal requires the literal
`REHEARSE_AND_ROLL_BACK`; any `dry_run != false` exits before SSH and prints that no
host change occurs (`.github/workflows/staging-deploy.yml`, readiness step).

The safe command matrix for an operator is:

| Action | Inputs | Expected effect |
| --- | --- | --- |
| plan deploy | `release_action=deploy`, exact SHA, `dry_run=true` | Print plan; no SSH/host mutation |
| plan rollback | `release_action=rollback`, known staging SHA, `dry_run=true` | Validate target; no SSH/host mutation |
| live rehearsal | `release_action=realtime_rehearsal`, exact SHA, `dry_run=false`, `confirm_rehearsal=REHEARSE_AND_ROLL_BACK` | Staging-only rehearsal; requires all staging secrets and explicit confirmation |

The plan row is not deployment evidence. A baseline deployment was subsequently
executed as [workflow run 31877359120](https://github.com/amo0114/MoNexus/actions/runs/31877359120)
for immutable SHA `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c`; its successful
staging deployment (`5919176861`) is the known-good rollback target. The live
rehearsal target remains distinct and requires the protected `staging` reviewer.

The exact-SHA dry-run [31885929935](https://github.com/amo0114/MoNexus/actions/runs/31885929935)
and the earlier failed-closed attempt [31885609141](https://github.com/amo0114/MoNexus/actions/runs/31885609141)
remain historical traceability. The latter stopped before application deployment
because the host lacked `sudo -n`; after the reviewed root repair (`603d874`) was
installed on `free-vnic`, the final run above completed successfully.

## Rehearsal gates (all explicit)

- [x] Owner named in the release record: `amo0114`; the protected `staging`
  Environment approval and workflow run are the PAR decision record for the
  2026-08-15 rehearsal window.
- [x] PAR authorization is recorded in `docs/specs/cmi-owner-handoff.md`; the exact
  target SHA, baseline SHA, and workflow run are recorded above.
- [x] Staging secrets, pinned known-host key, and `STAGING_HEALTHCHECK_URL` were
  consumed by the workflow without entering the repository or uploaded artifacts.
- [x] Host Caddy sudo delegation was installed by root on `free-vnic` and the
  workflow's pre-deploy validation passed.
- [x] Baseline health passed before and after the exercise; public `/api/health/live`
  and `/api/health/ready` were checked by the workflow and post-run probe.
- [x] Disposable merchant fixture/canary was created and removed by the workflow;
  100/100 API-2xx-to-merchant-DOM samples passed with `p95_ms=793` and zero failures.
  Stop authority was `amo0114`; the workflow's explicit stop conditions are listed
  below.
- [x] Known-good staging release SHA `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c` is recorded before the live exercise.
- [x] Rollback approver is `amo0114`; the exact target SHA and successful code rollback
  are recorded in `rollback.txt`, with migration-safe artifact rollback semantics.
- [x] Evidence bundle is retained as the named workflow artifact: workflow URL,
  resolved SHA, health/readiness, CMI canary/latency, logs, rollback, cleanup, and
  timestamps.

## Execution and stop conditions

1. Owner records baseline and opens the PAR. The final run now contains the approved
   Owner/canary/rollback evidence; production promotion still requires a new PAR.
2. Run the dry-run row and review resolved SHA/target. Abort on malformed SHA,
   missing staging values, or an unexpected action.
3. For an authorized staging rehearsal, deploy the immutable SHA, run health checks,
   then exercise the CMI merchant canary (create/read/update the agreed merchant
   object and verify ownership/error boundaries). Do not use production accounts.
4. Stop promotion/canary immediately on health failure, elevated backend errors,
   contract/ownership regression, unacceptable latency, or unexplained data change.
5. If the artifact is the cause and no incompatible migration was applied, rollback
   to the recorded known-good staging SHA. If a migration ran, freeze further deploys,
   rehearse restore in staging, and prefer a forward fix; never invent a production
   down migration (`rollback-runbook.md`, Prisma Migration Failure Fallback).

## Evidence and unresolved items

Design confirmations are the staging-only path, immutable SHA checks, dry-run no-SSH
property, explicit live rehearsal confirmation, health gate, and migration fallback.
The final staging rehearsal is [workflow run 31890663141](https://github.com/amo0114/MoNexus/actions/runs/31890663141)
for immutable SHA `d650014a9d816a9c6c3476d6e6e02861bce208ac`. It was approved by
Owner `amo0114` through the protected `staging` Environment (required-reviewer rule
`62780483`) after root installed the restricted Caddy sudoers rule on `free-vnic`.
The retained artifact is
`notification-realtime-staging-evidence-d650014a9d816a9c6c3476d6e6e02861bce208ac`.

The workflow completed all 12 stages: backend/proxy/frontend ordering, production-like
LISTEN/session gate, realtime flag-on, disposable merchant canary, authenticated SSE
proxy smoke, 100 API-2xx-to-merchant-DOM samples, log-boundary inspection, flag-off
30-second fallback/history, immutable code rollback, fixture cleanup, and environment
finalization. The known-good baseline restored by the workflow was
`4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c`.

The artifact reports `staging-latency.txt` with 100 samples (`p50_ms=790`,
`p95_ms=793`, `p99_ms=797`, `max_ms=810`, zero failures), `rollout.txt` and
`rollback.txt` as `PASS`, `fixture-cleanup.json` as `CLEAN`, and final public
readiness `status=ready` with `notificationRealtime=disabled` after baseline restore.
The only non-assertive line is the informational external log-query note in
`proxy.txt`; the deployed Nginx/app/Caddy boundary check itself is `PASS` in
`logs.txt`.

Unresolved items are limited to production promotion/traffic, a production or
backup-restore exercise, and the incremental frontend bundle baseline. Image2 and
runtime asset/bundle work is explicitly Deferred by AMD-CMI-012 §3.6 and is not a
failure of this staging release rehearsal.
