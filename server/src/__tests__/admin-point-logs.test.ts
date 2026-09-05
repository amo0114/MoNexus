import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestMerchant, createTestUser, loginAs } from './helpers.js'

async function loginAdmin(email = 'pl-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

async function loginUser(email = 'pl-user@test.local') {
  const { user, password } = await createTestUser(email, 'user123', 'user')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

describe('Admin Point Logs API (PR 03)', () => {
  describe('Authentication & Authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await api.get('/api/admin/point-logs').expect(401)
    })

    it('rejects regular users with 403', async () => {
      const user = await loginUser('pl-regular-user@test.local')
      await api
        .get('/api/admin/point-logs')
        .set(authHeader(user.accessToken))
        .expect(403)
    })

    it('rejects merchant users with 403', async () => {
      const { user, password } = await createTestMerchant('pl-merchant@test.local', 'merch123')
      const { accessToken } = await loginAs(user.email, password)
      await api
        .get('/api/admin/point-logs')
        .set(authHeader(accessToken))
        .expect(403)
    })

    it('allows admin users with 200', async () => {
      const admin = await loginAdmin('pl-auth-admin@test.local')
      const res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body).toHaveProperty('items')
      expect(res.body).toHaveProperty('total')
      expect(res.body).toHaveProperty('page', 1)
      expect(res.body).toHaveProperty('pageSize', 20)
      expect(Array.isArray(res.body.items)).toBe(true)
    })
  })

  describe('Pagination and Item Serialization', () => {
    it('returns default pagination (page 1, pageSize 20) with whitelisted user fields', async () => {
      const admin = await loginAdmin('pl-page-admin@test.local')
      const user = await loginUser('pl-page-user@test.local')

      // Insert test point log
      const log = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'in',
          amount: 1000,
          balanceAfter: 6000,
          reason: '分页测试充值',
        },
      })

      const res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ userId: user.user.id })
        .expect(200)

      expect(res.body.page).toBe(1)
      expect(res.body.pageSize).toBe(20)
      expect(res.body.total).toBeGreaterThanOrEqual(1)

      const found = res.body.items.find((item: any) => item.id === log.id)
      expect(found).toBeDefined()
      expect(found.userId).toBe(user.user.id)
      expect(found.type).toBe('in')
      expect(found.amount).toBe(1000)
      expect(found.balanceAfter).toBe(6000)
      expect(found.reason).toBe('分页测试充值')

      // Check whitelisted user relation fields
      expect(found.user).toBeDefined()
      expect(found.user.id).toBe(user.user.id)
      expect(found.user.email).toBe(user.user.email)
      // Sensitive fields must NOT be leaked
      expect(found.user.password).toBeUndefined()
      expect(found.user.mfaSecretEncrypted).toBeUndefined()
    })

    it('paginates accurately with custom page and pageSize', async () => {
      const admin = await loginAdmin('pl-custom-page-admin@test.local')
      const user = await loginUser('pl-custom-page-user@test.local')

      // Clean pointLogs for this user to have exact count
      await prisma.pointLog.deleteMany({ where: { userId: user.user.id } })

      // Create 5 point logs with distinct timestamps
      const createdIds: number[] = []
      const baseTime = Date.now() - 50000
      for (let i = 0; i < 5; i++) {
        const entry = await prisma.pointLog.create({
          data: {
            userId: user.user.id,
            type: 'in',
            amount: (i + 1) * 100,
            balanceAfter: (i + 1) * 100,
            reason: `分页测试 #${i + 1}`,
            createdAt: new Date(baseTime + i * 1000),
          },
        })
        createdIds.push(entry.id)
      }

      // Page 1 with pageSize 2 (should return newest 2: indices 4, 3)
      const page1Res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ userId: user.user.id, page: 1, pageSize: 2 })
        .expect(200)

      expect(page1Res.body.page).toBe(1)
      expect(page1Res.body.pageSize).toBe(2)
      expect(page1Res.body.total).toBe(5)
      expect(page1Res.body.items).toHaveLength(2)
      expect(page1Res.body.items[0].id).toBe(createdIds[4])
      expect(page1Res.body.items[1].id).toBe(createdIds[3])

      // Page 2 with pageSize 2 (should return indices 2, 1)
      const page2Res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ userId: user.user.id, page: 2, pageSize: 2 })
        .expect(200)

      expect(page2Res.body.page).toBe(2)
      expect(page2Res.body.pageSize).toBe(2)
      expect(page2Res.body.total).toBe(5)
      expect(page2Res.body.items).toHaveLength(2)
      expect(page2Res.body.items[0].id).toBe(createdIds[2])
      expect(page2Res.body.items[1].id).toBe(createdIds[1])

      // Page 3 with pageSize 2 (should return index 0)
      const page3Res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ userId: user.user.id, page: 3, pageSize: 2 })
        .expect(200)

      expect(page3Res.body.page).toBe(3)
      expect(page3Res.body.pageSize).toBe(2)
      expect(page3Res.body.total).toBe(5)
      expect(page3Res.body.items).toHaveLength(1)
      expect(page3Res.body.items[0].id).toBe(createdIds[0])
    })

    it('enforces deterministic sorting by createdAt DESC, id DESC when timestamps are identical', async () => {
      const admin = await loginAdmin('pl-sort-admin@test.local')
      const user = await loginUser('pl-sort-user@test.local')

      await prisma.pointLog.deleteMany({ where: { userId: user.user.id } })

      const fixedTime = new Date('2026-09-01T12:00:00.000Z')
      const log1 = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'in',
          amount: 100,
          balanceAfter: 100,
          reason: 'Same time 1',
          createdAt: fixedTime,
        },
      })
      const log2 = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'out',
          amount: 50,
          balanceAfter: 50,
          reason: 'Same time 2',
          createdAt: fixedTime,
        },
      })
      const log3 = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'hold',
          amount: 20,
          balanceAfter: 30,
          reason: 'Same time 3',
          createdAt: fixedTime,
        },
      })

      const res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ userId: user.user.id })
        .expect(200)

      expect(res.body.total).toBe(3)
      // Because createdAt is identical, tie-breaker id DESC puts log3 > log2 > log1
      expect(res.body.items[0].id).toBe(log3.id)
      expect(res.body.items[1].id).toBe(log2.id)
      expect(res.body.items[2].id).toBe(log1.id)
    })
  })

  describe('Filters', () => {
    it('filters by userId', async () => {
      const admin = await loginAdmin('pl-filter-admin@test.local')
      const userA = await loginUser('pl-filter-user-a@test.local')
      const userB = await loginUser('pl-filter-user-b@test.local')

      const logA = await prisma.pointLog.create({
        data: {
          userId: userA.user.id,
          type: 'in',
          amount: 111,
          balanceAfter: 5111,
          reason: 'User A Log',
        },
      })
      const logB = await prisma.pointLog.create({
        data: {
          userId: userB.user.id,
          type: 'in',
          amount: 222,
          balanceAfter: 5222,
          reason: 'User B Log',
        },
      })

      const res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ userId: userA.user.id })
        .expect(200)

      const ids = res.body.items.map((i: any) => i.id)
      expect(ids).toContain(logA.id)
      expect(ids).not.toContain(logB.id)
    })

    it('filters by email with normalized case-insensitive exact matching', async () => {
      const admin = await loginAdmin('pl-email-admin@test.local')
      const user = await loginUser('pl-case-user@test.local')

      const log = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'refund',
          amount: 300,
          balanceAfter: 5300,
          reason: '退款测试',
        },
      })

      // Query with uppercase and leading/trailing whitespace
      const res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ email: '  PL-CASE-USER@TEST.LOCAL  ' })
        .expect(200)

      expect(res.body.total).toBeGreaterThanOrEqual(1)
      const found = res.body.items.find((i: any) => i.id === log.id)
      expect(found).toBeDefined()
      expect(found.userId).toBe(user.user.id)
    })

    it('filters by type (in, out, hold, release, refund, sandbox_in)', async () => {
      const admin = await loginAdmin('pl-type-admin@test.local')
      const user = await loginUser('pl-type-user@test.local')

      await prisma.pointLog.deleteMany({ where: { userId: user.user.id } })

      const inLog = await prisma.pointLog.create({
        data: { userId: user.user.id, type: 'in', amount: 10, balanceAfter: 10, reason: '入账' },
      })
      const outLog = await prisma.pointLog.create({
        data: { userId: user.user.id, type: 'out', amount: 5, balanceAfter: 5, reason: '支出' },
      })
      const holdLog = await prisma.pointLog.create({
        data: { userId: user.user.id, type: 'hold', amount: 2, balanceAfter: 3, reason: '锁定' },
      })
      const releaseLog = await prisma.pointLog.create({
        data: { userId: user.user.id, type: 'release', amount: 2, balanceAfter: 5, reason: '释放' },
      })
      const refundLog = await prisma.pointLog.create({
        data: { userId: user.user.id, type: 'refund', amount: 5, balanceAfter: 10, reason: '退款' },
      })
      const sandboxLog = await prisma.pointLog.create({
        data: { userId: user.user.id, type: 'sandbox_in', amount: 99, balanceAfter: 109, reason: '沙箱' },
      })

      const typesToTest = [
        { type: 'in', expectedId: inLog.id },
        { type: 'out', expectedId: outLog.id },
        { type: 'hold', expectedId: holdLog.id },
        { type: 'release', expectedId: releaseLog.id },
        { type: 'refund', expectedId: refundLog.id },
        { type: 'sandbox_in', expectedId: sandboxLog.id },
      ]

      for (const { type, expectedId } of typesToTest) {
        const res = await api
          .get('/api/admin/point-logs')
          .set(authHeader(admin.accessToken))
          .query({ userId: user.user.id, type })
          .expect(200)

        expect(res.body.total).toBe(1)
        expect(res.body.items).toHaveLength(1)
        expect(res.body.items[0].id).toBe(expectedId)
        expect(res.body.items[0].type).toBe(type)
      }
    })

    it('filters by date range (from and to) with strict half-open semantics', async () => {
      const admin = await loginAdmin('pl-date-admin@test.local')
      const user = await loginUser('pl-date-user@test.local')

      await prisma.pointLog.deleteMany({ where: { userId: user.user.id } })

      // Create logs on 2026-09-01, 2026-09-02, 2026-09-03
      const logSep1 = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'in',
          amount: 100,
          balanceAfter: 100,
          createdAt: new Date('2026-09-01T10:00:00.000Z'),
        },
      })
      const logSep2 = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'in',
          amount: 200,
          balanceAfter: 300,
          createdAt: new Date('2026-09-02T23:59:59.000Z'),
        },
      })
      const logSep3 = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'in',
          amount: 300,
          balanceAfter: 600,
          createdAt: new Date('2026-09-03T00:00:01.000Z'),
        },
      })

      // Query from 2026-09-02 to 2026-09-02 (date-only: should include logSep2, exclude logSep1 and logSep3)
      const resDateOnly = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({
          userId: user.user.id,
          from: '2026-09-02',
          to: '2026-09-02',
        })
        .expect(200)

      expect(resDateOnly.body.total).toBe(1)
      expect(resDateOnly.body.items[0].id).toBe(logSep2.id)

      // Query RFC 3339 timestamp range
      const resRfc = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({
          userId: user.user.id,
          from: '2026-09-01T00:00:00Z',
          to: '2026-09-02T23:59:59Z',
        })
        .expect(200)

      expect(resRfc.body.total).toBe(2)
      const rfcIds = resRfc.body.items.map((i: any) => i.id)
      expect(rfcIds).toContain(logSep1.id)
      expect(rfcIds).toContain(logSep2.id)
      expect(rfcIds).not.toContain(logSep3.id)
    })

    it('combines multiple filters with AND semantics', async () => {
      const admin = await loginAdmin('pl-multi-admin@test.local')
      const user = await loginUser('pl-multi-user@test.local')

      await prisma.pointLog.deleteMany({ where: { userId: user.user.id } })

      const match = await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'hold',
          amount: 100,
          balanceAfter: 400,
          createdAt: new Date('2026-09-02T15:00:00.000Z'),
          reason: 'Exact Match',
        },
      })
      await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'in', // different type
          amount: 100,
          balanceAfter: 500,
          createdAt: new Date('2026-09-02T15:00:00.000Z'),
          reason: 'Diff Type',
        },
      })
      await prisma.pointLog.create({
        data: {
          userId: user.user.id,
          type: 'hold',
          amount: 100,
          balanceAfter: 400,
          createdAt: new Date('2026-09-05T15:00:00.000Z'), // diff date
          reason: 'Diff Date',
        },
      })

      const res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({
          userId: user.user.id,
          email: user.user.email,
          type: 'hold',
          from: '2026-09-02',
          to: '2026-09-02',
        })
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].id).toBe(match.id)
    })
  })

  describe('Validation & Error Handling', () => {
    it('rejects pageSize > 100 with 400', async () => {
      const admin = await loginAdmin('pl-err-admin@test.local')
      await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ pageSize: 101 })
        .expect(400)
    })

    it('rejects invalid type with 400', async () => {
      const admin = await loginAdmin('pl-err2-admin@test.local')
      await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ type: 'invalid_type' })
        .expect(400)
    })

    it('rejects invalid date format with 400', async () => {
      const admin = await loginAdmin('pl-err3-admin@test.local')
      await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-13-45' })
        .expect(400)
    })

    it('rejects invalid calendar date (e.g. 2026-02-30) with 400', async () => {
      const admin = await loginAdmin('pl-err4-admin@test.local')
      await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-02-30' })
        .expect(400)
    })

    it('rejects reverse date range from > to with 400', async () => {
      const admin = await loginAdmin('pl-err5-admin@test.local')
      const res = await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-09-05', to: '2026-09-04' })
        .expect(400)

      expect(JSON.stringify(res.body)).toContain('from 不能晚于 to')
    })

    it('rejects unexpected query parameters with 400 (.strict())', async () => {
      const admin = await loginAdmin('pl-err6-admin@test.local')
      await api
        .get('/api/admin/point-logs')
        .set(authHeader(admin.accessToken))
        .query({ maliciousParam: 'inject' })
        .expect(400)
    })
  })

  describe('Legacy Endpoint Compatibility (GET /api/admin/logs)', () => {
    it('returns raw array with max 100 items for backward compatibility', async () => {
      const admin = await loginAdmin('pl-legacy-admin@test.local')
      const res = await api
        .get('/api/admin/logs')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body.length).toBeLessThanOrEqual(100)
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty('id')
        expect(res.body[0]).toHaveProperty('userId')
        expect(res.body[0]).toHaveProperty('amount')
        expect(res.body[0]).toHaveProperty('balanceAfter')
      }
    })
  })
})
