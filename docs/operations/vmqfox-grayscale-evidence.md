# VMQFox grayscale evidence (PR-M5)

Date: 2026-09-01. Branch:
`execute-plan/38715d1c-pr-5-ops-closure-and-runbook`.

This is an ops-closure evidence note. It does **not** enable live, does **not**
deploy, and does **not** treat unrun tests as passed.

## Live status

`RECHARGE_MODE` default remains `disabled`. `VMQFOX_MODE` default remains
`disabled`. `PAYMENT_ENABLED_PROVIDERS` samples do not include `vmqfox`.
No production or staging live activation was performed.

## What this PR ran

Isolated database `monexus_test_38715d1c` (created for this PR; not production).

| Command | Exit |
| --- | --- |
| `server/node_modules/.bin/tsc --noEmit` | 0 |
| `prisma migrate deploy` onto `monexus_test_38715d1c` (to host targeted Vitest only) | 0 |
| `vitest run src/__tests__/payment-alerts.test.ts src/__tests__/payment-metrics.test.ts` (8 tests) | 0 |
| `git diff --check` | 0 |

`payment-metrics` proves `vmqfox` is in `PAYMENT_PROVIDER_NAMES`, the new
counters accept that label, unknown names collapse to `unknown`, and both
`.env.example` files keep `VMQFOX_MODE=disabled`. `payment-alerts` proves the
new monitor-offline and callback-retry-exhaustion rules exist in the contract,
YAML, docs, and deploy entrypoint. `promtool check rules` ran in that suite
when the binary existed.

## What prior PRs already covered (not re-run here unless listed)

PR-M2 adapter tests exist for HMAC vectors, monitor_offline, query-by-pay-id
recovery, and `supportsRefunds=false`. PR-M3 has price-policy admin tests.
PR-M4 has product/offer archive tests. This PR does not claim those suites
were re-executed unless the exec summary lists them with exit codes.

## What was NOT run

- Full Playwright / E2E matrix
- Real VMQFox `¥1` / `¥10` staging smokes (plan §9.3 step 4)
- Live `RECHARGE_MODE=live` or `VMQFOX_MODE=live`
- Automatic refund E2E (unsupported)
- Dispute or standard provider reconciliation
- Alertmanager receiver deploy / page drill
- PR-V0 VMQFox-side create/query-by-pay-id deploy verification
- Migration replay, production restore, or compose deploy

## Honest gaps

- OpenAPI JSON stays `1.9.0`; new paths are documented in
  `docs/operations/openapi-vmqfox-lifecycle-note.md` only.
- Prometheus may load `payment-alerts.rules.yml` through the opt-in
  monitoring profile. A merge is not evidence that receivers fire.
- Query-by-pay-id recovery still depends on VMQFox PR-V0. Do not enable
  live without that deploy.
