import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

function appWithTrust(hops: number) {
  const app = express()
  app.set('trust proxy', hops)
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip })
  })
  return app
}

describe('Express trust proxy hop contract', () => {
  it('with 2 hops returns the canonical client and ignores a spoofed leftmost XFF', async () => {
    const res = await request(appWithTrust(2))
      .get('/ip')
      .set('X-Forwarded-For', '8.8.8.8, 203.0.113.50, 192.168.208.1')
      .expect(200)

    expect(res.body.ip).toBe('203.0.113.50')
  })

  it('with 1 hop returns the OpenResty hop, not the canonical client', async () => {
    const res = await request(appWithTrust(1))
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.50, 192.168.208.1')
      .expect(200)

    expect(res.body.ip).toBe('192.168.208.1')
  })

  it('with 0 hops uses the socket address and ignores XFF', async () => {
    const res = await request(appWithTrust(0))
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.50, 192.168.208.1')
      .expect(200)

    expect(res.body.ip === '127.0.0.1' || res.body.ip === '::ffff:127.0.0.1' || res.body.ip === '::1').toBe(true)
  })
})
