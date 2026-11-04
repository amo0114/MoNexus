import { describe, expect, it } from 'vitest'
import { api } from './helpers.js'

describe('observability middleware', () => {
  it('should generate a request id for health without changing the health body', async () => {
    const res = await api.get('/api/health').expect(200)

    expect(res.headers['x-request-id']).toEqual(expect.any(String))
    expect(res.body).toEqual({
      status: 'live',
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    })
  })

  it('should echo a provided request id', async () => {
    const requestId = 'client-request-id-123'

    const res = await api
      .get('/api/health')
      .set('x-request-id', requestId)
      .expect(200)

    expect(res.headers['x-request-id']).toBe(requestId)
    expect(res.body).toEqual({
      status: 'live',
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    })
  })

  it('replaces a malformed or oversized request id with a server UUID', async () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (const requestId of ['attacker controlled', 'id<script>', 'short', 'a'.repeat(65), 'x'.repeat(2_000)]) {
      const res = await api
        .get('/api/points/history')
        .set('x-request-id', requestId)
        .expect(401)

      expect(res.headers['x-request-id']).toMatch(uuid)
      expect(res.body.requestId).toBe(res.headers['x-request-id'])
    }
  })

  it('should include request id in error responses', async () => {
    const requestId = 'error-request-id-456'

    const res = await api
      .get('/api/points/history')
      .set('x-request-id', requestId)
      .expect(401)

    expect(res.headers['x-request-id']).toBe(requestId)
    expect(res.body.requestId).toBe(requestId)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })
})
