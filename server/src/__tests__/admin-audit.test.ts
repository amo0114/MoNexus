import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { config } from '../config/index.js'

async function createAuditFixture() {
  const { user: adminOne } = await createTestUser('audit-admin-1@test.local', 'admin123', 'admin')
  const { user: adminTwo } = await createTestUser('audit-admin-2@test.local', 'admin123', 'admin')
  await createTestUser('audit-normal@test.local', 'pass123', 'user')

  const actions = ['ban', 'unban', 'ban-user', 'config-update']
  const targetTypes = ['user', 'systemConfig', 'order', 'product']

  // 28 records across a range of dates
  const logs = []
  for (let i = 0; i < 28; i += 1) {
    const day = String((i % 20) + 1).padStart(2, '0')
    logs.push(
      await prisma.adminLog.create({
        data: {
          adminUserId: i % 2 === 0 ? adminOne.id : adminTwo.id,
          action: actions[i % actions.length],
          targetType: targetTypes[i % targetTypes.length],
          targetId: 1000 + i,
          detail: `detail-${i + 1}`,
          createdAt: new Date(`2026-05-${day}T12:00:00.000Z`),
        },
      })
    )
  }

  const adminLogin = await loginAs('audit-admin-1@test.local', 'admin123')
  return { adminOne, adminTwo, logs, accessToken: adminLogin.accessToken }
}

function sortedIds(logs: Array<{ id: number; createdAt: Date }>) {
  return [...logs]
    .sort((left, right) => {
      const createdAtDiff = right.createdAt.getTime() - left.createdAt.getTime()
      return createdAtDiff || right.id - left.id
    })
    .map((log) => log.id)
}

describe('GET /api/admin/audit', () => {
  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      await api.get('/api/admin/audit').expect(401)
    })

    it('returns 403 when authenticated as normal user', async () => {
      await createTestUser('audit-user-auth@test.local', 'pass123', 'user')
      const { accessToken } = await loginAs('audit-user-auth@test.local', 'pass123')

      await api.get('/api/admin/audit').set(authHeader(accessToken)).expect(403)
    })

    it('returns 403 with MFA_REQUIRED when admin has not completed MFA', async () => {
      const { user } = await createTestUser('audit-admin-nomfa@test.local', 'admin123', 'admin')
      await loginAs(user.email, 'admin123')
      const session = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: user.id, revoked: false },
        orderBy: { id: 'desc' },
      })

      const adminWithoutMfa = jwt.sign(
        { userId: user.id, role: 'admin', sid: session.sessionId },
        config.jwtSecret!,
        { expiresIn: '15m' }
      )

      const res = await api
        .get('/api/admin/audit')
        .set(authHeader(adminWithoutMfa))
        .expect(403)

      expect(res.body.error.code).toBe('MFA_REQUIRED')
    })

    it('returns 200 when authenticated as admin with MFA completed', async () => {
      const { accessToken } = await createAuditFixture()
      await api.get('/api/admin/audit').set(authHeader(accessToken)).expect(200)
    })
  })

  describe('Pagination and Deterministic Sorting', () => {
    it('uses default page=1 and pageSize=20 sorted by createdAt DESC, id DESC', async () => {
      const { logs, accessToken } = await createAuditFixture()

      const res = await api.get('/api/admin/audit').set(authHeader(accessToken)).expect(200)

      expect(res.body).toMatchObject({
        total: logs.length,
        page: 1,
        pageSize: 20,
      })
      expect(res.body.items).toHaveLength(20)
      const expectedIds = sortedIds(logs).slice(0, 20)
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual(expectedIds)
      expect(typeof res.body.items[0].createdAt).toBe('string')
    })

    it('returns the second page without changing total', async () => {
      const { logs, accessToken } = await createAuditFixture()

      const res = await api
        .get('/api/admin/audit')
        .query({ page: 2, pageSize: 10 })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.total).toBe(logs.length)
      expect(res.body.page).toBe(2)
      expect(res.body.pageSize).toBe(10)
      expect(res.body.items).toHaveLength(10)
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual(
        sortedIds(logs).slice(10, 20)
      )
    })

    it('retrieves 25+ records across pages without duplication or omissions', async () => {
      const { logs, accessToken } = await createAuditFixture()
      expect(logs.length).toBeGreaterThanOrEqual(25)

      const p1 = await api
        .get('/api/admin/audit')
        .query({ page: 1, pageSize: 10 })
        .set(authHeader(accessToken))
        .expect(200)
      const p2 = await api
        .get('/api/admin/audit')
        .query({ page: 2, pageSize: 10 })
        .set(authHeader(accessToken))
        .expect(200)
      const p3 = await api
        .get('/api/admin/audit')
        .query({ page: 3, pageSize: 10 })
        .set(authHeader(accessToken))
        .expect(200)

      const ids1: number[] = p1.body.items.map((i: { id: number }) => i.id)
      const ids2: number[] = p2.body.items.map((i: { id: number }) => i.id)
      const ids3: number[] = p3.body.items.map((i: { id: number }) => i.id)

      expect(ids1).toHaveLength(10)
      expect(ids2).toHaveLength(10)
      expect(ids3).toHaveLength(logs.length - 20)

      const combined = [...ids1, ...ids2, ...ids3]
      const uniqueCombined = new Set(combined)
      expect(uniqueCombined.size).toBe(logs.length)
      expect(combined).toEqual(sortedIds(logs))
    })

    it('breaks ties deterministically with id DESC when createdAt timestamps are identical', async () => {
      const { adminOne, accessToken } = await createAuditFixture()
      const tieDate = new Date('2026-07-07T10:00:00.000Z')

      const logA = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'tie-break-action',
          targetType: 'user',
          createdAt: tieDate,
        },
      })
      const logB = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'tie-break-action',
          targetType: 'user',
          createdAt: tieDate,
        },
      })
      expect(logB.id).toBeGreaterThan(logA.id)

      const res = await api
        .get('/api/admin/audit')
        .query({ action: 'tie-break-action' })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([logB.id, logA.id])
    })

    it('returns empty items on out-of-bounds page while preserving total and pagination metadata', async () => {
      const { logs, accessToken } = await createAuditFixture()

      const res = await api
        .get('/api/admin/audit')
        .query({ page: 999, pageSize: 20 })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body).toEqual({
        items: [],
        total: logs.length,
        page: 999,
        pageSize: 20,
      })
    })
  })

  describe('Filtering', () => {
    it('filters by adminId', async () => {
      const { adminTwo, logs, accessToken } = await createAuditFixture()
      const expected = logs.filter((log) => log.adminUserId === adminTwo.id)

      const res = await api
        .get('/api/admin/audit')
        .query({ adminId: adminTwo.id, pageSize: 100 })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.total).toBe(expected.length)
      expect(res.body.items.every((i: { adminId: number }) => i.adminId === adminTwo.id)).toBe(true)
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual(sortedIds(expected))
    })

    it('filters by exact action and does not match similar prefix actions', async () => {
      const { logs, accessToken } = await createAuditFixture()
      const expected = logs.filter((log) => log.action === 'ban')

      const res = await api
        .get('/api/admin/audit')
        .query({ action: 'ban', pageSize: 100 })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.total).toBe(expected.length)
      expect(res.body.items.every((i: { action: string }) => i.action === 'ban')).toBe(true)
      expect(res.body.items.some((i: { action: string }) => i.action === 'ban-user')).toBe(false)
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual(sortedIds(expected))
    })

    it('filters by targetType', async () => {
      const { logs, accessToken } = await createAuditFixture()
      const expected = logs.filter((log) => log.targetType === 'order')

      const res = await api
        .get('/api/admin/audit')
        .query({ targetType: 'order', pageSize: 100 })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.total).toBe(expected.length)
      expect(res.body.items.every((i: { targetType: string }) => i.targetType === 'order')).toBe(
        true
      )
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual(sortedIds(expected))
    })

    it('filters by date range', async () => {
      const { logs, accessToken } = await createAuditFixture()
      const expected = logs.filter(
        (log) =>
          log.createdAt >= new Date('2026-05-05T00:00:00.000Z') &&
          log.createdAt < new Date('2026-05-09T00:00:00.000Z')
      )

      const res = await api
        .get('/api/admin/audit')
        .query({ fromDate: '2026-05-05', toDate: '2026-05-08', pageSize: 100 })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.total).toBe(expected.length)
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual(sortedIds(expected))
    })

    it('combines adminId, action, targetType, and date filters with AND semantics', async () => {
      const { adminOne, logs, accessToken } = await createAuditFixture()
      const expected = logs.filter(
        (log) =>
          log.adminUserId === adminOne.id &&
          log.action === 'ban' &&
          log.targetType === 'user' &&
          log.createdAt >= new Date('2026-05-01T00:00:00.000Z') &&
          log.createdAt < new Date('2026-05-15T00:00:00.000Z')
      )

      const res = await api
        .get('/api/admin/audit')
        .query({
          adminId: adminOne.id,
          action: 'ban',
          targetType: 'user',
          fromDate: '2026-05-01',
          toDate: '2026-05-14',
          pageSize: 100,
        })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.total).toBe(expected.length)
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual(sortedIds(expected))
    })

    it('reads unregistered historical actions in unfiltered list and filters them accurately by raw API value', async () => {
      const { adminOne, accessToken } = await createAuditFixture()
      const legacyLog = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'legacy_custom_unregistered_action',
          targetType: 'custom_historical_entity',
          targetId: 777,
          createdAt: new Date('2026-08-01T12:00:00.000Z'),
        },
      })

      // 1. Unfiltered list includes legacy action
      const unfilteredRes = await api
        .get('/api/admin/audit')
        .query({ page: 1, pageSize: 20 })
        .set(authHeader(accessToken))
        .expect(200)

      expect(
        unfilteredRes.body.items.some(
          (i: { action: string }) => i.action === 'legacy_custom_unregistered_action'
        )
      ).toBe(true)

      // 2. Exact filter by raw string finds it
      const filteredRes = await api
        .get('/api/admin/audit')
        .query({ action: 'legacy_custom_unregistered_action' })
        .set(authHeader(accessToken))
        .expect(200)

      expect(filteredRes.body.total).toBe(1)
      expect(filteredRes.body.items[0].id).toBe(legacyLog.id)
      expect(filteredRes.body.items[0].targetType).toBe('custom_historical_entity')
    })
  })

  describe('Validation & Edge Cases', () => {
    it('rejects invalid page, pageSize, and adminId numbers', async () => {
      const { accessToken } = await createAuditFixture()

      // page 0
      await api
        .get('/api/admin/audit')
        .query({ page: 0 })
        .set(authHeader(accessToken))
        .expect(400)

      // pageSize 0
      await api
        .get('/api/admin/audit')
        .query({ pageSize: 0 })
        .set(authHeader(accessToken))
        .expect(400)

      // pageSize 101
      await api
        .get('/api/admin/audit')
        .query({ pageSize: 101 })
        .set(authHeader(accessToken))
        .expect(400)

      // adminId 0
      await api
        .get('/api/admin/audit')
        .query({ adminId: 0 })
        .set(authHeader(accessToken))
        .expect(400)

      // adminId negative
      await api
        .get('/api/admin/audit')
        .query({ adminId: -1 })
        .set(authHeader(accessToken))
        .expect(400)

      // adminId non-integer
      await api
        .get('/api/admin/audit')
        .query({ adminId: 'not-a-number' })
        .set(authHeader(accessToken))
        .expect(400)
    })

    it('rejects blank action and targetType', async () => {
      const { accessToken } = await createAuditFixture()

      await api
        .get('/api/admin/audit')
        .query({ action: '   ' })
        .set(authHeader(accessToken))
        .expect(400)

      await api
        .get('/api/admin/audit')
        .query({ targetType: '   ' })
        .set(authHeader(accessToken))
        .expect(400)
    })

    it('rejects action > 128 chars and targetType > 64 chars', async () => {
      const { accessToken } = await createAuditFixture()

      await api
        .get('/api/admin/audit')
        .query({ action: 'a'.repeat(129) })
        .set(authHeader(accessToken))
        .expect(400)

      await api
        .get('/api/admin/audit')
        .query({ targetType: 'a'.repeat(65) })
        .set(authHeader(accessToken))
        .expect(400)
    })

    it('rejects unknown query parameters with .strict() 400 VALIDATION_ERROR', async () => {
      const { accessToken } = await createAuditFixture()

      const res = await api
        .get('/api/admin/audit')
        .query({ unexpected_param: 'test' })
        .set(authHeader(accessToken))
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('rejects invalid calendar dates, RFC 3339 without timezone, and out-of-bounds time', async () => {
      const { accessToken } = await createAuditFixture()

      // Invalid calendar date
      await api
        .get('/api/admin/audit')
        .query({ fromDate: '2026-02-31' })
        .set(authHeader(accessToken))
        .expect(400)

      // RFC 3339 missing timezone
      await api
        .get('/api/admin/audit')
        .query({ fromDate: '2026-09-04T12:30:00' })
        .set(authHeader(accessToken))
        .expect(400)

      // Timezone present but calendar date invalid
      await api
        .get('/api/admin/audit')
        .query({ toDate: '2026-04-31T12:00:00+08:00' })
        .set(authHeader(accessToken))
        .expect(400)

      // Invalid hour value
      await api
        .get('/api/admin/audit')
        .query({ fromDate: '2026-09-04T25:00:00Z' })
        .set(authHeader(accessToken))
        .expect(400)
    })

    it('rejects fromDate > toDate with fixed error message', async () => {
      const { accessToken } = await createAuditFixture()

      const res = await api
        .get('/api/admin/audit')
        .query({ fromDate: '2026-05-10', toDate: '2026-05-09' })
        .set(authHeader(accessToken))
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      const details = JSON.stringify(res.body.error.details)
      expect(details).toContain('fromDate 不能晚于 toDate')
    })
  })

  describe('Date Boundaries', () => {
    it('accurately includes start day midnight, end day 23:59:59.999Z, and excludes next day midnight for date-only queries', async () => {
      const { adminOne, accessToken } = await createAuditFixture()

      // Exact boundaries
      const startLog = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'boundary-date-only',
          createdAt: new Date('2026-06-10T00:00:00.000Z'),
        },
      })
      const endLog = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'boundary-date-only',
          createdAt: new Date('2026-06-12T23:59:59.999Z'),
        },
      })
      const nextDayLog = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'boundary-date-only',
          createdAt: new Date('2026-06-13T00:00:00.000Z'),
        },
      })

      const res = await api
        .get('/api/admin/audit')
        .query({ action: 'boundary-date-only', fromDate: '2026-06-10', toDate: '2026-06-12' })
        .set(authHeader(accessToken))
        .expect(200)

      const returnedIds = res.body.items.map((i: { id: number }) => i.id)
      expect(returnedIds).toContain(startLog.id)
      expect(returnedIds).toContain(endLog.id)
      expect(returnedIds).not.toContain(nextDayLog.id)
    })

    it('enforces exact millisecond timestamp boundaries for RFC 3339 queries', async () => {
      const { adminOne, accessToken } = await createAuditFixture()

      const logA = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'boundary-rfc3339',
          createdAt: new Date('2026-06-20T10:00:00.000Z'),
        },
      })
      const logB = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'boundary-rfc3339',
          createdAt: new Date('2026-06-20T11:00:00.000Z'),
        },
      })
      const logC = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'boundary-rfc3339',
          createdAt: new Date('2026-06-20T11:00:00.001Z'),
        },
      })

      const res = await api
        .get('/api/admin/audit')
        .query({
          action: 'boundary-rfc3339',
          fromDate: '2026-06-20T10:00:00.000Z',
          toDate: '2026-06-20T11:00:00.000Z',
        })
        .set(authHeader(accessToken))
        .expect(200)

      const returnedIds = res.body.items.map((i: { id: number }) => i.id)
      expect(returnedIds).toContain(logA.id)
      expect(returnedIds).toContain(logB.id)
      expect(returnedIds).not.toContain(logC.id)
    })
  })

  describe('Projection Safety & Sensitive Data Containment', () => {
    it('populates adminEmail and supports null targetType and null targetId', async () => {
      const { adminOne, accessToken } = await createAuditFixture()

      const log = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'null-target-action',
          targetType: null,
          targetId: null,
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
        },
      })

      const res = await api
        .get('/api/admin/audit')
        .query({ action: 'null-target-action' })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.items).toHaveLength(1)
      const item = res.body.items[0]
      expect(item.id).toBe(log.id)
      expect(item.adminId).toBe(adminOne.id)
      expect(item.adminEmail).toBe(adminOne.email)
      expect(item.targetType).toBeNull()
      expect(item.targetId).toBeNull()
      expect(item.adminUserId).toBeUndefined()
    })

    it('strictly omits detail, metadata, and adminUserId even when sensitive text is stored in database', async () => {
      const { adminOne, accessToken } = await createAuditFixture()
      const sensitiveDetail =
        'SECRET_TOKEN=xyz123; user_password_hash=$2a$10$verysecretpassword; email=leak@example.com; ' +
        'x'.repeat(1000)

      const log = await prisma.adminLog.create({
        data: {
          adminUserId: adminOne.id,
          action: 'sensitive-check',
          targetType: 'user',
          targetId: 9999,
          detail: sensitiveDetail,
          createdAt: new Date('2026-08-15T12:00:00.000Z'),
        },
      })

      const res = await api
        .get('/api/admin/audit')
        .query({ action: 'sensitive-check' })
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.items).toHaveLength(1)
      const item = res.body.items[0]

      // Field level checks
      expect(item.id).toBe(log.id)
      expect(item.detail).toBeUndefined()
      expect(item.metadata).toBeUndefined()
      expect(item.adminUserId).toBeUndefined()

      // Network payload body inspection
      const rawBody = res.text
      expect(rawBody).not.toContain('SECRET_TOKEN')
      expect(rawBody).not.toContain('verysecretpassword')
      expect(rawBody).not.toContain('leak@example.com')
      expect(rawBody).not.toContain('detail')
      expect(rawBody).not.toContain('metadata')
      expect(rawBody).not.toContain('adminUserId')
    })
  })
})
