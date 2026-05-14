import { afterEach, describe, expect, it } from 'vitest'
import { api } from './helpers.js'
import { config } from '../config/index.js'

const mutableConfig = config as typeof config & { metricsToken?: string }

describe('GET /api/metrics', () => {
  afterEach(() => {
    mutableConfig.metricsToken = undefined
  })

  it('returns Prometheus text format with default process metrics', async () => {
    const res = await api.get('/api/metrics').expect(200)

    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.text).toContain('monexus_process_cpu_user_seconds_total')
    expect(res.text).toContain('monexus_nodejs_eventloop_lag_seconds')
  })

  it('records HTTP requests in the counter', async () => {
    await api.get('/api/health').expect(200)

    const res = await api.get('/api/metrics').expect(200)
    expect(res.text).toMatch(
      /monexus_http_requests_total\{method="GET",route="\/api\/health",status_code="200"\} [1-9]\d*/
    )
  })

  it('records request duration in the histogram', async () => {
    await api.get('/api/health').expect(200)

    const res = await api.get('/api/metrics').expect(200)
    expect(res.text).toContain('monexus_http_request_duration_seconds_bucket')
    expect(res.text).toContain('monexus_http_request_duration_seconds_count')
    expect(res.text).toContain('monexus_http_request_duration_seconds_sum')
  })

  it('requires a matching bearer token when METRICS_TOKEN is configured', async () => {
    mutableConfig.metricsToken = 'test-metrics-token'

    await api.get('/api/metrics').expect(401)
    await api.get('/api/metrics').set('Authorization', 'Bearer wrong-token').expect(401)

    const res = await api
      .get('/api/metrics')
      .set('Authorization', 'Bearer test-metrics-token')
      .expect(200)

    expect(res.text).toContain('monexus_process_cpu_user_seconds_total')
  })
})
