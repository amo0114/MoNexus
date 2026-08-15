# CMI G-CAT / MERCH-PR-009 performance, cache and compatibility evidence

This is local, reproducible evidence only. It does not claim staging or
production latency, 100,000-order performance, or a frontend bundle budget.

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

P50/P95: **not measured**. The 2/2 benchmark result is not a percentile and no
latency number is inferred. Staging/production P95, 100,000-order P95, and
frontend bundle budget remain **PENDING** and require the corresponding
external dataset/tooling.

## Reproduction notes

Run from the repository root with dependencies installed. For the optional
benchmark, point `TEST_DATABASE_URL` at a disposable local PostgreSQL database
already matching the checked-in schema and test setup; do not use staging or
production credentials. The test creates its own `bench-*` records and relies
on the repository test cleanup/configuration.
