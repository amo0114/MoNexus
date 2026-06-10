# MoNexus Go-Live and Card-Shop Upgrade Plan

Date: 2026-06-06
Scope: execute the current internal points-based marketplace first, then evolve it into a cash-payment card shop without destabilizing inventory or fulfillment.

## Current Decision

Run this in two phases:

1. Stabilize and gray-launch the existing points-based digital goods platform.
2. Add a real-payment card-shop transaction layer after the current order, inventory, and admin operations are verified in production-like use.

Do not wire a payment gateway directly into the current `createOrder` flow. The existing flow assumes points are already spendable at order creation time. Cash payment needs a separate payable order state, payment ledger, webhook idempotency, inventory reservation, and timeout handling.

## Phase 1: Gray-Launch the Current Platform

Goal: make the existing points-based product operationally reliable enough for a small controlled launch.

### Task Order

1. Runtime and dependency contract
   - Pin local runtime to Node.js 20 and npm 10.
   - Fail fast when local commands run on the wrong major version.
   - Reinstall dependencies under the pinned runtime and commit clean lockfiles.

2. Build and test gate
   - Run backend typecheck/build.
   - Run frontend typecheck/build.
   - Run backend Vitest suite against an isolated PostgreSQL database.
   - Run Playwright E2E against seeded fixtures.
   - Local command: `npm run verify:local` from the repository root.
   - Faster build/test command without browser E2E: `npm run verify:local:no-e2e`.

3. Production configuration gate
   - Fill production `.env` from `.env.example`.
   - Fill staging `.env.staging.local` from `.env.staging.example` before any rehearsal that should not touch production values.
   - Confirm PostgreSQL, object storage, SMTP, Sentry/GlitchTip, metrics token, frontend origin, and backup/restore values.
   - Keep `COOKIE_SECURE=true` for HTTPS production.
   - Template lint: `npm run prod:env:staging-template`.
   - Staging check: `npm run prod:env:staging`.
   - Production check: `npm run prod:env -- --mode production --env-file .env`.

4. Deployment rehearsal
   - Run `npm run prod:config` first; this can render with `.env.example` when real `.env` is absent.
   - With a real staging or production env file, rerun `ENV_FILE=.env.staging.local npm run prod:config`.
   - Build production images.
   - Start the production compose stack in a staging namespace or host.
   - Smoke `/api/health/live`, `/api/health/ready`, `/api/metrics` with token when configured, and the SPA root.
   - Compose uses `COMPOSE_PROJECT_NAME=monexus-prod` by default so it does not collide with the dev compose stack.
   - Compose command sequence with a real env file: `npm run prod:env -- --mode staging --env-file .env.staging.local`, `ENV_FILE=.env.staging.local npm run prod:build`, `ENV_FILE=.env.staging.local npm run prod:up`, `ENV_FILE=.env.staging.local npm run prod:ps`, `ENV_FILE=.env.staging.local REQUIRE_METRICS_TOKEN=true npm run prod:smoke`.
   - For bundled MinIO and Mailpit rehearsal, prefix build/up/ps with `COMPOSE_PROFILES=selfhost-storage,staging-mail`.
   - Single production compose rehearsal command after `.env` is filled: `npm run prod:gate`.

5. Operational rehearsal
   - Seed or create admin, merchant, product, inventory, and buyer accounts.
   - Exercise: merchant apply, admin approve, product create, inventory import, user redeem, order detail copy, dispute, close, settlement gating, batch settlement.
   - Confirm admin logs and point logs exist for every privileged or balance-changing operation.

6. Data protection and incident readiness
   - Run database backup workflow or `scripts/backup.sh`.
   - Restore the backup into staging and run row-count sanity checks with `npm run backup:restore-check`.
   - Confirm rollback path from `docs/operations/rollback-runbook.md`.
   - Confirm alert routing and Sentry alert rules in staging.

7. Gray launch
   - Invite 20-50 users.
   - Limit initial product categories and inventory volume.
   - Review errors, slow endpoints, failed mail, stock mismatches, and manual support cases daily.

### Phase 1 Exit Criteria

- Clean `git status` except intentional deployment environment files outside the repo.
- Frontend build, backend build, backend tests, and E2E pass on Node.js 20.
- Production-like stack passes live and ready health checks.
- At least one backup has been restored successfully into staging.
- A full user, merchant, admin operating loop has been rehearsed without direct database edits.

## Phase 2: Real-Payment Card-Shop Upgrade

Goal: add cash purchase while preserving the points-based flow as a separate mode.

### Code Change Order

1. Domain design and schema
   - Add `PaymentOrder` for buyer-facing payable orders.
   - Add `PaymentTransaction` or `PaymentEvent` for gateway attempts, callbacks, and idempotency keys.
   - Add inventory reservation fields or a new `InventoryReservation` table.
   - Add statuses: `unpaid`, `paying`, `paid`, `delivering`, `delivered`, `closed`, `refunded`, `failed`.

2. Payment provider abstraction
   - Introduce provider interface: create payment, verify callback signature, normalize event, query payment.
   - Start with one provider only; keep the interface narrow.
   - Store raw callback payload hash or compact metadata for audit, not secrets.

3. Checkout API
   - Create payable order without immediately consuming points or marking inventory sold.
   - Reserve inventory for instant-delivery goods.
   - Return provider checkout URL, QR code payload, or redirect data.

4. Webhook API
   - Validate signature before touching state.
   - Deduplicate by provider event id and local payment id.
   - Transition payment and order in one database transaction.
   - On success, atomically mark inventory sold and create `DeliveryRecord`.

5. Expiration and recovery
   - Close unpaid orders after timeout.
   - Release reservations for expired unpaid orders.
   - Add admin repair actions for paid-but-undelivered, duplicate callback, and manual refund cases.

6. Admin and user UI
   - Add checkout page and payment-result page.
   - Add admin payment ledger, callback logs, resend/reconcile controls, and refund/manual-close actions.
   - Keep delivery content hidden in list views and visible only in detail views.

7. Reconciliation and observability
   - Add payment metrics and structured logs.
   - Add daily provider reconciliation job or manual import.
   - Alert on paid orders without delivery, webhook signature failures, and inventory reservation leaks.

### Phase 2 Guardrails

- Payment callbacks must be idempotent.
- Inventory is never sold twice.
- Paid orders are never silently dropped.
- Refund or reversal always writes an auditable balance/order/payment event.
- Points redemption and cash purchase remain separate code paths until both are proven stable.
