# CMI C5b Final Gate Evidence

Date: 2026-08-15
Branch: `feat/catalog-merch-integration`
Code/evidence run HEAD: `d650014a9d816a9c6c3476d6e6e02861bce208ac` (the exact SHA
deployed by the final staging rehearsal; this document update is docs-only).
Implementation code ancestor under test: `c690025b9d1059bc47b6c1c16aa5811b2971d373`.
C5b runner commits: `685d23b` (dedicated Merch gates/config), `495d1a0`
(disposable E2E database cleanup), `e279c72` (executable modes), `e329d1b`
(local perf/compat runner), `1d37d86` (release rehearsal/Owner handoff),
`4ab3de9` (100k benchmark), and `61e41af` (security/audit and fixture closure).
Staging rehearsal fixes are carried by `66d230e`, `d835621`, `3cf448b`,
`eb79c9f`, `e9c55d6`, and `d650014`.
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
| Local perf/compat runner | `TEST_DATABASE_URL=<CMI> DATABASE_URL=<CMI> REDIS_ENABLED=false REDIS_REQUIRED=false bash scripts/verify-cmi-perf-compat.sh`; `bash scripts/verify-cmi-100k-order-p95.sh`; `npm run check:bundle-budget` | Cache 7/7, server build and dashboard 2/2 PASS; 100k synthetic-order benchmark PASS locally (30 samples; summary P95 16.504372 ms, timeseries P95 80.750211 ms). The conservative all-assets bundle proxy remains 315.74 KiB gzip versus 150 KiB and is explicitly **Deferred** with `T-MERCH-ASSET-001` by AMD-CMI-012 §3.6; it is not represented as a shipped budget pass |
| Final staging rehearsal / Owner handoff | [workflow run 31890663141](https://github.com/amo0114/MoNexus/actions/runs/31890663141), exact SHA `d650014a9d816a9c6c3476d6e6e02861bce208ac`; artifact `notification-realtime-staging-evidence-d650014a9d816a9c6c3476d6e6e02861bce208ac` | **PASS**. Owner `amo0114` approved the protected `staging` Environment (rule `62780483`); Caddy sudo delegation was installed by root on `free-vnic`; rollout, 100-sample canary/latency, flag-off fallback, code rollback to known-good `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c`, fixture cleanup, and final readiness all passed |

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

### Final staging rehearsal evidence (2026-08-15)

The protected workflow [31890663141](https://github.com/amo0114/MoNexus/actions/runs/31890663141)
ran against the immutable code SHA
`d650014a9d816a9c6c3476d6e6e02861bce208ac` after the root-only Caddy delegation was
installed on `free-vnic`. The `staging` Environment approval was recorded for Owner
`amo0114` under required-reviewer rule `62780483` (approval comment: "Owner-approved
staging realtime rehearsal per current PAR authorization.").

The retained artifact is
`notification-realtime-staging-evidence-d650014a9d816a9c6c3476d6e6e02861bce208ac`.
Its files all have `result=PASS` except the explicitly informational external log-query
note in `proxy.txt`; no secret or token was uploaded. The material results are:

- `rollout.txt`: backend-first, proxy-first, frontend-after, and feature flag on all
  passed; `logs.txt` passed Nginx/app/Caddy boundary inspection.
- `staging-latency.txt`: 100/100 samples, `failure_count=0`, `p50_ms=790`,
  `p95_ms=793`, `p99_ms=797`, `max_ms=810`; the sample path was API 2xx to the
  merchant order-id DOM.
- `session.txt`: production-like LISTEN gate passed (`pid_samples=4/4`, distinct
  PID count 1, connect/listen/notify permissions ok, 40/40 auxiliary commits).
- `rollback.txt`: flag-off fallback, REST history polling, and code rollback passed;
  `fixture-cleanup.json` reports `CLEAN`.
- `rehearsal-meta.txt`: baseline captured as
  `4fe0fbcac899bbc388184e0dfe2d59b9dbe90c2c`; the workflow restored this baseline and
  the final public readiness check passed. A direct post-run probe returned
  `{"status":"ready", "checks":{"database":"ok","config":"ok","redis":"ok","notificationRealtime":"disabled"}}`.

This closes the staging Owner/PAR, canary, external staging P95, rollback, and cleanup
evidence rows. It does not claim production traffic, backup-restore, or an incremental
frontend bundle baseline; the bundle/asset work remains the Owner-approved Deferred
scope in AMD-CMI-012 §3.6.

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

1. Review this evidence and the Owner handoff, then prepare the C6 PR to `develop`
   with the `run-e2e` label, v0.1.2 revision note, Deferred list, release rehearsal,
   and evidence index.
2. Keep the explicitly Deferred Image2/runtime-asset and incremental bundle work out
   of shipped-scope claims; it is not a failed CMI implementation gate under
   AMD-CMI-012 §3.6.
3. Production promotion, production/canary traffic, and backup-restore rehearsal are
   outside this staging-only run and require a separate Owner authorization.

The four Merch verification entry points now exist at runner commits `685d23b`
and `e279c72`; the shared E2E runner cleanup hardening is `495d1a0`.
The asset gate explicitly discloses that Image2 concept/runtime delivery is
Deferred and runs only the existing product-gallery regression (`3/3`); no
Deferred asset work is represented as shipped functionality.
