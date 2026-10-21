# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MoNexus: internal points-based digital goods exchange (user / merchant / admin). Two separate npm packages:

- repo root — frontend: React 18, Vite 6, Zustand, Tailwind, Axios (`src/`); Playwright E2E (`e2e/`)
- `server/` — backend: Express 4, Prisma 6 + PostgreSQL 16, Zod, optional Redis, S3-compatible storage

Node must be `>=22 <23`, with npm `>=10 <11` (enforced by `scripts/check-runtime.mjs`). Specs/plans: `docs/specs/`; module contracts: `server/src/modules/*/README.md`.

## Commands

```bash
bash scripts/dev-up.sh                 # Postgres+Redis, migrate, backend :3000, frontend :5173
npm run build                          # frontend type-check + build
npm --prefix server run build          # backend type-check + registry runtime import
npm --prefix server run db:generate    # after schema change / rebase

npm test                               # frontend unit tests (vitest, jsdom)
# From repo root, after initializing a disposable DB (see README Testing):
: "${TEST_DATABASE_URL:?Set a disposable test database URL first}"
DATABASE_URL="$TEST_DATABASE_URL" npm --prefix server run db:migrate:deploy
REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 \
  npm --prefix server test -- src/__tests__/business-time-boundaries.test.ts

npm run verify:quick                   # affected tests only; `-- e2e/x.spec.ts` to add an E2E spec
DATABASE_URL="$TEST_DATABASE_URL" npm run e2e # main suite; requires migrated + seeded test DB
```

- Backend tests run serially against a real DB and TRUNCATE shared business tables before each test — `TEST_DATABASE_URL` must point at a disposable test database. Use one backend test process per database. Apply migrations with the root-based command above; `verify:quick` only migrates automatically when schema/migrations changed.
- Run targeted files for iteration. `verify:local:no-e2e` runs both builds and backend tests; `verify:local` adds reset/seed plus mobile/main/legal browser suites. Neither runs frontend unit tests, architecture checks or notification/catalog-ops E2E. See `docs/testing-policy.md`; final CI/E2E runs on GitHub Actions.

## Architecture boundaries

- Backend modules: `server/src/modules/<name>/` = `routes.ts` → `controller.ts` → specific use-case services; `service.ts` may retain compatibility exports. Implementations do not import their own service facade. Zod DTOs live in `schema.ts`, validated via `middlewares/validate.ts`. Errors: throw `HttpError` with an `ErrorCode` from `lib/httpError.ts`.
- `server/src/app.ts` router **mount order is load-bearing** (merch routes before `products/:id`, delivery files before greedy `uploads/:key`, payment webhooks before `express.json()` for raw body).
- All env is parsed by Zod in `server/src/config/index.ts`; new env vars go there and in `.env.example`.
- Frontend calls the API only through `src/api/client.ts` (token injection + refresh). Business 401s (password re-verification etc.) must set `skipAuthRefresh`.

## Hard constraints

- Points, commission and money are **integers only**. Redeem/checkout = debit + inventory lock + order + delivery + point log + settlement in **one transaction**.
- Resources the caller doesn't own return **404, not 403** (no enumeration).
- Order/checkout writes honor `Idempotency-Key` and `expectedPrice` / purchase-form version (`PRICE_CHANGED` / `CHECKOUT_CHANGED`); never silently charge under changed terms.
- When locking both, lock Order before Offer.
- Calendar days use `server/src/lib/businessTime.ts` (Asia/Shanghai); no host-local date math. Date-only values use `calendarDayToUtc` for canonical UTC-midnight storage. Timestamp filters use `businessDayRange` / `businessMonthRange` for actual Shanghai boundaries; these are not interchangeable with date-only storage values. CI runs in UTC.
- Cron jobs must go through `server/src/lib/cronLease.ts` (multi-instance safety).
- Production must never run with simulator/sandbox recharge; default `RECHARGE_MODE=disabled`.
- Tailwind opacity on `var()` colors (`bg-[var(--x)]/8`) generates nothing — use `--color-primary-tint(-strong)` from `src/index.css`.

## Testing & branching rules

- Test at the cheapest layer: backend behavior → `server` integration tests; frontend → root unit tests. New E2E only for new cross-stack journeys, critical journeys (auth/MFA, checkout & settlement, delivery, high-risk admin ops, legal pages, SSE), or browser-only behavior (see `docs/testing-policy.md`).
- Branch from and PR into `develop` (`feat/` `fix/` `chore/`); `master` is production (release PRs + `hotfix/*` only).
- Add the `run-e2e` label to PRs touching critical journeys, auth/session/middleware/rate limiting, or major dependency upgrades. Never use `[skip ci]` (the required `CI OK` check would hang).
