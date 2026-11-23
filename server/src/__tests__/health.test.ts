import { describe, expect, it, vi } from 'vitest'
import { api } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('GET /api/health', () => {
  it.each(['/api/health', '/api/health/live'])('only publishes liveness status at %s', async path => {
    const res = await api.get(path).expect(200)
    expect(res.body).toEqual({ status: 'live' })
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
