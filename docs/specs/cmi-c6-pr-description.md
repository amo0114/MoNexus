# CMI C6 PR Draft

## Target

- Base: `develop`
- Label: `run-e2e`
- Source branch: `feat/catalog-merch-integration`
- Current code/evidence run SHA: `d650014a9d816a9c6c3476d6e6e02861bce208ac`
  (final staging rehearsal exact SHA; this document is docs-only); implementation
  code ancestor under test: `c690025`
- C5b runners/evidence: `685d23b`, `495d1a0`, `e279c72`, `e329d1b`, `1d37d86`,
  `4ab3de9`, `61e41af`, and final staging fixes through `d650014`

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
  The frontend build passes, while the conservative all-assets 150 KiB gzip proxy
  reports 315.74 KiB and exits non-zero. This proxy is explicitly Deferred with
  `T-MERCH-ASSET-001` by AMD-CMI-012 §3.6; it is not presented as a shipped budget
  pass. The protected staging run below supplies the external staging P95.
- Final staging rehearsal [workflow run 31890663141](https://github.com/amo0114/MoNexus/actions/runs/31890663141)
  deployed the exact SHA `d650014a9d816a9c6c3476d6e6e02861bce208ac` after root
  installed the reviewed Caddy sudoers delegation on `free-vnic`. Owner `amo0114`
  approved the protected `staging` Environment (rule `62780483`). Its retained
  artifact reports 100/100 canary samples, P50 790 ms / P95 793 ms / P99 797 ms,
  zero failures, flag-off fallback PASS, code rollback PASS to known-good
  `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c`, fixture cleanup `CLEAN`, and final
  public readiness `ready` with realtime `disabled`.
- Exact-SHA dry-run [31885929935](https://github.com/amo0114/MoNexus/actions/runs/31885929935)
  passed with no host change. The earlier failed-closed attempt
  [31885609141](https://github.com/amo0114/MoNexus/actions/runs/31885609141) is
  retained as historical evidence; the root repair and final run above closed it.

## Deferred

- Image2 concept/runtime asset delivery (`T-MERCH-ASSET-001`, AC-MERCH-025/026,
  CHK-ASSET-001~006, PERF-004) remains Deferred by AMD-CMI-012 and is not
  represented as shipped functionality.
- Production performance, production traffic, backup-restore, and an incremental
  frontend bundle baseline remain follow-up work under separate authorization. The
  staging P95, Owner/PAR rollout, rollback, and cleanup gates are closed by run
  `31890663141`; the bundle/asset work remains Deferred rather than silently passed.

## Readiness

This draft records the completed staging C5b evidence and is ready for Owner review
before opening C6. It is not a production-promotion declaration: production traffic,
production monitoring/restore, and the Deferred asset/bundle scope remain outside
this PR. The C6 PR should retain the `run-e2e` label and link the workflow artifact.
