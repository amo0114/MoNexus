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
