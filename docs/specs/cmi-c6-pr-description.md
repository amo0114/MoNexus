# CMI C6 PR Draft

## Target

- Base: `develop`
- Label: `run-e2e`
- Source branch: `feat/catalog-merch-integration`
- Implementation code under test: `c690025`
- C5b runners: `685d23b`, `495d1a0`, and `e279c72`

## Summary

This PR integrates the Catalog Operations and Merchandising Governance lanes
after the C4 `develop` merge. It includes the authorized `/api/merchant`
registration mount-order fix, C5a legacy assertion reconciliation, the
catalog-ops CI option-B isolated E2E job, and the final C5b evidence ledger.

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
- Identity closure: 56/56 logic tests, raw-writer static scan zero, frontend
  build green.

## Deferred

- Image2 concept/runtime asset delivery (`T-MERCH-ASSET-001`, AC-MERCH-025/026,
  CHK-ASSET-001~006, PERF-004) remains Deferred by AMD-CMI-012 and is not
  represented as shipped functionality.
- P1 performance/bundle/cache measurement and any broader recommendation or
  multi-tab expansion remain follow-up work under their existing specs.

## Readiness

This draft is not a ready-to-merge declaration. The remaining Pending gates
are the Owner/PAR handoff review, the explicit legacy-isHot/security/AC-map
audit, performance/cache/compat and rollout/rollback evidence, and the final
PR risk/monitoring/rollback handoff. The PR must remain blocked until those
rows are filled and reviewed.
