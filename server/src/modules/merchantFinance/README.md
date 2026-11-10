# Merchant Finance Module

Owns merchant earnings: `Settlement` creation and voiding, settleability,
settlement batches, after-sales reversals and merchant recovery. Earnings are
platform points credited to the merchant's existing `PointAccount`
(`merchant_settlement` lots); none of this is withdrawable cash. It writes points
only through `wallet` and never calls order workflows — orders orchestrate it
inside their own transaction.

## Records

| Table | Role |
| --- | --- |
| `Settlement` | Per-order earning, snapshotted at checkout (unchanged authority). |
| `SettlementBatch` / `SettlementBatchItem` | One submitted, all-or-nothing set (≤ 100) and which account received how much, with the wallet operation. Settled rows without an item predate batches: shown read-only as "历史入账凭证不完整" and never credited again. |
| `SettlementAdjustment` | Later change to a settled earning (full after-sales reversal of net amount and commission). Never rewrites `Settlement`. |
| `MerchantRecoveryCase` / `MerchantRecoveryAction` | Shortfall when the merchant's available settlement points could not cover a reversal; each wallet clawback, offline receipt or waiver is an evidenced action. |

## Settleable

`pending` + order `closed` (`settlementPolicy.ts`, pure) + no open after-sales
case on the order + no open recovery case for the merchant. List badges, preview
and execute share `batches.ts evaluate()`; execute re-checks under locks.

## Endpoints (admin, behind admin + MFA)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/settlements?status=` | Entries with `payable`, `blockReason`, `netAmount`, `credit`, `adjustments`. |
| POST | `/api/admin/settlements/preview` | `settlementIds` → per-item verdicts. No locks, no promise. |
| POST | `/api/admin/settlements/batch-settle` | `settlementIds`, optional `requestKey`. Same key + same ids replays the batch (`replayed: true`); same key + other ids → 409. Without a key a repeat is simply rejected as not settleable. |
| GET | `/api/admin/settlement-batches`, `/:id` | Batches and items with wallet vouchers. |
| GET | `/api/admin/merchant-recovery-cases` | Open/closed shortfalls with `allowedActions`. |
| POST | `/api/admin/merchant-recovery-cases/:id/actions` | `kind` = `wallet_clawback` \| `offline_received` \| `waived`, `amount` ≤ outstanding, `requestKey`; offline/waiver require `evidence`. |

Merchant: `GET /api/merchant/finance/summary` (net earned, awaiting completion,
settleable, credited, clawed back, outstanding recovery, wallet balance) and
`GET /api/merchant/finance/entries` (paged). Dashboard figures use the same summary.

## Locks

- Batch: Order (id) → Settlement (id) → Merchant (id) → merchant accounts (userId) → lots.
- After-sales reversal (called by orders): Order → case → Settlement → Merchant → buyer + merchant accounts.
- Recovery action: Merchant → case → merchant account; never Order/Settlement.

The Merchant row is the per-merchant barrier: settlement and recovery creation /
closure serialize on it, so a shortfall opened concurrently always blocks the
next batch for that merchant.

## Clawback scope

Only available `merchant_settlement` points (that order's lot first) are taken —
never frozen points, recharge, reward or `legacy_unknown`. What cannot be taken
becomes a recovery case; the buyer refund never fails because of it. Whether a
merchant's other sources may be used is a pending policy decision.
