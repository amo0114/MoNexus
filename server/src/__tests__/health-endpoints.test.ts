import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { app } from '../app.js'
import { prisma } from '../lib/prisma.js'

describe('Health endpoints', () => {
  describe('GET /api/health/live', () => {
    it('always returns 200 with liveness payload', async () => {
      const res = await request(app).get('/api/health/live').expect(200)

      expect(res.body).toEqual({
        status: 'live',
        uptime: expect.any(Number),
        timestamp: expect.any(String),
      })
      expect(Date.parse(res.body.timestamp)).not.toBeNaN()
    })

    it('does not hit the database', async () => {
      const spy = vi.spyOn(prisma, '$queryRaw')

      try {
        await request(app).get('/api/health/live').expect(200)
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('GET /api/health/ready', () => {
    it('returns 200 with ready status when DB is reachable', async () => {
      const res = await request(app).get('/api/health/ready').expect(200)

      expect(res.body).toEqual({
        status: 'ready',
        checks: {
          database: 'ok',
          config: 'ok',
        },
        timestamp: expect.any(String),
      })
      expect(Date.parse(res.body.timestamp)).not.toBeNaN()
    })

    it('returns 503 with unready status when DB ping fails', async () => {
      const spy = vi
        .spyOn(prisma, '$queryRaw')
        .mockRejectedValueOnce(new Error('connection refused'))

      try {
        const res = await request(app).get('/api/health/ready').expect(503)

        expect(res.body).toEqual({
          status: 'unready',
          checks: {
            database: 'fail',
            config: 'ok',
          },
          timestamp: expect.any(String),
          error: expect.stringMatching(/database/),
        })
        expect(Date.parse(res.body.timestamp)).not.toBeNaN()
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('GET /api/health (legacy alias)', () => {
    it('behaves as /live and returns 200', async () => {
      const res = await request(app).get('/api/health').expect(200)

      expect(res.body).toEqual({
        status: 'live',
        uptime: expect.any(Number),
        timestamp: expect.any(String),
      })
      expect(Date.parse(res.body.timestamp)).not.toBeNaN()
    })

    it('does not hit the database', async () => {
      const spy = vi.spyOn(prisma, '$queryRaw')

      try {
        await request(app).get('/api/health').expect(200)
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })
  })
})
