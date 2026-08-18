export const VALUE_POLICY_ALERT_SEVERITIES = ['P0', 'P1'] as const
export type ValuePolicyAlertSeverity = typeof VALUE_POLICY_ALERT_SEVERITIES[number]

export const VALUE_POLICY_ALERT_ROUTES = [
  'value-policy-p0',
  'value-policy-p1',
] as const
export type ValuePolicyAlertRoute = typeof VALUE_POLICY_ALERT_ROUTES[number]

export type ValuePolicyAlert = {
  id: string
  name: string
  severity: ValuePolicyAlertSeverity
  routingLabel: ValuePolicyAlertRoute
  expr: string
  for: string
  summary: string
}

/**
 * Machine-readable Prometheus alert contract.
 * External Sentry/Alertmanager instances are NOT created by this repository.
 */
export const VALUE_POLICY_ALERTS = [
  {
    id: 'value-policy-unavailable',
    name: 'MoNexus Value policy unavailable',
    severity: 'P0',
    routingLabel: 'value-policy-p0',
    expr: 'increase(value_policy_resolution_total{result="unavailable",mode=~"shadow|enforce"}[5m]) > 0',
    for: '2m',
    summary: 'shadow/enforce has no unique usable active CNY policy',
  },
  {
    id: 'value-policy-multiple-or-invalid',
    name: 'MoNexus Value policy invariant broken',
    severity: 'P0',
    routingLabel: 'value-policy-p0',
    expr: 'increase(value_policy_resolution_total{result=~"multiple|invalid"}[5m]) > 0',
    for: '0m',
    summary: 'multiple active policies or an internally invalid active policy',
  },
  {
    id: 'value-policy-asset-illegal',
    name: 'MoNexus Value policy asset illegal',
    severity: 'P0',
    routingLabel: 'value-policy-p0',
    expr: 'increase(value_policy_resolution_total{result="invalid"}[5m]) > 0',
    for: '0m',
    summary: 'active policy asset kind/scale/enabled/retiredAt is illegal',
  },
  {
    id: 'order-pricing-snapshot-missing',
    name: 'MoNexus Enabled-mode order missing snapshot',
    severity: 'P0',
    routingLabel: 'value-policy-p0',
    expr: '(increase(order_value_policy_enabled_committed_total[15m]) - increase(order_pricing_snapshot_created_total[15m])) > 0 or value_policy_missing_snapshot_orders > 0',
    for: '15m',
    summary: 'enabled-mode committed orders exceed committed snapshots, or the last audit gauge is non-zero',
  },
  {
    id: 'order-pricing-snapshot-inconsistent',
    name: 'MoNexus Order pricing snapshot inconsistent',
    severity: 'P0',
    routingLabel: 'value-policy-p0',
    expr: 'increase(order_pricing_snapshot_failure_total[10m]) > 0',
    for: '5m',
    summary: 'snapshot validation, trigger/FK, or transaction commit is failing',
  },
  {
    id: 'order-pricing-snapshot-failure-rising',
    name: 'MoNexus Order pricing snapshot failures rising',
    severity: 'P1',
    routingLabel: 'value-policy-p1',
    expr: 'increase(order_pricing_snapshot_failure_total[15m]) >= 5',
    for: '10m',
    summary: 'snapshot failures are accumulating',
  },
  {
    id: 'value-policy-changed-elevated',
    name: 'MoNexus VALUE_POLICY_CHANGED rate elevated',
    severity: 'P1',
    routingLabel: 'value-policy-p1',
    expr: 'increase(value_policy_changed_total[10m]) >= 20',
    for: '10m',
    summary: 'clients are confirming a stale or unusable value policy at an abnormal rate',
  },
] as const satisfies readonly ValuePolicyAlert[]

export const VALUE_POLICY_ALERT_IDS = VALUE_POLICY_ALERTS.map(alert => alert.id)

export const VALUE_POLICY_ALERT_DOC_PATH = 'docs/operations/value-policy-alerts.md'
export const VALUE_POLICY_ALERT_RULES_PATH = 'docs/operations/value-policy-alerts.rules.yml'
