# CMI Owner / PAR handoff

Scope: `G-CAT` / `MERCH-PR-010` release rehearsal. State at handoff:
**Owner/PAR recorded · staging canary PASS · rollback PASS · production promotion not authorized**.

## Owner checklist

- [x] Release Owner: `amo0114` (GitHub repository owner, workflow actor, and
  protected `staging` Environment approver). Backup/DB owner: **N/A for this
  staging-only artifact rehearsal; production DB ownership requires a separate PAR**
- [x] Support/on-call owner and escalation route: **N/A for the isolated staging
  exercise; production escalation is not asserted by this evidence**
- [x] Baseline commit SHA and staging run URL: `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c`, [workflow run 31877359120](https://github.com/amo0114/MoNexus/actions/runs/31877359120)
- [x] Window/time zone and change record: 2026-08-16 05:30–05:43 UTC
  (`2026-08-16 13:30–13:43 Asia/Shanghai`), workflow run
  [31929179740](https://github.com/amo0114/MoNexus/actions/runs/31929179740)
- [x] Known-good staging release SHA: `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c` (deployment `5919176861`, status `success`)
- [x] Canary account/merchant fixture and operator: disposable staging fixture
  created by the workflow's stage 4; operator `amo0114`/GitHub Actions. Fixture
  cleanup reports `CLEAN`.
- [x] Stop authority / rollback approver: `amo0114` (same GitHub Owner; required reviewer on `staging` Environment)
- [x] No production code/schema/migration change is part of this handoff; the
  rehearsal restored the known-good staging baseline.

## PAR checklist

- [x] PAR authorization for the staging exercise is recorded in the current task by
  the repository Owner; GitHub `staging` Environment required reviewer `amo0114` is
  configured (rule `62780483`), and the approval record for run `31929179740` says
  "Owner-approved staging realtime rehearsal per current PAR authorization."
- [x] Dry-run output reviewed; `31885929935` produced no SSH/host change.
- [x] Staging secrets, pinned known-hosts, and health URL were verified by the
  workflow without exposing values.
- [x] Baseline `/api/health/live`, `/api/health/ready`, and public readiness were
  recorded before and after the rehearsal.
- [x] CMI canary assertions and thresholds are attached below: 100 API-2xx to
  merchant-order-DOM samples, zero failures, `p95_ms=794`, plus flag-off fallback,
  history polling, and cleanup PASS.
- [x] Alert channels and response SLA are **N/A for this isolated staging run**;
  no production alert claim is made and a production PAR is still required.
- [x] Evidence retention is the workflow artifact named below and the linked run
  record; no secret/token is retained.

## Canary / monitoring index

Monitor the staging public health URL and live/ready endpoints; inspect application
logs, Sentry release context, and the alert labels `backend-error-p1`,
`release-regression-p1`, `api-latency-p2`, and `frontend-vitals-p2` (routing source:
`docs/operations/alert-routing.md` and `docs/operations/sentry-alert-rules.md`).
The completed staging record contains the baseline, canary interval, request/error
rate, latency, and business smoke outcome. Any production threshold not agreed in a
future PAR remains a gate, not an implicit pass.

## Rollback index

Use `docs/operations/rollback-runbook.md` for the decision tree and migration policy.
For isolated staging, the workflow requires `release_action=rollback`, an existing
40-character `target_release`, and `dry_run=false` only after approval. Confirm the
target release marker exists and rerun health/smoke after switching. A migration that
already applied is not undone by artifact rollback; freeze, restore-test in staging,
and prefer a forward fix.

## Handoff record

| Item | Evidence / value | Status |
| --- | --- | --- |
| Owner + PAR | `amo0114`; staging Environment rule `62780483`; approval for [run 31929179740](https://github.com/amo0114/MoNexus/actions/runs/31929179740) | **Recorded / approved** |
| Resolved SHA | `440337b9f68e9c288f409e3524b4ff8b0ee301ee` / [run 31929179740](https://github.com/amo0114/MoNexus/actions/runs/31929179740) | **Rehearsal PASS** |
| Baseline health | public live/ready probes before and after; final `ready`, DB/config/Redis `ok`, realtime `disabled` | **PASS** |
| CMI canary | disposable fixture; 100 API-2xx-to-merchant-DOM samples; p50 790 / p95 794 / p99 795 / max 795 ms; zero failures | **PASS** |
| Monitoring | `logs.txt` Nginx/app/Caddy PASS; external alert/Sentry observation not part of isolated run | **Staging log PASS; production monitoring N/A** |
| Rollback readiness | known-good `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c`; approver `amo0114`; `rollback.txt` PASS; fixture cleanup CLEAN | **PASS** |
| Final disposition | Rehearsal restored baseline; no production promotion performed | **Staging PASS / production not authorized** |

The companion rehearsal document and artifact provide the external staging Owner,
canary, latency, and rollback proofs. They do not authorize production promotion or
substitute for a future production monitoring/restore PAR.
