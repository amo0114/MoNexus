import client from 'prom-client'

export const registry = new client.Registry()

client.collectDefaultMetrics({
  register: registry,
  prefix: 'monexus_',
})

export const httpRequestsTotal = new client.Counter({
  name: 'monexus_http_requests_total',
  help: 'Total HTTP requests by method, route, and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
})

export const httpRequestDuration = new client.Histogram({
  name: 'monexus_http_request_duration_seconds',
  help: 'HTTP request duration in seconds by method, route, and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
})

export const cacheHitsTotal = new client.Counter({
  name: 'monexus_cache_hits_total',
  help: 'Total cache hits by cache name',
  labelNames: ['name'] as const,
  registers: [registry],
})

export const cacheMissesTotal = new client.Counter({
  name: 'monexus_cache_misses_total',
  help: 'Total cache misses by cache name',
  labelNames: ['name'] as const,
  registers: [registry],
})

export const cacheErrorsTotal = new client.Counter({
  name: 'monexus_cache_errors_total',
  help: 'Total cache errors by cache name and operation',
  labelNames: ['name', 'op'] as const,
  registers: [registry],
})

export const cacheInvalidationsTotal = new client.Counter({
  name: 'monexus_cache_invalidations_total',
  help: 'Total cache invalidation attempts by cache name and scope',
  labelNames: ['name', 'scope'] as const,
  registers: [registry],
})

export const cacheInvalidationFailedTotal = new client.Counter({
  name: 'monexus_cache_invalidation_failed_total',
  help: 'Total failed cache invalidation attempts by scope',
  labelNames: ['scope'] as const,
  registers: [registry],
})

export const cacheFallbackDbTotal = new client.Counter({
  name: 'monexus_cache_fallback_db_total',
  help: 'Total DB fallbacks by cache name and reason',
  labelNames: ['name', 'reason'] as const,
  registers: [registry],
})

export const cacheNegativeHitsTotal = new client.Counter({
  name: 'monexus_cache_negative_hits_total',
  help: 'Total negative cache hits by cache name',
  labelNames: ['name'] as const,
  registers: [registry],
})

export const cacheInflightRequests = new client.Gauge({
  name: 'monexus_cache_inflight_requests',
  help: 'Current process-local cache singleflight requests by cache name',
  labelNames: ['name'] as const,
  registers: [registry],
})

export const cacheValueBytes = new client.Histogram({
  name: 'monexus_cache_value_bytes',
  help: 'Serialized cache value size in bytes by cache name',
  labelNames: ['name'] as const,
  buckets: [512, 1024, 4096, 16_384, 65_536, 262_144, 524_288, 1_048_576],
  registers: [registry],
})

export const cacheFillDuration = new client.Histogram({
  name: 'monexus_cache_fill_duration_seconds',
  help: 'Cache fallback fill duration in seconds by cache name',
  labelNames: ['name'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})

export const redisCommandDuration = new client.Histogram({
  name: 'monexus_redis_command_duration_seconds',
  help: 'Redis command duration in seconds by operation',
  labelNames: ['op'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.08, 0.1, 0.25, 0.5, 1],
  registers: [registry],
})

export const redisCircuitState = new client.Gauge({
  name: 'monexus_redis_circuit_state',
  help: 'Redis circuit state: 0 closed, 1 open',
  labelNames: ['state'] as const,
  registers: [registry],
})

export const redisStatus = new client.Gauge({
  name: 'monexus_redis_status',
  help: 'Redis status: 0 disabled, 1 ok, 2 degraded',
  labelNames: ['status'] as const,
  registers: [registry],
})

// --- Registration abuse protection ---
//
// These dimensions are deliberately finite and code-owned. Never pass raw
// email/IP/user/invite-code/provider-error data to a Prometheus label: one
// unbounded label would turn the monitoring endpoint into an identifier store
// and can exhaust the metrics process.

export const ABUSE_METRIC_FLOWS = [
  'registration',
  'challenge',
  'verification_email',
  'password_reset',
  'email_verification',
  'referral',
  'reward',
] as const
export type AbuseMetricFlow = typeof ABUSE_METRIC_FLOWS[number]

export const ABUSE_METRIC_OUTCOMES = [
  'attempted',
  'accepted',
  'rejected',
  'rate_limited',
  'failed',
  'unavailable',
  'succeeded',
  'qualified',
  'quota_exhausted',
  'granted',
  'voided',
  'suspended',
  'restored',
] as const
export type AbuseMetricOutcome = typeof ABUSE_METRIC_OUTCOMES[number]

export const ABUSE_METRIC_REASONS = [
  'none',
  'registration_disabled',
  'validation_failed',
  'duplicate_email',
  'rate_limited',
  'missing_token',
  'invalid_token',
  'provider_rejected',
  'provider_unavailable',
  'redis_unavailable',
  'daily_limit',
  'lifetime_limit',
  'inviter_ineligible',
  'inviter_suspended',
  'recipient_banned',
  'invite_relation_voided',
  'admin_void',
] as const
export type AbuseMetricReason = typeof ABUSE_METRIC_REASONS[number]

const ABUSE_METRIC_FLOW_SET = new Set<string>(ABUSE_METRIC_FLOWS)
const ABUSE_METRIC_OUTCOME_SET = new Set<string>(ABUSE_METRIC_OUTCOMES)
const ABUSE_METRIC_REASON_SET = new Set<string>(ABUSE_METRIC_REASONS)

export const abuseEventsTotal = new client.Counter({
  name: 'monexus_abuse_events_total',
  help: 'Registration abuse-protection outcomes using fixed low-cardinality labels',
  labelNames: ['flow', 'outcome', 'reason'] as const,
  registers: [registry],
})

export const abuseOperationDuration = new client.Histogram({
  name: 'monexus_abuse_operation_duration_seconds',
  help: 'Registration abuse-protection operation duration by fixed flow and outcome',
  labelNames: ['flow', 'outcome'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 3, 5],
  registers: [registry],
})

function assertAbuseMetricLabel(
  flow: string,
  outcome: string,
  reason: string,
): asserts flow is AbuseMetricFlow {
  if (
    !ABUSE_METRIC_FLOW_SET.has(flow)
    || !ABUSE_METRIC_OUTCOME_SET.has(outcome)
    || !ABUSE_METRIC_REASON_SET.has(reason)
  ) {
    throw new Error('abuse metric labels must use the fixed vocabulary')
  }
}

/**
 * The only supported counter write API. It validates all label values before
 * prom-client sees them, preventing future callers from smuggling identifiers
 * or provider text into the metrics registry.
 */
export function recordAbuseMetric(input: {
  flow: AbuseMetricFlow
  outcome: AbuseMetricOutcome
  reason?: AbuseMetricReason
}) {
  const reason = input.reason ?? 'none'
  assertAbuseMetricLabel(input.flow, input.outcome, reason)
  abuseEventsTotal.inc({ flow: input.flow, outcome: input.outcome, reason })
}

/** Record a fixed-label latency observation without allowing an arbitrary reason label. */
export function observeAbuseOperationDuration(
  input: { flow: AbuseMetricFlow; outcome: AbuseMetricOutcome },
  seconds: number,
) {
  assertAbuseMetricLabel(input.flow, input.outcome, 'none')
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('abuse operation duration must be a non-negative finite number')
  }
  abuseOperationDuration.observe({ flow: input.flow, outcome: input.outcome }, seconds)
}

// --- FakaBridge (Xboard provision) ---

export const fakaProvisionTotal = new client.Counter({
  name: 'monexus_faka_provision_total',
  help: 'FakaBridge provision outcomes',
  labelNames: ['outcome'] as const, // succeeded | failed | retry_scheduled | skipped
  registers: [registry],
})

export const fakaRevokeTotal = new client.Counter({
  name: 'monexus_faka_revoke_total',
  help: 'FakaBridge revoke outcomes after refund',
  labelNames: ['outcome'] as const, // succeeded | failed | skipped
  registers: [registry],
})

export const fakaReconcileTotal = new client.Counter({
  name: 'monexus_faka_reconcile_total',
  help: 'FakaBridge reconcile actions',
  labelNames: ['action'] as const,
  registers: [registry],
})

export const fakaCapacityProbeTotal = new client.Counter({
  name: 'monexus_faka_capacity_probe_total',
  help: 'Xboard capacity precheck results',
  labelNames: ['source'] as const, // xboard | unavailable
  registers: [registry],
})

export const fakaTasksGauge = new client.Gauge({
  name: 'monexus_faka_tasks',
  help: 'Current FakaBridgeTask counts by status (polled by cron)',
  labelNames: ['status'] as const,
  registers: [registry],
})

export const fakaRevokePendingGauge = new client.Gauge({
  name: 'monexus_faka_revoke_pending',
  help: 'FakaBridge tasks waiting for Xboard revoke',
  registers: [registry],
})
