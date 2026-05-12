import { describe, expect, it } from 'vitest'
import { api } from './helpers.js'

describe('observability middleware', () => {
  it('should generate a request id for health without changing the health body', async () => {
    const res = await api.get('/api/health').expect(200)

    expect(res.headers['x-request-id']).toEqual(expect.any(String))
    expect(res.body).toEqual({
      status: 'ok',
      db: 'ok',
      time: expect.any(String),
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
      status: 'ok',
      db: 'ok',
      time: expect.any(String),
    })
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
