<p align="center">
  <img src="./docs/assets/readme/logo.png" alt="MoNexus logo" width="88" height="88">
</p>

<h1 align="center">MoNexus</h1>

<p align="center">
  <b>An internal points exchange for digital goods.</b><br>
  Users earn and spend platform points; merchants supply card codes, subscriptions and digital services.
</p>

<p align="center">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&amp;logo=node.js&amp;logoColor=white">
  <img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white">
  <img alt="License: Private" src="https://img.shields.io/badge/License-Private-lightgrey?style=flat-square">
</p>

<p align="center">
  <b>English</b> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#production">Production</a>
</p>

<p align="center">
  <img src="./docs/assets/readme/store-desktop.webp" alt="MoNexus store on desktop" width="100%">
</p>

<table align="center">
  <tr>
    <td width="70%"><img src="./docs/assets/readme/product-desktop.webp" alt="Product detail page" width="100%"></td>
    <td width="30%"><img src="./docs/assets/readme/store-mobile.webp" alt="Store on mobile" width="100%"></td>
  </tr>
</table>

<p align="center"><sub>Screenshots use local seed data with neutral demo product names.</sub></p>

## About

MoNexus is an **internal welfare / points incentive platform**. Operators grant points, merchants supply digital goods, users redeem points. All ledger amounts are in-system integers.

| Role | What they do |
| :--- | :--- |
| **User** | Register, check in, invite friends, browse the store, redeem, review orders, recharge points when enabled |
| **Merchant** | Apply to join, manage catalog and inventory, fulfill orders, view settlements |
| **Admin** | Approve merchants, adjust points, configure rewards, run settlements, audit logs, operate recharge/payments |

> [!NOTE]
> **Out of scope by design:** fiat withdrawal, physical goods / logistics, multi-tenant white-label SaaS and native apps — Web and responsive mobile browser only.
> User-funded recharge exists as a module (quotes, orders, credit, refund, dispute, reconciliation; Simulator for local/staging). Production defaults to `RECHARGE_MODE=disabled`, refuses to start with Simulator or `sandbox`, and live adapters (Stripe, PayPal, WeChat Pay, Alipay) stay disabled until credentials and merchant qualification exist.

## Features

<table>
  <tr>
    <th width="33%">🛍️ Users</th>
    <th width="33%">🏪 Merchants</th>
    <th width="33%">🛡️ Admins</th>
  </tr>
  <tr>
    <td valign="top">
      <ul>
        <li>Email sign-up / login, HttpOnly refresh cookies</li>
        <li>Email verification and password reset</li>
        <li>Store with search, categories, cursor pagination</li>
        <li>Instant inventory, fixed content and manual-service fulfillment</li>
        <li>Daily check-in, invite codes, points ledger</li>
        <li>Order history, delivery copy, reviews</li>
        <li>Optional recharge (quote → pay → credit)</li>
      </ul>
    </td>
    <td valign="top">
      <ul>
        <li>Self-service onboarding with admin review</li>
        <li>Product CRUD, bulk inventory import, change logs</li>
        <li>Orders, disputes, manual delivery</li>
        <li>Dashboard and settlement statements with commission snapshots</li>
      </ul>
    </td>
    <td valign="top">
      <ul>
        <li>Users, merchants, products, orders, settlements</li>
        <li>Merchant approval / suspension, per-merchant commission</li>
        <li>Manual point adjustment with audit trail</li>
        <li>Recharge orders, refunds, disputes, reconciliation</li>
        <li>Runtime config: rewards, member tiers</li>
        <li>Health probes, Prometheus metrics, Sentry</li>
      </ul>
    </td>
  </tr>
</table>

**Platform guarantees**

- One database transaction per redeem: debit points, reserve inventory, create order, delivery, point log and settlement.
- Integer-only math for points, commission and recharge money.
- Cross-owner resource access returns **404**, not 403, to prevent enumeration.
- Optional Redis public-read cache with a circuit breaker; S3-compatible uploads (MinIO locally, S3/R2/OSS in production).

## Tech stack

<p align="center">
  <img src="https://skillicons.dev/icons?i=react,ts,vite,tailwind,nodejs,express,prisma,postgres,redis,docker,nginx,githubactions,vitest,sentry,prometheus&amp;perline=8" alt="React, TypeScript, Vite, Tailwind CSS, Node.js, Express, Prisma, PostgreSQL, Redis, Docker, nginx, GitHub Actions, Vitest, Sentry, Prometheus">
</p>

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React 18, TypeScript, Vite 6, React Router 6, Zustand, Tailwind CSS, Radix UI, Axios, Sentry |
| **Backend** | Node.js 22, Express 4, TypeScript, Zod, Prisma 6, JWT + cookie refresh tokens |
| **Data** | PostgreSQL 16, Redis 7 (optional), MinIO / S3-compatible storage |
| **Ops** | Docker Compose, nginx, GitHub Actions, Vitest, Playwright, pino, prom-client |

Runtime: Node.js `>=22 <23`, npm `>=10 <11` (see `.nvmrc`).

## Architecture

```mermaid
flowchart TB
  B["Browser<br/>React + Vite"] -->|"/api (dev proxy · prod nginx)"| A["Express API"]
  A --> P[("PostgreSQL")]
  A -.->|optional cache| R[("Redis")]
  A --> S["Object storage<br/>memory · S3"]
  A --> M["Mailer<br/>SMTP · console"]
  A --> O["Metrics · Sentry"]
```

**Redeem flow** — everything inside one transaction:

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant API as POST /api/orders
  participant DB as PostgreSQL
  U->>API: Redeem (Idempotency-Key, expectedPrice)
  API->>DB: BEGIN
  API->>DB: Check balance and product
  API->>DB: Lock inventory item
  API->>DB: Debit points
  API->>DB: Create order, delivery, point log, settlement
  API->>DB: Update stock and sales
  API->>DB: COMMIT
  API-->>U: Order with delivery content
```

Roles are `user`, `merchant` and `admin`; merchant resources are scoped to their owner.

<details>
<summary><b>Project structure</b></summary>

```text
MoNexus/
├── src/            # React frontend (api, components, pages, stores, lib)
├── server/         # Express backend (prisma schema + migrations, src/modules, middlewares, lib)
├── e2e/            # Playwright end-to-end tests
├── docs/           # PRD, specs, operations, archive
├── scripts/        # dev-up, backup, prod smoke, verify-local
└── design-system/  # UI tokens and brand assets
```

Backend modules follow `routes.ts` → `controller.ts` → services; contracts live in `server/src/modules/*/README.md`.

</details>

## Quick start

Requires Node.js 22 with npm 10, Docker (PostgreSQL / Redis) and Git.

```bash
git clone https://github.com/amo0114/MoNexus.git
cd MoNexus

nvm use
npm ci
npm --prefix server ci

# Postgres + Redis, migrations, backend :3000 and frontend :5173
bash scripts/dev-up.sh
# bash scripts/dev-up.sh --seed   # reseed demo data
```

| Service | URL |
| :--- | :--- |
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:3000 |
| Health | http://localhost:3000/api/health/live · `/ready` |

Stop with `Ctrl+C` in the `dev-up` terminal, then `docker stop monexus-db monexus-redis`.

**Demo accounts** (after `npm run db:seed` or `dev-up.sh --seed`):

| Role | Email | Password |
| :--- | :--- | :--- |
| Admin | `admin@moyuan.net` | `admin123` |
| User | `test@moyuan.net` | `user123` |
| Merchant | `merchant@moyuan.net` | `merchant123` |

> [!WARNING]
> These credentials are for **local development only**. Change every default before any shared deployment.

<details>
<summary><b>Manual setup</b></summary>

```bash
# 1) Infrastructure
docker compose up -d postgres redis

# 2) Backend
cd server
cp .env.example .env      # server template; fill local values below
# Minimum local values:
#   DATABASE_URL=postgresql://monexus:monexus_dev_2026@localhost:5432/monexus?schema=public
#   JWT_SECRET=local-development-secret-must-be-at-least-32-chars
#   FRONTEND_ORIGIN=http://localhost:5173
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev               # http://localhost:3000

# 3) Frontend (new terminal, repo root)
npm run dev               # http://localhost:5173
```

Optional object storage for real image uploads: `docker compose --profile storage up -d`. Without MinIO the backend uses an in-memory storage adapter.

</details>

<details>
<summary><b>Scripts</b></summary>

**Root (`package.json`)**

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start Vite frontend |
| `npm run build` | Typecheck + production frontend build |
| `npm run e2e` | Playwright E2E suite |
| `npm run verify:local` | Full local gate (DB, unit tests, optional E2E) |
| `npm run verify:local:no-e2e` | Same without Playwright |
| `npm run prod:env` | Validate production `.env` |
| `npm run prod:gate` | Env + compose config + build + up + smoke |
| `npm run prod:smoke` | Production smoke checks |
| `npm run backup:restore-check` | Validate a DB restore into a disposable target |

**Server (`server/package.json`)**

| Command | Description |
| :--- | :--- |
| `npm run dev` | Express with hot reload (`tsx watch`) |
| `npm run build` / `npm start` | Compile TypeScript and run `dist` |
| `npm run db:migrate` | Prisma migrate (dev) |
| `npm run db:migrate:deploy` | Prisma migrate (deploy) |
| `npm run db:seed` | Seed demo users / products |
| `npm test` | Vitest unit / API tests |

</details>

## Testing

```bash
# Run from the repository root.
nvm use
npm run check:runtime
npm test                  # frontend unit/component tests

# Backend tests need a disposable database
docker compose up -d postgres
docker compose exec -T postgres createdb -U monexus monexus_test   # first time only
export TEST_DATABASE_URL='postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public'
DATABASE_URL="$TEST_DATABASE_URL" npm --prefix server run db:migrate:deploy
REDIS_ENABLED=false npm --prefix server test
```

<details>
<summary><b>Local gates, E2E and caveats</b></summary>

```bash
# Local builds + backend tests + mobile/main/legal browser suites
npm run verify:local

# Main browser suite only, after migration and seeding of the disposable DB
# (verify:local prepares these fixtures automatically).
DATABASE_URL="$TEST_DATABASE_URL" npm run e2e
DATABASE_URL="$TEST_DATABASE_URL" npm run e2e:ui # interactive Playwright UI
```

- Backend tests require `TEST_DATABASE_URL` and truncate shared tables before each test. Use a disposable database and run only one backend test process per database. For targeted checks append files, e.g. `npm --prefix server test -- src/__tests__/business-time-boundaries.test.ts`.
- `verify:local:no-e2e` runs both builds and backend tests. `verify:local` additionally resets and seeds its test DB, then runs mobile, main and legal browser suites. Neither runs root frontend unit tests, architecture checks or the dedicated notification/catalog-ops E2E lanes — run `npm test` separately and see [the testing policy](./docs/testing-policy.md).
- Local E2E is for diagnosis; final CI/E2E runs in GitHub Actions on the delivered code. A successful local subset does not replace `CI OK`.
- Stop development API servers before database-backed local E2E: Playwright can reuse an existing server, so changing the command's database URL would not reconfigure it.

CI and deployment workflows live under [`.github/workflows/`](./.github/workflows/).

</details>

## Production

Three Docker Compose paths plus a legacy non-Docker fallback. Prefer **Path A** whenever GitHub Actions can publish images to GHCR.

| Path | When to use |
| :--- | :--- |
| **A — Approved GitHub Actions deploy** (recommended) | Verifies the exact `master` SHA's CI and multi-arch images, waits for `production` Environment approval, then runs Compose health checks |
| **B — Manual GHCR / Compose** | First bootstrap or recovery on a host |
| **C — Build images on the host** | GHCR unavailable or offline rehearsal |
| **D — Non-Docker artifacts** (legacy) | nginx + systemd hosts via SSH |

All paths start the same way: copy [`.env.example`](./.env.example) to `.env`, fill real secrets (JWT ≥ 32 chars, Postgres, SMTP, object storage, metrics token…), then `npm run prod:env`.

<details>
<summary><b>Images and tags (GHCR)</b></summary>

[`docker-publish.yml`](./.github/workflows/docker-publish.yml) builds and, on non-PR events, pushes:

| Image | Registry path | Dockerfile |
| :--- | :--- | :--- |
| Server API | `ghcr.io/amo0114/monexus-server` | `server/Dockerfile` |
| Web (nginx SPA) | `ghcr.io/amo0114/monexus-web` | root `Dockerfile` |

Release tags are multi-architecture (`linux/amd64`, `linux/arm64`).

| Trigger | Tags |
| :--- | :--- |
| Push to `master` | `:master`, `:sha-<short>`, `:latest` |
| Git tag `v1.2.3` | `:1.2.3`, `:1.2`, `:latest` |
| Pull request | build only (no push), smoke validation |

`docker-compose.prod.yml` selects images with `MONEXUS_IMAGE_TAG` (default `latest`) and `MONEXUS_PULL_POLICY` (`missing` · `always` · `never`). Use an immutable tag in real deploys (e.g. `sha-abc1234`); if you track `latest`, set `MONEXUS_PULL_POLICY=always`.

</details>

<details>
<summary><b>Path A — approved GitHub Actions deploy</b></summary>

After the one-time VPS bootstrap, deploy through [`Compose Production Deploy`](./.github/workflows/compose-production-deploy.yml). Start with `workflow_dispatch` + `dry_run=true`; do not enable automatic deploys until the manual rehearsal succeeds. See [`compose-production-deploy.md`](./docs/operations/compose-production-deploy.md).

</details>

<details>
<summary><b>Path B — manual GHCR / Compose</b></summary>

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin   # one-time

cp .env.example .env   # fill secrets; set MONEXUS_IMAGE_TAG / MONEXUS_PULL_POLICY
npm run prod:env

export MONEXUS_IMAGE_TAG=sha-<short>   # or latest / 1.2.3
export MONEXUS_PULL_POLICY=always      # recommended with :latest
npm run prod:up
npm run prod:ps
npm run prod:smoke
```

No application build is needed on the host — only Docker Compose, Postgres volumes and a valid `.env`.

</details>

<details>
<summary><b>Path C — build on the host</b></summary>

```bash
npm run prod:env
npm run prod:build    # docker compose -f docker-compose.prod.yml build
npm run prod:up
npm run prod:smoke

# Or the full gate (env + config + build + up + smoke):
npm run prod:gate
```

</details>

<details>
<summary><b>Path D — non-Docker artifacts (legacy)</b></summary>

GitHub Actions can still build tar artifacts ([`cd.yml`](./.github/workflows/cd.yml)) and deploy over SSH ([`deploy.yml`](./.github/workflows/deploy.yml)) to an **nginx + systemd** (or PM2) host under `/opt/monexus/`. See [`deployment-target.md`](./docs/operations/deployment-target.md).

</details>

**Operations docs:** [runbook](./docs/operations/runbook.md) · [1Panel/OpenResty VPS](./docs/operations/vps-1panel-openresty-deployment.md) · [Caddy VPS](./docs/operations/vps-compose-deployment.md) · [protected deploy](./docs/operations/compose-production-deploy.md) · [deployment targets](./docs/operations/deployment-target.md) · [rollback](./docs/operations/rollback-runbook.md) · [secrets](./docs/operations/secrets-management.md)

## Documentation

| Document | Description |
| :--- | :--- |
| [Product PRD](./docs/superpowers/specs/2026-04-30-monexus-product-prd.md) | Product scope and milestones |
| [Recharge & payment V1](./docs/specs/recharge-payment-platform-v1.md) | Recharge platform; live providers stay disabled without credentials |
| [Merchant settlement contract](./docs/superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md) | Settlement rules |
| [OpenAPI](./docs/superpowers/specs/monexus-api-openapi.json) | API surface |
| [`docs/operations/`](./docs/operations/) | Runbooks, gray release, alerts |
| [`docs/archive/`](./docs/archive/) | Historical plans, MVP prototype, design handoffs (read-only) |
| [Design system](./design-system/monexus/MASTER.md) | UI tokens and components |

## Contributing

This repository is primarily an **internal product**. If you have access:

1. Branch from `develop` (e.g. `feat/short-description`) and open the PR into `develop`; `master` takes release and hotfix PRs only. See [branching and CI](./docs/branching-and-ci.md).
2. Keep changes focused and follow existing module boundaries under `server/src/modules/` and `src/pages/`.
3. Run affected tests and builds (`npm run verify:quick` for targeted checks; `npm test` and `npm run verify:local:no-e2e` for broader validation).
4. Update `docs/` when behavior or operations change. Never commit `.env`, secrets or production dumps.

## License

**Private / proprietary.** All rights reserved by the project owners. This codebase is intended for authorized internal use; redistribution or commercial use outside the owning organization requires a separate written license.

<br>

<p align="center"><sub>MoNexus — points in, digital value out.</sub></p>
