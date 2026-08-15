# CMI Owner / PAR handoff

Scope: `G-CAT` / `MERCH-PR-010` release rehearsal. State at handoff:
**Owner recorded · PAR reviewer configured · Canary Pending · Rollback Gate Pending**.

## Owner checklist

- [x] Release Owner: `amo0114` (GitHub repository owner and workflow actor). Backup/DB owner: **Pending**
- [ ] Support/on-call owner and escalation route: __________________
- [x] Baseline commit SHA and staging run URL: `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c`, [workflow run 31877359120](https://github.com/amo0114/MoNexus/actions/runs/31877359120)
- [ ] Window/time zone and change record: __________________
- [x] Known-good staging release SHA: `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c` (deployment `5919176861`, status `success`)
- [ ] Canary account/merchant fixture and operator: __________________
- [x] Stop authority / rollback approver: `amo0114` (same GitHub Owner; required reviewer on `staging` Environment)
- [ ] No production code/schema/migration change is part of this handoff.

## PAR checklist

- [x] PAR authorization for the staging exercise is granted in the current task by the repository Owner; GitHub `staging` Environment required reviewer `amo0114` is configured (rule `62780483`). Exact canary target/window remains pending until the live rehearsal approval record exists.
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
| Owner + PAR | `amo0114`; staging Environment rule `62780483`; current task authorization | Recorded; exact target/window Pending |
| Resolved SHA | `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c` / [run 31877359120](https://github.com/amo0114/MoNexus/actions/runs/31877359120) | Baseline PASS |
| Baseline health | workflow smoke + public readiness in [run 31877359120](https://github.com/amo0114/MoNexus/actions/runs/31877359120) | PASS |
| CMI canary | fixture, duration, thresholds, result | Pending |
| Monitoring | alerts/Sentry/log links | Pending |
| Rollback readiness | known-good SHA + approver | Pending |
| Final disposition | promote / rollback / forward fix | Pending |

Local command validation in the companion rehearsal document is not a substitute for
these external Owner, canary, staging, or rollback proofs.
