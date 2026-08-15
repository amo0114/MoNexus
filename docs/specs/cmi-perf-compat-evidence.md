# CMI G-CAT / MERCH-PR-009 performance, cache and compatibility evidence

This document records local reproducible evidence plus the external staging
rehearsal evidence. It does not claim production latency or production release
acceptance. The staging canary and bundle scope are explicitly separated from the
local benchmark.

## Runner

```bash
bash scripts/verify-cmi-perf-compat.sh
```

The runner records the Node/npm versions, runs the cache contract tests, and
builds the server with the checked-in TypeScript/Prisma client. If
`TEST_DATABASE_URL` is set, it also runs the existing dashboard benchmark
against that already-provisioned local test database. It does not run Prisma
migrations, reset a database, or contact a remote environment.

## What is covered

- Cache hit/miss and fallback behavior, negative-cache semantics, 100-way
  same-key single-flight coalescing, and cache-version bumping are covered by
  `server/src/__tests__/cache.test.ts`.
- Product public cache keys use the `:v1` prefix, version scope, and a stable
  SHA-256 parameter hash; the implementation is in
  `server/src/modules/products/cache.ts` and `server/src/lib/cache.ts`.
- Server compatibility is checked by `npm run build` (Node 20 / npm 10 is the
  repository engine range).
- The optional dashboard benchmark uses 1,000 locally-created orders and has
  an existing 500 ms per-call assertion in
  `server/src/__tests__/dashboard.bench.test.ts`. Its result is environment-
  dependent and must be recorded from the command output; no value is invented
  here.
- The disposable 100,000-order benchmark is run only by
  `scripts/verify-cmi-100k-order-p95.sh`; it creates and drops the guarded CMI
  database and reports sequential warm-query P50/P95/max samples.
- `npm run check:bundle-budget` builds the frontend and checks emitted asset
  gzip size against the frozen local proxy in
  `config/frontend-bundle-budget.json`.

## 2026-08-15 local run

Command (Node `v20.19.5`, npm `10.8.2`, disposable PostgreSQL CMI database;
60 committed migrations applied and the database dropped afterward):

```bash
TEST_DATABASE_URL=<CMI> DATABASE_URL=<CMI> REDIS_ENABLED=false REDIS_REQUIRED=false \
  bash scripts/verify-cmi-perf-compat.sh
```

Observed result: `cache_tests=PASS` (7/7), `server_build=PASS`, and
`dashboard_benchmark=PASS` (2/2). The dashboard benchmark exercises the
existing 1,000-order local fixture and enforces `<500 ms` for both `getSummary`
and `getTimeseries('30d')`; it does not report a latency distribution.

P50/P95: **not measured** for this 1,000-order assertion suite. The 2/2
benchmark result is not a percentile and no latency number is inferred. The
staging/canary P95 is recorded below from the protected workflow; production P95
remains outside this staging-only evidence.

### Disposable 100k-order local benchmark

Command (Node 20.19.5; database lifecycle is guarded to the disposable
`monexus_test_catalog_merch_integration` database):

```bash
bash scripts/verify-cmi-100k-order-p95.sh
```

Observed output on 2026-08-15 (`order_count=100000`, `samples=30`):

| Operation | P50 | P95 | Max |
| --- | ---: | ---: | ---: |
| `getSummary` | 11.982644 ms | 16.504372 ms | 34.115408 ms |
| `getTimeseries('30d')` | 63.246999 ms | 80.750211 ms | 83.106452 ms |

This is a local PostgreSQL service benchmark with synthetic rows and 30
sequential warm query samples per operation. It is evidence for this local
dataset/runtime only; it does not replace production performance evidence.

### Staging canary P95

The protected [workflow run 31890663141](https://github.com/amo0114/MoNexus/actions/runs/31890663141)
deployed immutable SHA `d650014a9d816a9c6c3476d6e6e02861bce208ac` and collected
100 API-2xx-to-merchant-order-DOM samples from the disposable staging fixture. The
artifact `staging-latency.txt` reports zero failures, P50 **790 ms**, P95 **793 ms**,
P99 **797 ms**, and maximum **810 ms**. The same run passed authenticated SSE proxy
transport, flag-off fallback/history, rollback, fixture cleanup, and final readiness.
This is staging evidence only; no production/canary-traffic claim is made.

### Local frontend bundle budget check

`REQ-MERCH-NF-006` specifies runtime bundle **new assets ≤150 KiB gzip**. The
repository has no committed pre-change asset baseline, so the reproducible local
check uses a conservative proxy: gzip every emitted file under `dist/assets` and
compare the aggregate with 150 KiB (`config/frontend-bundle-budget.json`). It
cannot establish incremental/new-asset attribution or external acceptance.

Command: `npm run check:bundle-budget` (production build, then
`node scripts/check-frontend-bundle-budget.mjs`). On 2026-08-15 the build passed
and the checker measured **315.74 KiB gzip for 2 emitted assets**, exceeding the
150 KiB conservative proxy; the command exited non-zero. This is an explicit local
proxy result, not a claim that the incremental new-asset budget is resolved. Under
the Owner-approved AMD-CMI-012 §3.6 rescope, Image2/runtime asset delivery and its
bundle budget (`T-MERCH-ASSET-001`, `CHK-ASSET-001~006`, `PERF-004`) are
**Deferred from this CMI release**; no deferred asset is represented as shipped
functionality. A future asset PR must establish an approved pre-change baseline and
re-run the budget against incremental assets.

## Reproduction notes

Run from the repository root with dependencies installed. For the optional
benchmark, point `TEST_DATABASE_URL` at a disposable local PostgreSQL database
already matching the checked-in schema and test setup; do not use staging or
production credentials. The test creates its own `bench-*` records and relies
on the repository test cleanup/configuration.
