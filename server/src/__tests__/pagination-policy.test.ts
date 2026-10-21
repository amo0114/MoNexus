import { afterEach, describe, expect, it } from 'vitest'
import { normalizePagination } from '../lib/paginationPolicy.js'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

afterEach(async () => {
  await prisma.systemConfig.deleteMany({ where: { key: { in: ['defaultPageSize', 'maxPageSize'] } } })
})

describe('configurable pagination contract', () => {
  it('normalizes invalid service inputs and caps the configured default', () => {
    expect(normalizePagination(Infinity, 1.5, { defaultPageSize: 40, maxPageSize: 30 })).toEqual({ page: 1, pageSize: 30 })
    expect(normalizePagination(2, 10000, { defaultPageSize: 20, maxPageSize: 200 })).toEqual({ page: 2, pageSize: 200 })
    expect(normalizePagination(1, 10000, { defaultPageSize: 20, maxPageSize: 10000 }).pageSize).toBe(500)
  })

  it('honors raised and lowered limits through both admin HTTP schemas', async () => {
    const { user, password } = await createTestUser('pagination-policy@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs(user.email, password)
    try {
      for (const [configured, expected] of [[200, 150], [30, 30]] as const) {
        await api.put('/api/admin/config/maxPageSize').set(authHeader(accessToken)).send({ value: configured }).expect(200)
        for (const path of ['/api/admin/users', '/api/admin/orders']) {
          const result = await api.get(path).query({ pageSize: 150 }).set(authHeader(accessToken)).expect(200)
          expect(result.body.pageSize).toBe(expected)
          await api.get(path).query({ pageSize: 501 }).set(authHeader(accessToken)).expect(400)
        }
      }
    } finally {
      await prisma.systemConfig.deleteMany({ where: { key: 'maxPageSize' } })
    }
  })
})
