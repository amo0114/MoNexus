# ValuePolicy Phase 1 Alert Contract

Review date: 2026-08-18. Scope: machine-readable Prometheus alert contract for
`SPEC-VALUE-POLICY-P1-001` closure. This document defines rule names, PromQL,
thresholds, duration, severity, and routing labels.

## Production delivery implementation

The repository contains an opt-in `production-monitoring` Compose profile with
private Prometheus and Alertmanager services. Prometheus loads these rules and
scrapes the backend through a file-backed bearer token; Alertmanager routes P0
and P1 firing/resolved messages through the production SMTP relay to the VPS
`ALERT_EMAIL_TO` value. Neither service publishes a host port. A merge alone
is not delivery evidence: the protected deploy and live rehearsal below must
both succeed.

Labels are a finite vocabulary (`result`, `mode`, no `policyId` / `orderId`).

## Routing

| Routing label | Severity | Primary route | Fallback | Owner |
| --- | --- | --- | --- | --- |
| `value-policy-p0` | P0 | Production Alertmanager email to VPS `ALERT_EMAIL_TO` | Manual escalation to the incident owner | Backend on-call |
| `value-policy-p1` | P1 | Production Alertmanager email to VPS `ALERT_EMAIL_TO` | Manual escalation to the incident owner | Backend on-call |

See `docs/operations/alert-routing.md`.

## Rules

### MoNexus Value policy unavailable

- id: `value-policy-unavailable`
- severity: P0
- routingLabel: `value-policy-p0`
- expr: `increase(value_policy_resolution_total{result="unavailable",mode=~"shadow|enforce"}[5m]) > 0`
- for: `2m`
- meaning: shadow/enforce has no unique usable active CNY policy

### MoNexus Value policy invariant broken

- id: `value-policy-multiple-or-invalid`
- severity: P0
- routingLabel: `value-policy-p0`
- expr: `increase(value_policy_resolution_total{result=~"multiple|invalid"}[5m]) > 0`
- for: `0m`
- meaning: multiple active policies or an internally invalid active policy

### MoNexus Value policy asset illegal

- id: `value-policy-asset-illegal`
- severity: P0
- routingLabel: `value-policy-p0`
- expr: `increase(value_policy_resolution_total{result="invalid"}[5m]) > 0`
- for: `0m`
- meaning: active policy asset kind/scale/enabled/retiredAt is illegal

### MoNexus Enabled-mode order missing snapshot

- id: `order-pricing-snapshot-missing`
- severity: P0
- routingLabel: `value-policy-p0`
- expr: `(increase(order_value_policy_enabled_committed_total[15m]) - increase(order_pricing_snapshot_created_total[15m])) > 0 or value_policy_missing_snapshot_orders > 0`
- for: `15m`
- meaning: committed shadow/enforce orders exceed committed snapshots, or the last read-only audit gauge is non-zero. Do not infer missing snapshots from preview/current `resolution=found`.

### MoNexus Order pricing snapshot inconsistent

- id: `order-pricing-snapshot-inconsistent`
- severity: P0
- routingLabel: `value-policy-p0`
- expr: `increase(order_pricing_snapshot_failure_total[10m]) > 0`
- for: `5m`
- meaning: snapshot validation, trigger/FK, or transaction commit is failing

### MoNexus Order pricing snapshot failures rising

- id: `order-pricing-snapshot-failure-rising`
- severity: P1
- routingLabel: `value-policy-p1`
- expr: `increase(order_pricing_snapshot_failure_total[15m]) >= 5`
- for: `10m`
- meaning: snapshot failures are accumulating

### MoNexus VALUE_POLICY_CHANGED rate elevated

- id: `value-policy-changed-elevated`
- severity: P1
- routingLabel: `value-policy-p1`
- expr: `increase(value_policy_changed_total[10m]) >= 20`
- for: `10m`
- meaning: clients are confirming a stale or unusable value policy at an abnormal rate

## Operator query cheat sheet

```promql
sum by (result, mode) (increase(value_policy_resolution_total[15m]))
increase(value_policy_changed_total[15m])
increase(order_value_policy_enabled_committed_total[15m])
increase(order_pricing_snapshot_created_total[15m])
increase(order_pricing_snapshot_failure_total[15m])
value_policy_missing_snapshot_orders
```

Machine-checkable Prometheus rules live in
`docs/operations/value-policy-alerts.rules.yml` and are mounted read-only into
the production Prometheus container. Alertmanager consumes alerts from
Prometheus; it does not load PromQL rule files itself.

## Deployment and live rehearsal

1. Keep `POINT_VALUE_POLICY_MODE=off`; alert deployment does not authorize a
   production policy or production shadow/enforce.
2. Set one valid `ALERT_EMAIL_TO` in the root-owned VPS `.env`. Keep the
   existing `SMTP_*` and `METRICS_TOKEN` secrets there; do not copy them to the
   repository or workflow logs.
3. Deploy a reviewed master SHA through **Compose Production Deploy**. The
   restricted entry point creates file-backed secret sources, starts private
   Alertmanager then Prometheus, and fails unless the `monexus` target is up
   and the required rules are loaded.
4. Run **Production Monitoring Rehearsal**, select `value-policy-p0`, and type
   `REHEARSE_VALUE_POLICY_EMAIL_PRODUCTION`. The forced command posts one fixed
   synthetic alert, waits for a successful email counter increment, resolves
   it, then requires a second successful increment with no new failure.
5. Confirm both firing and resolved messages in the configured inbox. Workflow
   success proves SMTP acceptance; inbox receipt proves end-to-end delivery.

The synthetic alert is named `MoNexusProductionEmailRehearsal` and cannot
create, approve, schedule, activate, or retire a ValuePolicy.
