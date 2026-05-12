import { describe, expect, it, vi } from 'vitest'
import { api } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('GET /api/health', () => {
  it('should return ok when postgres is reachable', async () => {
    const res = await api.get('/api/health').expect(200)

    expect(res.body).toEqual({
      status: 'ok',
      db: 'ok',
      time: expect.any(String),
    })
    expect(Date.parse(res.body.time)).not.toBeNaN()
  })

  it('should return fail when the postgres probe fails', async () => {
    const spy = vi
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('db unavailable'))

    try {
      const res = await api.get('/api/health').expect(503)

      expect(res.body).toEqual({
        status: 'fail',
        db: 'fail',
        time: expect.any(String),
      })
      expect(Date.parse(res.body.time)).not.toBeNaN()
    } finally {
      spy.mockRestore()
    }
  })
})
