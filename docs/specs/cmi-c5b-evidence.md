# CMI C5b Final Gate Evidence

Date: 2026-08-15
Branch: `feat/catalog-merch-integration`
Current evidence HEAD: `87626c956593d6256a408bc4e89766f4fb94056e` (docs-only).
Implementation code ancestor under test: `c690025b9d1059bc47b6c1c16aa5811b2971d373`.
C5b runner commits: `685d23b` (dedicated Merch gates/config), `495d1a0`
(disposable E2E database cleanup), and `e279c72` (executable modes).
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
| Merch dedicated gates | `PATH=/root/.nvm/versions/node/v20.19.5/bin:$PATH bash scripts/verify-merchandising.sh` | PASS; ranking 2 files / 55 tests, points 4 server files / 56 tests + 3 UI files / 91 tests, asset gallery 3/3; root/server runtime and build passed; each disposable CMI DB cleaned |
| Root security/public-field targeted suite | Root targeted security/public-field suite | PASS, 8 files / 117 tests; exit 0 |
| Server security suite | Server security suite with `TEST_DATABASE_URL` | NOT PASS: execution was interrupted after the `TEST_DATABASE_URL`-backed run did not complete; no PASS evidence was produced |

### Security split ledger (2026-08-15)

The server security check was split only to preserve the evidence boundary; this
is partial evidence, not a substitute for one complete server gate.  The runs
used Node `v20.19.5` (npm 10) and the disposable PostgreSQL database
`monexus_test_catalog_merch_integration`; database creation/migrations and
cleanup were performed by the CMI dbguard runner.

| Subset | Exact command / files | Result |
| --- | --- | --- |
| Pure security subset (3 files / 33 tests) | `TEST_DATABASE_URL=<CMI> DATABASE_URL=<CMI> REDIS_ENABLED=false REDIS_REQUIRED=false server/node_modules/.bin/vitest run --config server/vitest.config.ts src/modules/catalog/contentSanitizer.test.ts src/modules/catalog/categorySchema.test.ts src/modules/merchandising/__tests__/promotions-dto-state.test.ts` | PASS, exit 0; duration was captured in the disposable-run transcript (not retained in this ledger) |
| DB-backed security subset (5 files / 53 tests) | `TEST_DATABASE_URL=<CMI> DATABASE_URL=<CMI> REDIS_ENABLED=false REDIS_REQUIRED=false server/node_modules/.bin/vitest run --config server/vitest.config.ts src/modules/catalog/publicationRoutes.test.ts src/modules/catalog/applicationService.test.ts src/modules/catalog/fakaPreviewConfirm.test.ts src/modules/merchandising/__tests__/promotions-campaign.test.ts src/modules/merchandising/__tests__/editorial-entitlements.test.ts` | NOT PASS / interrupted; no exit-0 or duration evidence; therefore no server security PASS is claimed |

The split does not establish a single full server security gate.  Explicit MFA,
log, and other audit gaps remain; consequently `G-CAT-PR-008` and
`G-MERCH-PR-008` remain **Pending**.

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
| `M_CMI → implementation code ancestor` | `d9ce97e → c690025` | PASS |
| `implementation code ancestor → current evidence HEAD` | `c690025 → 87626c9` | PASS (docs-only commits) |
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
2. Keep `G-CAT-PR-008` and `G-MERCH-PR-008` Pending: the root targeted suite is
   recorded above, but the interrupted server security suite is not a PASS.
3. Prepare the C6 PR to `develop` with `run-e2e`, the v0.1.2 revision note,
   Deferred list, and this evidence index; keep the PR blocked while any gate
   remains Pending.

The four Merch verification entry points now exist at runner commits `685d23b`
and `e279c72`; the shared E2E runner cleanup hardening is `495d1a0`.
The asset gate explicitly discloses that Image2 concept/runtime delivery is
Deferred and runs only the existing product-gallery regression (`3/3`); no
Deferred asset work is represented as shipped functionality.
