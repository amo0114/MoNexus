import { describe, expect, it, vi } from 'vitest'
import { api } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('GET /api/health', () => {
  it('should behave as the legacy liveness alias', async () => {
    const res = await api.get('/api/health').expect(200)

    expect(res.body).toEqual({
      status: 'live',
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    })
    expect(Date.parse(res.body.timestamp)).not.toBeNaN()
  })

  it('should not hit postgres for the legacy liveness alias', async () => {
    const spy = vi
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('db unavailable'))

    try {
      await api.get('/api/health').expect(200)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('should not get rate limited', async () => {
    const spy = vi
      .spyOn(prisma, '$queryRaw')
      .mockResolvedValue([])

    try {
      for (let i = 0; i < 305; i++) {
        const res = await api.get('/api/health')
        expect(res.status).toBe(200)
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
