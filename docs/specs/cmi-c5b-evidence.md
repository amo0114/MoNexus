# CMI C5b Final Gate Evidence

Date: 2026-08-15
Branch: `feat/catalog-merch-integration`
Current evidence HEAD: `0a4696a` (staging sudo-boundary repair; based on the
security/audit and fixture tip `61e41af`, which in turn includes benchmark
`4ab3de9`).
Implementation code ancestor under test: `c690025b9d1059bc47b6c1c16aa5811b2971d373`.
C5b runner commits: `685d23b` (dedicated Merch gates/config), `495d1a0`
(disposable E2E database cleanup), `e279c72` (executable modes), `e329d1b`
(local perf/compat runner), `1d37d86` (release rehearsal/Owner handoff),
`4ab3de9` (100k benchmark), and `61e41af` (security/audit and fixture closure).
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
| Unified CMI server security gate | Node 20.19.5/npm 10.8.2, disposable CMI DB, 8 focused security/admin files | **PASS, 8 files / 70 tests, exit 0, Vitest 111.43s;** runtime admin MFA boundaries, audit reason redaction, public-field/PointLog boundaries, catalog admin authorization, auth/security-event and mail redaction suites all passed; DB dropped afterward |
| Local perf/compat runner | `TEST_DATABASE_URL=<CMI> DATABASE_URL=<CMI> REDIS_ENABLED=false REDIS_REQUIRED=false bash scripts/verify-cmi-perf-compat.sh`; `bash scripts/verify-cmi-100k-order-p95.sh`; `npm run check:bundle-budget` | Cache 7/7, server build and dashboard 2/2 PASS; latest 100k synthetic-order benchmark PASS locally (30 samples; summary P95 16.504372 ms, timeseries P95 80.750211 ms); frontend build PASS but conservative 150 KiB proxy **FAIL** at 315.74 KiB gzip; staging/production/canary P95 and release bundle acceptance remain Pending |
| Release rehearsal / Owner handoff | baseline run `31877359120`; exact-SHA dry-run `31885929935`; live attempt `31885609141`; local syntax checks | Baseline deploy/smoke/public readiness PASS; deployment `5919176861` is known-good. Latest dry-run PASS with no host change. Live attempt was Owner-approved but failed closed at Caddy `sudo -n` because the host lacked the restricted delegation; no app/fixture/rollback ran. Commit `603d874` provides the fixed-helper root repair; root host action and a succeeding live rehearsal are Pending. `staging` Environment reviewer `amo0114` (rule `62780483`) is configured. Canary, rollback rehearsal, external P95, and exact target-window approval remain Pending |

The unified security command used `server/vitest.config.ts` with
`fileParallelism=false`/`singleFork=true` and these eight files: `security-gaps.test.ts`,
`admin-security-routes.test.ts`, `promotions-campaign.test.ts`,
`editorial-entitlements.test.ts`, `categoryAdminRoutes.test.ts`,
`admin-audit.test.ts`, `auth-security-events.test.ts`, and
`admin-mail-operations.test.ts`. The command supplied `TEST_DATABASE_URL` and
`DATABASE_URL` for the guarded CMI database and completed with exit 0.

### Security split ledger (2026-08-15)

The historical split below is retained for traceability. It is superseded for
the CMI security gate by the single focused run recorded in the verification
table above. The run used Node `v20.19.5` (npm 10) and the disposable PostgreSQL
database `monexus_test_catalog_merch_integration`; database creation/migrations
and cleanup were performed by the CMI dbguard runner.

| Subset | Exact command / files | Result |
| --- | --- | --- |
| Pure security subset (3 files / 33 tests) | `cd server && TEST_DATABASE_URL=<CMI> DATABASE_URL=<CMI> REDIS_ENABLED=false REDIS_REQUIRED=false ./node_modules/.bin/vitest run --config vitest.config.ts src/modules/catalog/contentSanitizer.test.ts src/modules/catalog/categorySchema.test.ts src/modules/merchandising/__tests__/promotions-dto-state.test.ts` | PASS, exit 0; Vitest duration 45.26s |
| DB-backed security subset (5 files / 53 tests) | Five subsequent per-file DB-backed runs: `publicationRoutes.test.ts` — 3 tests / 8.49s (wall 9s); `applicationService.test.ts` — 15 / 17.34s (wall 18s); `fakaPreviewConfirm.test.ts` — 9 / 15.71s (wall 16s); `promotions-campaign.test.ts` — 22 / 26.45s (wall 27s); `editorial-entitlements.test.ts` — 4 / 6.17s (wall 6s) | PASS, all exit 0; 5 files / 53 tests total |

The split is historical partial evidence and is not used as the acceptance
result. The focused CMI gate adds runtime MFA coverage for promotion,
editorial, entitlement, and ranking admin surfaces plus bounded AdminLog reason
projections; its 8-file/70-test run is the current security evidence.

### Legacy `Product.isHot` audit (2026-08-15)

The production-source scan found no data-write literal `isHot: true` outside
tests/fixtures/schema/migrations. The remaining matches are schema omit-key
configuration or snapshot cursor predicates, not writes to the legacy Product
column. Allowed cleanup writes are `isHot: false` in `server/src/prisma/seed.ts`
(`:139,156,185,205`). The public/admin paths explicitly strip or ignore the
legacy column (`server/src/modules/admin/service.ts:1320-1323`,
`server/src/modules/products/service.ts:429-456`,
`server/src/modules/products/cache.ts:67-70`).

The initial multi-file disposable-DB batch was invalid: it hit a PostgreSQL
`40P01` deadlock during shared setup `TRUNCATE`, and the follow-up CLI attempt
used the wrong Node runtime. A subsequent serial Node `v20.19.5` rerun against
the CMI database passed all five files (each database was cleaned afterward):
`admin-query.test.ts` 17 tests / 30.04s, `admin/product-is-hot.test.ts` 7 /
13.96s, `merchant/product-is-hot.test.ts` 6 / 13.11s,
`ranking-compute-projection.test.ts` 30 / 35.10s, and
`products/catalog-merch-integration.test.ts` 5 / 9.20s (65 tests total, all
exit 0). The independent cleanup fixture is now also run by
`bash scripts/verify-cmi-legacy-hot-cleanup.sh` against the disposable CMI DB:
`legacy_is_hot_before=5`, `legacy_is_hot_after=0`, `legacy_is_hot_cleanup=PASS`.
This closes the true-count-to-false-count evidence for
`CHK-MERCH-FND-002`/`G-MERCH-PR-003` while keeping the fixture isolated from
production data.

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
| `implementation code ancestor → prior evidence HEAD` | `c690025 → 87626c9` | PASS (docs-only commits) |
| `implementation code ancestor → prior evidence HEAD` | `c690025 → 754d945` | PASS (docs-only commits) |
| `implementation code ancestor → current code/test evidence tip` | `c690025 → 30efbe4` | PASS |
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

The CMI implementation diff is limited to the authorized route fix, the
authorized merchandising admin security hardening, and C5a/C5b test/E2E/docs
changes. Identity raw-writer closure is isolated in
`0d9f7ce` and is referenced as cross-spec evidence only. `git diff --check` is
clean. C5a touched only tests/E2E/docs, and the authorized route fix is limited
to the existing `/api/merchant` mount order in `server/src/app.ts`; the
follow-up security changes only bound AdminLog projections and add runtime
MFA/security tests. No schema,
migration, secret, object key, or production data was added. CMI databases and
temporary runner resources were cleaned after each run.

## Remaining Before C6

1. Owner reviews the evidence and fills the remaining Catalog/Merch PR Gate
   rows (release/rollback, external performance, and PR description evidence).
2. Keep release/performance gates Pending until staging Owner/PAR, canary,
   rollback/restore, and external P95 evidence exist; the local 100k benchmark
   and bundle proxy do not substitute for those controls.
3. Prepare the C6 PR to `develop` with `run-e2e`, the v0.1.2 revision note,
   Deferred list, release rehearsal and Owner handoff docs, and this evidence
   index; keep the PR blocked while any gate remains Pending.

The four Merch verification entry points now exist at runner commits `685d23b`
and `e279c72`; the shared E2E runner cleanup hardening is `495d1a0`.
The asset gate explicitly discloses that Image2 concept/runtime delivery is
Deferred and runs only the existing product-gallery regression (`3/3`); no
Deferred asset work is represented as shipped functionality.
