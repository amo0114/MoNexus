import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'

async function createAuditFixture() {
  const { user: adminOne } = await createTestUser('audit-admin-1@test.local', 'admin123', 'admin')
  const { user: adminTwo } = await createTestUser('audit-admin-2@test.local', 'admin123', 'admin')
  await createTestUser('audit-normal@test.local', 'pass123', 'user')

  const actions = ['ban', 'unban', 'ban-user', 'config-update']
  const createdAtDates = [
    '2026-05-01T12:00:00.000Z',
    '2026-05-02T12:00:00.000Z',
    '2026-05-03T12:00:00.000Z',
    '2026-05-04T12:00:00.000Z',
    '2026-05-05T12:00:00.000Z',
    '2026-05-06T12:00:00.000Z',
    '2026-05-07T12:00:00.000Z',
    '2026-05-08T12:00:00.000Z',
    '2026-05-09T12:00:00.000Z',
    '2026-05-10T12:00:00.000Z',
    '2026-05-12T12:00:00.000Z',
    '2026-05-12T12:00:00.000Z',
  ]

  const logs = []
  for (let index = 0; index < createdAtDates.length; index += 1) {
    logs.push(await prisma.adminLog.create({
      data: {
        adminUserId: index % 2 === 0 ? adminOne.id : adminTwo.id,
        action: actions[index % actions.length],
        targetType: 'user',
        targetId: 1000 + index,
        detail: index === 2 ? null : `detail-${index + 1}`,
        createdAt: new Date(createdAtDates[index]),
      },
    }))
  }

  const adminLogin = await loginAs('audit-admin-1@test.local', 'admin123')
  return { adminOne, adminTwo, logs, accessToken: adminLogin.accessToken }
}

function sortedIds(logs: Array<{ id: number, createdAt: Date }>) {
  return [...logs]
    .sort((left, right) => {
      const createdAtDiff = right.createdAt.getTime() - left.createdAt.getTime()
      return createdAtDiff || right.id - left.id
    })
    .map(log => log.id)
}

describe('GET /api/admin/audit', () => {
  it('should list audit logs with default pagination sorted descending', async () => {
    const { logs, accessToken } = await createAuditFixture()

    const res = await api
      .get('/api/admin/audit')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({
      total: logs.length,
      page: 1,
      pageSize: 20,
    })
    expect(res.body.items.map((item: { id: number }) => item.id)).toEqual(sortedIds(logs))
    expect(res.body.items[0]).toMatchObject({
      id: logs[11].id,
      adminId: logs[11].adminUserId,
      action: logs[11].action,
      targetType: logs[11].targetType,
      targetId: logs[11].targetId,
      metadata: { detail: logs[11].detail },
    })
    expect(res.body.items[0].adminUserId).toBeUndefined()
    expect(res.body.items[0].detail).toBeUndefined()
    expect(typeof res.body.items[0].createdAt).toBe('string')
  })

  it('should return the second page without changing total', async () => {
    const { logs, accessToken } = await createAuditFixture()

    const res = await api
      .get('/api/admin/audit')
      .query({ page: 2, pageSize: 5 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.total).toBe(logs.length)
    expect(res.body.page).toBe(2)
    expect(res.body.pageSize).toBe(5)
    expect(res.body.items).toHaveLength(5)
    expect(res.body.items.map((item: { id: number }) => item.id)).toEqual(sortedIds(logs).slice(5, 10))
  })

  it('should filter by adminId', async () => {
    const { adminTwo, logs, accessToken } = await createAuditFixture()
    const expected = logs.filter(log => log.adminUserId === adminTwo.id)

    const res = await api
      .get('/api/admin/audit')
      .query({ adminId: adminTwo.id })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.total).toBe(expected.length)
    expect(res.body.items.map((item: { adminId: number }) => item.adminId)).toEqual(
      expected.map(() => adminTwo.id)
    )
    expect(res.body.items.map((item: { id: number }) => item.id)).toEqual(sortedIds(expected))
  })

  it('should filter by exact action', async () => {
    const { logs, accessToken } = await createAuditFixture()
    const expected = logs.filter(log => log.action === 'ban')

    const res = await api
      .get('/api/admin/audit')
      .query({ action: 'ban' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.total).toBe(expected.length)
    expect(res.body.items.every((item: { action: string }) => item.action === 'ban')).toBe(true)
    expect(res.body.items.some((item: { action: string }) => item.action === 'ban-user')).toBe(false)
    expect(res.body.items.map((item: { id: number }) => item.id)).toEqual(sortedIds(expected))
  })

  it('should filter by fromDate and toDate', async () => {
    const { logs, accessToken } = await createAuditFixture()
    const expected = logs.filter(log =>
      log.createdAt >= new Date('2026-05-05T00:00:00.000Z') &&
      log.createdAt <= new Date('2026-05-08T23:59:59.999Z')
    )

    const res = await api
      .get('/api/admin/audit')
      .query({ fromDate: '2026-05-05', toDate: '2026-05-08' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.total).toBe(expected.length)
    expect(res.body.items.map((item: { id: number }) => item.id)).toEqual(sortedIds(expected))
  })

  it('should populate adminEmail from the admin user relation', async () => {
    const { adminTwo, accessToken } = await createAuditFixture()

    const res = await api
      .get('/api/admin/audit')
      .query({ adminId: adminTwo.id })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.items.length).toBeGreaterThan(0)
    expect(res.body.items.every((item: { adminEmail: string }) => item.adminEmail === adminTwo.email)).toBe(true)
  })

  it('should reject non-admin users', async () => {
    await createTestUser('audit-non-admin@test.local', 'pass123', 'user')
    const { accessToken } = await loginAs('audit-non-admin@test.local', 'pass123')

    await api
      .get('/api/admin/audit')
      .set(authHeader(accessToken))
      .expect(403)
  })

  it('should reject unauthenticated requests', async () => {
    await api.get('/api/admin/audit').expect(401)
  })

  it('should reject invalid and unknown query params', async () => {
    await createTestUser('audit-validation-admin@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs('audit-validation-admin@test.local', 'admin123')

    const invalidPage = await api
      .get('/api/admin/audit')
      .query({ page: 0, pageSize: 101 })
      .set(authHeader(accessToken))
      .expect(400)

    expect(invalidPage.body.error.code).toBe('VALIDATION_ERROR')
    expect(invalidPage.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(
      expect.arrayContaining(['query.page', 'query.pageSize'])
    )

    const unknownQuery = await api
      .get('/api/admin/audit')
      .query({ unexpected: 'value' })
      .set(authHeader(accessToken))
      .expect(400)

    expect(unknownQuery.body.error.code).toBe('VALIDATION_ERROR')
  })
})
