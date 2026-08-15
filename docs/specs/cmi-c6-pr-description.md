# CMI C6 PR Draft

## Target

- Base: `develop`
- Label: `run-e2e`
- Source branch: `feat/catalog-merch-integration`
- Current evidence baseline: `4ab3de9` (100k benchmark tip; security/audit
  evidence is recorded in the next C5b ledger commit); implementation code
  ancestor under test: `c690025`
- C5b runners: `685d23b`, `495d1a0`, `e279c72`, `e329d1b`, and `1d37d86`

## Summary

This PR integrates the Catalog Operations and Merchandising Governance lanes
after the C4 `develop` merge. It includes the authorized `/api/merchant`
registration mount-order fix, C5a legacy assertion reconciliation, the
catalog-ops CI option-B isolated E2E job, unified Merch admin MFA/audit
hardening, the independent legacy-isHot cleanup fixture, and the final C5b
evidence ledger.

The cross-spec Identity handoff is recorded without merging Identity files into
this branch: `N=f586efd` and `C_ID=2bf77c1` both reach `M_ID=dc9fb306`, Layout
starts at `50b774c`, raw writers close at `0d9f7ce`, and the Identity evidence
handoff is `560d00c`. All required ancestor checks exit 0.

## v0.1.2 Revision

This PR follows the AMD-CMI-012 QA closeout revision: evidence is primarily
recorded at integration/component level, the browser requirement is the
isolated catalog-ops stack, `T-MERCH-ASSET-001` is explicitly Deferred, and
performance numbers are not invented or promoted to P0 acceptance criteria.

## Evidence

- C5b evidence and PAR matrix: [`cmi-c5b-evidence.md`](./cmi-c5b-evidence.md)
- Catalog ledger and gates: `docs/superpowers/specs/2026-08-09-catalog-operations/implement.md`
- Merch ledger and gates: `docs/superpowers/specs/2026-08-09-merchandising-governance/implement.md`
- Identity writer-closure ledger: `docs/superpowers/specs/2026-08-09-identity-profile-sync/implement.md`
- Foundation: 11/11; Catalog backend: 7/7; server: 154 files / 1420 tests;
  root: 49 files / 450 tests; catalog-ops browser: 30/30.
- Dedicated Merch gate: ranking 2 files / 55 tests; points 4 server files /
  56 tests plus 3 UI files / 91 tests; asset gallery 3/3; root/server
  runtime and build green; disposable databases cleaned.
- Root security/public-field targeted suite: 8 files / 117 tests, exit 0.
- Unified CMI server-security gate: 8 focused files / 70 tests, exit 0 on Node
  20.19.5/npm 10.8.2 with the disposable CMI database. It covers runtime MFA
  boundaries for all Merch admin surfaces, bounded AdminLog reasons, public
  fields, PointLog HTTP boundaries, auth/security events, and mail redaction;
  the database was dropped afterward.
- Legacy `Product.isHot` static source audit found no production `isHot: true`
  writes and confirmed public/admin projection stripping. The serial Node
  20.19.5 CMI rerun passed five legacy-hot files (65 tests total), and the
  independent cleanup fixture now records `legacy_is_hot_before=5` →
  `legacy_is_hot_after=0`; `CHK-MERCH-FND-002`/`G-MERCH-PR-003` evidence is
  complete.
- Identity closure: 56/56 logic tests, raw-writer static scan zero, frontend
  build green.
- Local perf/compat: cache 7/7, server build PASS, dashboard benchmark 2/2
  under Node 20.19.5/npm 10.8.2. The disposable 100k-order benchmark reports
  30 samples with summary P95 16.504372 ms and timeseries P95 80.750211 ms.
  The frontend build passes, while the conservative 150 KiB gzip proxy reports
  315.74 KiB and exits non-zero. Staging/production/canary P95 and external
  bundle acceptance remain Pending.
- Release rehearsal and Owner handoff documents pass `bash -n`/local dry-run
  checks, but staging deploy, canary, restore/rollback, and Owner/PAR approval
  remain Pending.

## Deferred

- Image2 concept/runtime asset delivery (`T-MERCH-ASSET-001`, AC-MERCH-025/026,
  CHK-ASSET-001~006, PERF-004) remains Deferred by AMD-CMI-012 and is not
  represented as shipped functionality.
- External performance/bundle acceptance (staging/production/canary P95,
  Owner/PAR rollout, rollback/restore, and an owner-approved incremental
  bundle baseline) remains follow-up work under the existing specs. The local
  100k-order P95 and conservative bundle proxy are recorded but do not close
  those external gates.

## Readiness

This draft is not a ready-to-merge declaration. The remaining Pending gates
are the Owner/PAR handoff review, external staging/canary P95 and
rollout/rollback evidence, the bundle budget exception or remediation, and the
final PR risk/monitoring/rollback handoff. The PR must remain blocked until
those rows are filled and reviewed; all gates without Owner, staging, P95, or
rollback evidence remain Pending.
