# MoNexus

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-Private-lightgrey)](#license)

**English** | [简体中文](./README.zh-CN.md)

> An internal points-based digital goods exchange platform. Users earn and spend platform points for virtual products (card codes, subscription links, digital services). No real-money payment is involved.

---

## Table of Contents

- [About](#about)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Demo Accounts](#demo-accounts)
- [Scripts](#scripts)
- [Testing](#testing)
- [Production](#production)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## About

**MoNexus** is a pure **internal welfare / points incentive platform**. Platform operators grant points; merchants supply digital goods; users redeem points. All amounts stay as in-system bookkeeping integers — there is no integration with CNY, USD, bank cards, WeChat Pay, Alipay, Stripe, or any other real payment rail.

| Role | Capabilities |
| --- | --- |
| **User** | Register, check in, invite friends, browse the store, redeem products, review orders |
| **Merchant** | Apply to join, manage catalog & inventory, fulfill orders, view settlements |
| **Admin** | Approve merchants, adjust points, configure system rewards, batch settlements, audit logs |

**Product boundary (intentionally out of scope):** real payments, user-funded point top-ups, fiat withdrawal, physical goods / logistics, multi-tenant white-label SaaS, and native mobile apps. Web + responsive mobile browser only.

---

## Features

### User

- Email registration / login with HttpOnly refresh-token cookies
- Email verification & password reset (SMTP; console fallback in local dev)
- Product store with search, categories, cursor pagination
- Instant inventory redeem, fixed-content redeem, and manual-service fulfillment
- Daily check-in, invite codes, points ledger
- Order history, delivery content copy, product reviews

### Merchant

- Self-service onboarding with admin review (`pending → active / rejected / suspended`)
- Product CRUD, multi-line inventory import, inventory change logs
- Order list, dispute handling, manual delivery
- Dashboard metrics and settlement statements (commission snapshots)

### Admin

- Users, merchants, products, orders, settlements overview
- Merchant approval / suspension and per-merchant commission rate
- Manual points adjustment with admin audit trail
- Runtime system config (register / invite / check-in rewards, member tiers)
- Operational observability: health probes, Prometheus metrics, Sentry

### Platform quality

- Transactional redeem: debit points + reserve inventory + order + delivery + settlement in one DB transaction
- Integer-only points and commission math (no floating point money)
- Redis optional public-read cache with circuit breaker
- S3-compatible uploads (MinIO locally, external S3/R2/OSS in production)
- CI/CD, backup scripts, production compose, runbooks

---

## Tech Stack

| Layer | Technologies |
| --- | --- |
| **Frontend** | React 18, TypeScript, Vite 6, React Router 6, Zustand, Tailwind CSS, Radix UI, Axios, Sentry |
| **Backend** | Node.js 20, Express 4, TypeScript, Zod, Prisma 6, JWT + cookie refresh tokens |
| **Data** | PostgreSQL 16, Redis 7 (optional), MinIO / S3-compatible storage |
| **Ops** | Docker Compose, nginx, GitHub Actions, Vitest, Playwright, pino, prom-client |

**Runtime constraint:** Node.js `>=20 <21`, npm `>=10 <11` (see `.nvmrc`).

---

## Architecture

```text
Browser (Vite/React)
        │  /api  (dev proxy / prod nginx)
        ▼
   Express API  ── Prisma ── PostgreSQL
        │              └── Redis (optional cache)
        ├── Mailer (SMTP / console)
        ├── Storage (memory / S3)
        └── Metrics + Sentry
```

**Core business flow (redeem):**

```text
POST /api/orders
  → same transaction:
      check balance & product → lock inventory item → debit points
      → create order + delivery + point log + settlement → update stock
```

Roles: `user` | `merchant` | `admin`. Merchant resource access is scoped; cross-merchant reads return **404** (not 403) to avoid resource enumeration.

---

## Project Structure

```text
MoNexus-new/
├── src/                      # React frontend
│   ├── api/                  # HTTP clients
│   ├── components/           # Shared + role-specific UI
│   ├── pages/                # Route pages (store, profile, merchant, admin)
│   ├── stores/               # Zustand stores
│   └── lib/                  # Theme, web vitals, error reporter
├── server/                   # Express backend
│   ├── prisma/               # schema + migrations + seed
│   └── src/
│       ├── modules/          # auth, products, orders, merchant, admin, ...
│       ├── middlewares/      # auth, validate, metrics, errors
│       └── lib/              # prisma, redis, cache, mailer, storage
├── e2e/                      # Playwright end-to-end tests
├── docs/                     # PRD, specs, operations, archive/
├── scripts/                  # dev-up, backup, prod smoke, verify-local
├── docker-compose.yml        # Local Postgres + Redis (+ optional MinIO)
├── docker-compose.prod.yml   # Production stack
└── design-system/            # UI tokens & brand assets
```

---

## Getting Started

### Prerequisites

- [Node.js 20](https://nodejs.org/) and npm 10
- [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL / Redis)
- Git

### Quick start (recommended)

One-shot local stack (Postgres + Redis + migrate + backend + frontend):

```bash
# Clone
git clone <your-repo-url> MoNexus-new
cd MoNexus-new

# Install dependencies
npm install
cd server && npm install && cd ..

# Start everything (optional: reseed demo data)
bash scripts/dev-up.sh
# bash scripts/dev-up.sh --seed
```

| Service | URL |
| --- | --- |
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:3000 |
| Health (live) | http://localhost:3000/api/health/live |
| Health (ready) | http://localhost:3000/api/health/ready |

Stop: `Ctrl+C` in the `dev-up` terminal, then `docker stop monexus-db monexus-redis`.

### Manual setup

```bash
# 1) Infrastructure
docker compose up -d postgres redis

# 2) Backend
cd server
cp ../.env.example .env   # or let dev-up write DATABASE_URL / JWT_SECRET
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

Optional object storage for real image uploads:

```bash
docker compose --profile storage up -d
```

Without MinIO, the backend uses an in-memory storage adapter suitable for local development.

---

## Demo Accounts

After `npm run db:seed` (or `bash scripts/dev-up.sh --seed`):

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@moyuan.net` | `admin123` |
| User | `test@moyuan.net` | `user123` |
| Merchant | `merchant@moyuan.net` | `merchant123` |

> **Security:** These credentials are for **local development only**. Never use them in staging or production. Change all defaults before any shared deployment.

---

## Scripts

### Root (`package.json`)

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite frontend |
| `npm run build` | Typecheck + production frontend build |
| `npm run e2e` | Playwright E2E suite |
| `npm run verify:local` | Full local gate (DB, unit tests, optional E2E) |
| `npm run verify:local:no-e2e` | Same without Playwright |
| `npm run prod:env` | Validate production `.env` |
| `npm run prod:gate` | Env + compose config + build + up + smoke |
| `npm run prod:smoke` | Production smoke checks |
| `npm run backup:restore-check` | Validate a DB restore into a disposable target |

### Server (`server/package.json`)

| Command | Description |
| --- | --- |
| `npm run dev` | Express with hot reload (`tsx watch`) |
| `npm run build` / `npm start` | Compile TypeScript and run `dist` |
| `npm run db:migrate` | Prisma migrate (dev) |
| `npm run db:migrate:deploy` | Prisma migrate (deploy) |
| `npm run db:seed` | Seed demo users / products |
| `npm test` | Vitest unit / API tests |

---

## Testing

```bash
# Backend unit + API tests (requires disposable test DB)
cd server
# Prefer TEST_DATABASE_URL pointing at monexus_test
npm test

# Full local verification from repo root
npm run verify:local

# E2E only (stack must be running)
npm run e2e
npm run e2e:ui      # interactive Playwright UI
```

CI lives under [`.github/workflows/`](./.github/workflows/) (`ci.yml`, `cd.yml`, `deploy.yml`, backup & alert jobs).

---

## Production

There are **three** supported ways to run production-like stacks. Prefer **Path A** when GitHub Actions can publish images to GHCR. Full procedures live in the operations docs (linked below).

### Prerequisites (all paths)

1. Copy [`.env.example`](./.env.example) → `.env` and fill real secrets (JWT ≥ 32 chars, Postgres, SMTP, object storage, metrics token, etc.).
2. Validate: `npm run prod:env`
3. Optional daily backup: set `DATABASE_URL` and run `bash scripts/backup.sh`

### Images (GHCR)

CI workflow [`.github/workflows/docker-publish.yml`](./.github/workflows/docker-publish.yml) builds and (on non-PR events) pushes:

| Image | Registry path | Dockerfile |
| --- | --- | --- |
| Server API | `ghcr.io/amo0114/monexus-server` | `server/Dockerfile` |
| Web (nginx SPA) | `ghcr.io/amo0114/monexus-web` | root `Dockerfile` |

Release tags are multi-architecture (`linux/amd64` and `linux/arm64`), so the
same tag works on standard and ARM VPS hosts.

**Tag strategy** (via `docker/metadata-action`):

| Trigger | Tags |
| --- | --- |
| Push to `master` | `:master`, `:sha-<short>`, `:latest` |
| Git tag `v1.2.3` | `:1.2.3`, `:1.2`, `:latest` |
| Pull request | build only (no push), smoke validation |

`docker-compose.prod.yml` selects images with:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MONEXUS_IMAGE_TAG` | `latest` | Tag for both server and web |
| `MONEXUS_PULL_POLICY` | `missing` | `missing` \| `always` \| `never` |

Use an immutable tag in real deploys (e.g. `sha-abc1234` or `1.2.3`). If you track `latest`, set `MONEXUS_PULL_POLICY=always` so hosts do not reuse a stale local layer.

### Path A — Pull pre-built images from GHCR (recommended)

```bash
# One-time: authenticate to GHCR (needs read access to the packages)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin

cp .env.example .env   # fill secrets; set MONEXUS_IMAGE_TAG / MONEXUS_PULL_POLICY
npm run prod:env

export MONEXUS_IMAGE_TAG=sha-<short>   # or latest / 1.2.3
export MONEXUS_PULL_POLICY=always      # recommended when using :latest
npm run prod:up                        # compose pulls images when needed
npm run prod:ps
npm run prod:smoke
```

No local application build is required on the host; only Docker Compose, Postgres data volumes, and a valid `.env`.

### Path B — Build images on the host

Use when GHCR is unavailable or you are rehearsing offline:

```bash
npm run prod:env
npm run prod:build    # docker compose -f docker-compose.prod.yml build
npm run prod:up
npm run prod:smoke

# Or full gate (env + config + build + up + smoke):
npm run prod:gate
```

Compose still defines `build:` contexts for `server` and `web`, so local builds work alongside `image:` references.

### Path C — Non-Docker artifact deploy (fallback)

GitHub Actions can still produce tar artifacts and deploy over SSH to a host running **nginx + systemd** (or PM2), with release trees under `/opt/monexus/`:

- Build artifacts: [`.github/workflows/cd.yml`](./.github/workflows/cd.yml)
- SSH deploy: [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)

Details: [`docs/operations/deployment-target.md`](./docs/operations/deployment-target.md).

### Ops references

- [`docs/operations/runbook.md`](./docs/operations/runbook.md) — start/stop, health, backup, staging compose
- [`docs/operations/deployment-target.md`](./docs/operations/deployment-target.md) — host model choices
- [`docs/operations/rollback-runbook.md`](./docs/operations/rollback-runbook.md)
- [`docs/operations/secrets-management.md`](./docs/operations/secrets-management.md)

---

## Documentation

| Document | Description |
| --- | --- |
| [`docs/superpowers/specs/2026-04-30-monexus-product-prd.md`](./docs/superpowers/specs/2026-04-30-monexus-product-prd.md) | Product PRD & milestones |
| [`docs/superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md`](./docs/superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md) | Merchant settlement contract |
| [`docs/superpowers/specs/monexus-api-openapi.json`](./docs/superpowers/specs/monexus-api-openapi.json) | OpenAPI surface |
| [`docs/operations/`](./docs/operations/) | Runbooks, gray release, alerts |
| [`docs/archive/`](./docs/archive/) | Historical plans, MVP prototype, design handoffs (read-only) |
| [`design-system/monexus/MASTER.md`](./design-system/monexus/MASTER.md) | UI design system |

---

## Contributing

This repository is primarily an **internal product**. If you have access and want to contribute:

1. Create a feature branch from `master` (e.g. `feat/short-description`).
2. Keep changes focused; follow existing module boundaries under `server/src/modules/` and `src/pages/`.
3. Run `npm run verify:local:no-e2e` (or full `verify:local`) before opening a PR.
4. Prefer small PRs with clear motivation; update docs under `docs/` when behavior or ops procedures change.
5. Never commit `.env`, secrets, or production dumps.

For large design changes, start from the PRD / design specs in `docs/superpowers/`.

---

## License

**Private / proprietary.** All rights reserved by the project owners.

This codebase is intended for authorized internal use. Redistribution or commercial use outside the owning organization is not permitted unless a separate license is granted in writing.

---

## Acknowledgments

- Product & engineering milestones M1–M9 (MVP → fulfillment state machine → reviews → production ops)
- Design system tokens and UI redesign handoff under `design-system/monexus/`
- Open-source dependencies: React, Express, Prisma, Vite, Tailwind, Playwright, Vitest, and the broader ecosystem

---

<p align="center">
  <sub>MoNexus — points in, digital value out. Built for internal welfare at scale (100–10,000 users gray launch).</sub>
</p>
