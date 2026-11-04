import { describe, expect, it } from 'vitest'
import { api } from './helpers.js'

describe('request body parser errors', () => {
  it('returns 413 PAYLOAD_TOO_LARGE with the standard error shape for a body over the limit', async () => {
    const res = await api
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'big@test.local', password: 'x'.repeat(1024 * 1024) }))
      .expect(413)

    expect(res.body).toEqual({
      requestId: res.headers['x-request-id'],
      error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' },
    })
  })

  it('returns 400 INVALID_JSON for a malformed JSON body', async () => {
    const res = await api
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400)

    expect(res.body).toEqual({
      requestId: res.headers['x-request-id'],
      error: { code: 'INVALID_JSON', message: '请求格式错误' },
    })
  })

  it('still processes a 200 KB body normally', async () => {
    const res = await api
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: 'x'.repeat(200 * 1024) })
      .expect(401)

    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })
})
