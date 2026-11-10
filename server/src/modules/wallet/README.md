# Wallet Module

The single writer of real point balances. Every change to `PointAccount`
(available / frozen), to the point sources behind it, and every `PointLog` row
goes through one wallet command inside the caller's transaction. Business
eligibility (may this order refund? is this settlement payable? did the payment
succeed?) stays with the calling module; wallet only enforces point-level rules.
The architecture check rejects ledger writes anywhere else (the dev seed is the
only exception).

## Model

| Table | Role |
| --- | --- |
| `WalletOperation` | One successful operation, keyed by a business-derived `operationKey`. Replaying the same key with the same parameters returns the stored result; different parameters → `409 IDEMPOTENCY_KEY_REUSED`. Links its `PointLog`. |
| `PointLot` | One original credit source: `recharge`, `reward`, `merchant_settlement`, `admin_adjustment`, `legacy_unknown`. `issued = available + frozen + consumed` (DB CHECK). Not a withdrawal entitlement. |
| `WalletAllocation` | Immutable movement of one operation on one lot. Captures, releases and refunds reference the allocation they settle. |

Invariants, all maintained in the same transaction:

```
PointAccount.balance       = Σ lots.availablePoints   (per user)
PointAccount.frozenBalance = Σ lots.frozenPoints      (per user)
```

`findWalletInvariantViolations()` reports differences read-only; nothing ever
overwrites one side from the other. The administrator sandbox bucket is not a lot.

## Commands

| Command | Movement |
| --- | --- |
| `creditInTx` | new lot (amount 0 writes the log only) |
| `spendInTx` | available → consumed, FIFO over lots (optionally filtered / preferred / partial) |
| `reserveInTx` | available → frozen on fixed lots |
| `captureInTx` / `reverseReservedInTx` | frozen → consumed on the reserve's own allocations (`reversal` = funding payment withdrawn) |
| `releaseInTx` | frozen → available on the reserve's own allocations |
| `refundInTx` | consumed → available on the original allocations: rewards come back as rewards, unknown stays unknown |
| `noteInTx` | log only (pre-frozenBalance order compatibility) |
| `creditSandboxInTx` | administrator sandbox bucket |

Every command locks the account row first; all lot writes for a user happen
under that lock. Multi-account use cases call `lockAccountsInTx` with the full
account set (sorted) after their business-root locks and never take an upstream
lock afterwards.

## Legacy balances

The migration records each account's existing balance and freeze as one
`legacy_unknown` lot (`wallet-init:<userId>`). Accounts created without a wallet
operation (fixtures, the dev seed) get the same treatment on first use; after
`walletInitializedAt` is set a mismatch is an error, never a resync.

- Freezes made before wallet (orders, refund/dispute `PointHold`s) are captured
  or released with `legacyAmount`, taken only from that legacy lot.
- Consumption made before wallet is refunded with `refundInTx(..., legacyAmount)`:
  the caller proves the old debit (orders require the old `PointLog` debit of the
  exact order); the returned points become a new `legacy_unknown` lot. The shared
  refund key (`order:<id>:refund`, …) bounds it to once.

## Keys in use

| Key | Source |
| --- | --- |
| `order:<id>:spend` / `:reserve` / `:capture` / `:release` / `:refund` | orders (`orders/accounting.ts`) |
| `settlement:<id>:credit` | merchantFinance batch credit |
| `after-sales:<caseId>:clawback`, `merchant-recovery:<caseId>:<requestKey>` | merchantFinance reversal / recovery |
| `recharge-credit:<rechargeOrderId>` | recharge credit |
| `recharge-refund:<refundId>:reserve` / `:release` / `:reversal` | recharge cash refund |
| `payment-dispute:<disputeId>:reserve` / `:reversal` / `:release` / `:restore` | payment disputes |
| `checkin:<userId>:<date>`, `checkin-makeup:<userId>:<date>`, `checkin-reward:<id>` | points |
| `growth-reward:<id>` | auth growth rewards |
| `promotion:<campaignId>:charge` / `:refund` | merchandising promotions |
| `admin-adjust:<uuid>` | admin point adjustment (self-adjustment is rejected) |

## Growth eligibility

`PointLog.growthEligible` is set at write time (reward-like credits only) and
`lib/memberTier.ts GROWTH_LOG_WHERE` is the one rule used by tier, invite
thresholds and the leaderboard. Recharge, settlement income and refunds never
count. The migration flagged existing `in` rows except provable recharge credits.
