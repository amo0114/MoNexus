# ValuePolicy Phase 1 Runbook

Scope: `SPEC-VALUE-POLICY-P1-001` CNY ValuePolicy / checkout / order snapshot.
This is **not** the `SPEC-VALUE-LEDGER-001` ledger/lot Phase 1.

Production must stay `POINT_VALUE_POLICY_MODE=off` until D-02 and D-03 are
approved. This runbook does not authorize creating or activating a production
ValuePolicy.

## 1. Pre-checks before staging shadow

1. `POINT_VALUE_POLICY_MODE` is `off` in production and in any shared live DB.
2. `npm --prefix server run value-policy:audit` is clean against the target
   disposable/staging database.
3. Migration `20260817180000_add_value_policy_foundation` and
   `20260818120000_value_policy_phase1_closure` have been applied with
   `prisma migrate deploy`. Never `prisma db push`. Never rewrite a merged
   migration.
4. Only `RP` and `CNY` AssetDefinition rows are required. Do not seed USDT.
5. Active ValuePolicy count is 0 in production.
6. Metrics endpoints expose:
   - `value_policy_resolution_total{result,mode}`
   - `value_policy_changed_total`
   - `order_pricing_snapshot_created_total`
   - `order_pricing_snapshot_failure_total`

## 2. Policy create / approve / schedule / activate / retire

Legal chain only:

```text
draft -> approved -> scheduled -> active -> retired
```

Use the restricted admin + current-MFA routes under
`/api/admin/value-policies`. There is no unauthenticated or public write API.

Rules:

- INSERT must be `draft`.
- `approved` and `scheduled` require `approvedAt`.
- `active` requires `approvedAt` and `activatedAt`.
- `createdAt <= approvedAt <= effectiveAt`
- `createdAt <= activatedAt` and `activatedAt >= effectiveAt`
- `scheduled -> active` only after `effectiveAt`.
- Dual-control human approval is enforced by lifecycle actor columns and the
  database (`createdByUserId != approvedByUserId`). Staging actors must be real
  active admin users with current MFA; never invent production user IDs.

## 3. D-02 / D-03 gates

| Gate | Meaning | Current state |
| --- | --- | --- |
| D-02 | Production face value | Owner directive approved `100 PTS = 1 CNY` under a prelaunch no-representative-data exception. Production enforce is not authorized. |
| D-03 | Production disclosure copy | Owner directive approved exact `zh-CN-v1`; see `value-policy-decision-records.md`. |

Do not create a production active policy. Do not switch production off of
`off`.

## 4. Data backtest before production enforce

Replay real (or desensitized) offer prices through
`convertPointsToReferenceAtomic` with the candidate ratio. Record:

- price distribution
- merchant settlement impact
- reward-budget impact

The initial owner directive does not turn synthetic data into evidence. A
representative-data report and superseding decision record are mandatory before
production enforce. The report itself is not an activation.

## 5. Metrics and alerts

See `docs/operations/value-policy-alerts.md`. External alert objects are not
activated by this repository.

`order_pricing_snapshot_created_total` counts only snapshots whose order
transaction committed. Rolled-back inserts increment
`order_pricing_snapshot_failure_total`.

## 6. 409 / 500 / 503 triage

Frozen interpretation (also in the Phase 1 spec):

| Situation | Code |
| --- | --- |
| Production/off | 404 `VALUE_POLICY_DISABLED` on `/api/value-policy/current`; checkout/order ignore a well-formed policy id |
| enforce missing `expectedValuePolicyId` | 400 `VALUE_POLICY_REQUIRED` before any funds/inventory/order side effects |
| Client sent a concrete id that is missing, draft, approved, scheduled, retired, future, non-CNY, or not the current unique active CNY policy | 409 `VALUE_POLICY_CHANGED` |
| shadow, no id, no unique usable active CNY policy | 503 `VALUE_POLICY_UNAVAILABLE` |
| An active CNY row exists but internals are corrupt | 500 `VALUE_POLICY_DATA_INVALID` |

A concrete but unusable client confirmation is 409, even if the system also
has no replacement policy.

## 7. Snapshot inconsistency

1. Run `npm --prefix server run value-policy:audit`.
2. Compare `Order.price` with `OrderPricingSnapshot.pointsAmountAtomic`.
3. Recompute reference atoms with the snapshotted policy ratio.
4. Do not UPDATE or DELETE snapshots. Forward-fix application code or add a
   new additive migration.

## 8. Lock timeout / concurrency retry

Activation, asset disable/retire, and order policy confirmation share
`pg_advisory_xact_lock(88170001, 1)`.

Safe retry:

- Retry only after a new idempotent command id / request fingerprint.
- Retry `40001` serialization and `55P03` lock timeout by **re-reading** the
  current policy/asset state first.
- Do **not** blindly retry an activation whose result is unknown after a
  connection drop. Inspect the row, then send a new command id.
- Never retry `23514` business rejections (illegal transition, asset in use,
  effectiveAt not reached).
- Never retry `40P01`. The closure lock order must not produce it; if it
  appears, treat it as a P0 incident, not a retry loop.

## 9. Rollback

1. Prefer switching `POINT_VALUE_POLICY_MODE` back to `off`.
2. Do not roll back or rewrite a deployed Prisma migration. Forward-fix only.
3. Do not `UPDATE` a production ValuePolicy row by hand.
4. Do not disable triggers.
5. Do not seed a production active policy.
6. Artifact rollback follows `docs/operations/rollback-runbook.md`.

## 10. Read-only audit

```bash
npm --prefix server run value-policy:audit -- --since=2026-08-18T00:00:00.000Z
```

`--since` (or `VALUE_POLICY_AUDIT_SINCE`) is the inclusive enabled-mode
window. Without it, missing-snapshot checks are skipped so off-era orders
are not false-positives. The command never repairs data. Exit `2` means
findings exist.

Checks:

- active policy count
- active policy asset / ratio / time invariants
- enabled-mode orders missing snapshots
- snapshot vs `Order.price`
- snapshot vs policy ratio
- illegal active USD/USDT policy
