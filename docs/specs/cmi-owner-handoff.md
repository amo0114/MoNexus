# CMI Owner / PAR handoff

Scope: `G-CAT` / `MERCH-PR-010` release rehearsal. State at handoff:
**Owner Pending · PAR Pending · Canary Pending · Rollback Gate Pending**.

## Owner checklist

- [ ] Release Owner: __________________  Backup/DB owner: __________________
- [ ] Support/on-call owner and escalation route: __________________
- [ ] Exact commit SHA and staging run URL: __________________
- [ ] Window/time zone and change record: __________________
- [ ] Known-good staging release SHA: __________________
- [ ] Canary account/merchant fixture and operator: __________________
- [ ] Stop authority and rollback approver: __________________
- [ ] No production code/schema/migration change is part of this handoff.

## PAR checklist

- [ ] PAR approves this SHA, staging environment, duration, and operator.
- [ ] Dry-run output reviewed; `dry_run=true` produced no SSH/host change.
- [ ] Staging secrets, pinned known-hosts, and health URL verified without exposing values.
- [ ] Baseline `/api/health/live`, `/api/health/ready`, and public readiness recorded.
- [ ] CMI smoke assertions and canary thresholds are attached to the PAR.
- [ ] Alert channels and response SLA are known to Owner and support.
- [ ] Evidence retention location and incident record are linked.

## Canary / monitoring index

Monitor the staging public health URL and live/ready endpoints; inspect application
logs, Sentry release context, and the alert labels `backend-error-p1`,
`release-regression-p1`, `api-latency-p2`, and `frontend-vitals-p2` (routing source:
`docs/operations/alert-routing.md` and `docs/operations/sentry-alert-rules.md`).
The Owner must record baseline, canary interval, request/error rate, latency, and
business smoke outcome. Any threshold not agreed in the PAR is a gate, not an
implicit pass.

## Rollback index

Use `docs/operations/rollback-runbook.md` for the decision tree and migration policy.
For isolated staging, the workflow requires `release_action=rollback`, an existing
40-character `target_release`, and `dry_run=false` only after approval. Confirm the
target release marker exists and rerun health/smoke after switching. A migration that
already applied is not undone by artifact rollback; freeze, restore-test in staging,
and prefer a forward fix.

## Handoff record (complete after execution)

| Item | Evidence / value | Status |
| --- | --- | --- |
| Owner + PAR | link, approver, window | Pending |
| Resolved SHA | 40-char SHA / workflow URL | Pending |
| Baseline health | timestamps and responses | Pending |
| CMI canary | fixture, duration, thresholds, result | Pending |
| Monitoring | alerts/Sentry/log links | Pending |
| Rollback readiness | known-good SHA + approver | Pending |
| Final disposition | promote / rollback / forward fix | Pending |

Local command validation in the companion rehearsal document is not a substitute for
these external Owner, canary, staging, or rollback proofs.
