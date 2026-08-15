# CMI release rehearsal — G-CAT / MERCH-PR-010

Status: baseline deployed; live canary, rollback rehearsal, and external performance gates remain **Pending**.
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

The exact-SHA dry-run was executed as [workflow run 31885572435](https://github.com/amo0114/MoNexus/actions/runs/31885572435)
for `0b4fb2a8f3aedb188b55a9aeb0cdb3b2f174169f`; both jobs passed and the release
job recorded that no SSH connection or staging-host change occurred. The first
live attempt was [workflow run 31885609141](https://github.com/amo0114/MoNexus/actions/runs/31885609141)
with Owner approval and the required confirmation, but it stopped at the first
Caddy host step because the remote deploy user lacked passwordless sudo. No
application release, fixture, collector, or rollback ran. Commit `3710138`
adds the idempotent root repair `deploy/staging/install-caddy-sudoers.sh`; a
root/operator must run that repair on the staging host before a new live run.

## Rehearsal gates (all explicit)

- [x] Owner named in the release record: `amo0114`; support/on-call contact and exact window remain Pending.
- [x] PAR authorization is recorded in `docs/specs/cmi-owner-handoff.md`; exact rehearsal target/window approval remains Pending.
- [ ] Staging secrets/known-host key and `STAGING_HEALTHCHECK_URL` are present; no
  secret values enter logs or this repository.
- [ ] Host Caddy sudo delegation is installed by a root/operator; the prior live
  run proved the workflow fails closed when `sudo -n` is unavailable.
- [ ] Baseline health passes before exercise: public health URL plus
  `/api/health/live` and `/api/health/ready` where exposed.
- [ ] Canary account and merchant test fixture are identified; canary percentage,
  duration, success/error/latency thresholds, and stop authority are written down.
- [x] Known-good staging release SHA `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c` is recorded before the live exercise.
- [ ] Rollback approver and exact target SHA are recorded; database migration state
  is checked before choosing artifact rollback.
- [ ] Evidence bundle is retained: workflow run URL, resolved SHA, health results,
  CMI business smoke results, alerts, and decision timestamps.

## Execution and stop conditions

1. Owner records baseline and opens the PAR. Keep external Owner/canary/rollback
   status Pending until the corresponding evidence exists.
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
The baseline staging workflow, Compose up/smoke, and public readiness are now
executed in run 31877359120. Still not executed: CMI canary, realtime collector,
alert observation, backup restore, and rollback. Those gates remain Pending.
