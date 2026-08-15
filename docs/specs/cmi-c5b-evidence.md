# CMI C5b Final Gate Evidence

Date: 2026-08-15
Branch: `feat/catalog-merch-integration`
Code HEAD under test: `c690025b9d1059bc47b6c1c16aa5811b2971d373`
Evidence/checklist changes are docs-only and are committed after this code HEAD.
CMI database: `monexus_test_catalog_merch_integration` only

## Verification

| Gate | Command | Result |
| --- | --- | --- |
| Foundation | `DATABASE_URL=<CMI> bash scripts/verify-catalog-foundation.sh` | PASS, 11/11; format/validate/generate, empty/legacy/dirty migration, constraints, drift, scope, secret scan, cleanup |
| Catalog backend | `DATABASE_URL=<CMI> bash scripts/verify-catalog-ops-backend.sh` | PASS, 7/7; build and 24-file catalog suite; CMI DB/log cleanup passed |
| Server full | `TEST_DATABASE_URL=<CMI> DATABASE_URL=<CMI> REDIS_ENABLED=false REDIS_REQUIRED=false API_RATE_LIMIT_MAX=3000 npm test` (Node 20) | PASS, 154 files / 1420 tests; exit 0; Vitest 3185.36s (wall 3187.90s); CMI DB dropped afterward |
| Root | `npm test` | PASS on immediate full rerun: 49 files / 450 tests. Initial run had two 5s timing timeouts; both files passed alone with 15s timeout and the next full run passed. |
| Catalog-ops browser | `bash scripts/verify-catalog-ops-e2e.sh` | PASS, 30/30: category governance 15, product lifecycle 9, Xboard 3, merchandising smoke 3 |
| Merchant route fix | CMI Vitest targeted suite | PASS, 4 files / 50 tests: merchant registration, verified value gate, promotions campaign, editorial entitlements |
| Identity raw-writer closure | `PATH=/root/.nvm/versions/node/v20.19.5/bin:$PATH npx playwright test --config playwright.identity-sync.logic.config.ts`; `rg -n "\\.setUser\\(|\\.setAccessToken\\(|setUser:|setAccessToken:" src tests` | PASS, 56/56 Identity logic tests; static scan returned zero source/test matches after `0d9f7ce`; Node 20; frontend `npm run build` passed |

The first full-run attempt was invalid because the disposable CMI database had already
been removed by the prior runner (154 files failed during initialization and 1420 tests
were skipped). It is excluded from the result above; the database was recreated from
the committed migrations before the valid run.

## Ancestor Matrix

All commands below were run from the integration worktree and returned exit 0 unless marked otherwise.

| Relation | SHA(s) | Result |
| --- | --- | --- |
| `D → S → A_CMI → F0 → B_CAT → F` | `da38dd0 → 12eac74 → 68ac52f → 70517f7 → 8c2800e → 8c2800e` | PASS |
| `F → Catalog BE/FE` | `8c2800e → 179b293`, `8c2800e → 1648c10` | PASS |
| `H → M_CMI` | `1648c10 → d9ce97e` | PASS |
| `Merch BE/FE/Assets → M_CMI` | `8dc5d57`, `e1846db`, `b61c83c → d9ce97e` | PASS |
| `M_CMI → final HEAD` | `d9ce97e → c690025` | PASS |
| `N → M_ID` | `f586efd → dc9fb30` | PASS (exit 0) |
| `C_ID → M_ID` | `2bf77c1 → dc9fb30` | PASS (exit 0) |
| `M_ID → Identity Layout` | `dc9fb30 → 50b774c` | PASS (exit 0) |
| `Identity Layout → raw-writer closure` | `50b774c → 0d9f7ce` | PASS (exit 0) |
| `Identity closure → evidence candidate` | `0d9f7ce → 560d00c` | PASS (exit 0; docs-only Identity evidence handoff) |

The Identity handoff is now established in the dedicated
`fix/identity-profile-layout-integration` lane: `M_ID` is the merge of `N` and
`C_ID`, Layout integration starts from `M_ID`, and `0d9f7ce` is the separate
raw-writer closure commit; `560d00c` records the Identity evidence handoff and
retains both ancestors. PAR-GATE-006 and PAR-GATE-011 have reproducible
ancestor evidence; this evidence is cross-spec and does not merge Identity
production files into the CMI branch.

## Scope / Security

The CMI implementation diff is limited to the authorized route fix and C5a
test/E2E/docs changes. Identity raw-writer closure is isolated in
`0d9f7ce` and is referenced as cross-spec evidence only. `git diff --check` is
clean. C5a touched only tests/E2E/docs, and the authorized route fix is limited
to the existing `/api/merchant` mount order in `server/src/app.ts`. No schema,
migration, secret, object key, or production data was added. CMI databases and
temporary runner resources were cleaned after each run.

## Remaining Before C6

1. Owner reviews the evidence and fills the remaining Catalog/Merch PR Gate
   rows (release/rollback, performance, and PR description evidence).
2. Prepare the C6 PR to `develop` with `run-e2e`, the v0.1.2 revision note,
   Deferred list, and this evidence index; keep the PR blocked while any gate
   remains Pending.

The Merch implement contract also names
`scripts/verify-merchandising-ranking.sh`,
`scripts/verify-merchandising-points.sh`,
`scripts/verify-merchandising-assets.sh`, and
`scripts/verify-merchandising.sh` as required verification entry points.
All four are absent at this HEAD; direct invocations returned exit 127. No
Merch PR gate was marked Passed on the basis of a missing command.
