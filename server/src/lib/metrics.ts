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
