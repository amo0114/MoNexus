import { describe, it, expect, beforeEach } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'

async function loginAdmin(email = 'ann-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

function createAnnouncement(accessToken: string, payload: object) {
  return api
    .post('/api/admin/announcements')
    .set(authHeader(accessToken))
    .send(payload)
}

function pastDate(daysAgo: number) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
}

function futureDate(daysAhead: number) {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000)
}

describe('Announcements admin CRUD (M3-S3)', () => {
  beforeEach(async () => {
    await prisma.announcement.deleteMany({})
  })

  it('allows admin to create an announcement (201)', async () => {
    const { accessToken } = await loginAdmin()

    const res = await createAnnouncement(accessToken, {
      title: '系统升级公告',
      content: '将于今晚 22:00 升级',
      audience: 'all',
      priority: 10,
      startsAt: pastDate(1).toISOString(),
      endsAt: null,
      status: 'published',
    }).expect(201)

    expect(res.body.id).toBeDefined()
    expect(res.body.title).toBe('系统升级公告')
    expect(res.body.audience).toBe('all')
    expect(res.body.status).toBe('published')
    expect(res.body.endsAt).toBeNull()

    const log = await prisma.adminLog.findFirst({
      where: { action: '创建公告', targetType: 'announcement' },
    })
    expect(log).toBeTruthy()
    expect(log!.targetId).toBe(res.body.id)
  })

  it('rejects non-admin POST with 403', async () => {
    const { user, password } = await createTestUser('plain-user@test.local', 'pass123', 'user')
    const { accessToken } = await loginAs(user.email, password)

    await createAnnouncement(accessToken, {
      title: 'x',
      content: 'y',
      startsAt: futureDate(0).toISOString(),
    }).expect(403)
  })

  it('admin can update and delete announcements', async () => {
    const { accessToken } = await loginAdmin()

    const created = await createAnnouncement(accessToken, {
      title: '初始标题',
      content: '初始内容',
      audience: 'all',
      priority: 0,
      startsAt: pastDate(1).toISOString(),
      status: 'draft',
    }).expect(201)

    const updated = await api
      .put(`/api/admin/announcements/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ status: 'published', priority: 20 })
      .expect(200)

    expect(updated.body.status).toBe('published')
    expect(updated.body.priority).toBe(20)

    await api
      .delete(`/api/admin/announcements/${created.body.id}`)
      .set(authHeader(accessToken))
      .expect(200)

    const gone = await prisma.announcement.findUnique({ where: { id: created.body.id } })
    expect(gone).toBeNull()
  })

  it('rejects partial updates that would invert the time window', async () => {
    const { accessToken } = await loginAdmin()
    const startsAt = pastDate(1)
    const endsAt = futureDate(1)
    const created = await createAnnouncement(accessToken, {
      title: '时间窗口公告',
      content: '公告内容',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201)

    await api
      .put(`/api/admin/announcements/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ endsAt: pastDate(2).toISOString() })
      .expect(400)

    await api
      .put(`/api/admin/announcements/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ startsAt: futureDate(2).toISOString() })
      .expect(400)

    const unchanged = await prisma.announcement.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(unchanged.startsAt).toEqual(startsAt)
    expect(unchanged.endsAt).toEqual(endsAt)
  })

  it('admin can filter list by status and audience', async () => {
    const { accessToken } = await loginAdmin()

    await createAnnouncement(accessToken, {
      title: 'A', content: 'a', audience: 'all', priority: 1,
      startsAt: pastDate(1).toISOString(), status: 'published',
    }).expect(201)
    await createAnnouncement(accessToken, {
      title: 'B', content: 'b', audience: 'merchant', priority: 2,
      startsAt: pastDate(1).toISOString(), status: 'draft',
    }).expect(201)

    const published = await api
      .get('/api/admin/announcements')
      .query({ status: 'published' })
      .set(authHeader(accessToken))
      .expect(200)
    expect(published.body.total).toBe(1)
    expect(published.body.items[0].title).toBe('A')

    const merchants = await api
      .get('/api/admin/announcements')
      .query({ audience: 'merchant' })
      .set(authHeader(accessToken))
      .expect(200)
    expect(merchants.body.total).toBe(1)
    expect(merchants.body.items[0].title).toBe('B')
  })
})

describe('GET /api/announcements public query (M3-S3)', () => {
  beforeEach(async () => {
    await prisma.announcement.deleteMany({})
  })

  it('returns only in-range published announcements sorted by priority desc', async () => {
    await prisma.announcement.create({
      data: {
        title: '生效-高优先级',
        content: 'a',
        audience: 'all',
        priority: 100,
        startsAt: pastDate(1),
        endsAt: futureDate(1),
        status: 'published',
      },
    })
    await prisma.announcement.create({
      data: {
        title: '生效-低优先级',
        content: 'b',
        audience: 'all',
        priority: 1,
        startsAt: pastDate(1),
        endsAt: null,
        status: 'published',
      },
    })
    await prisma.announcement.create({
      data: {
        title: '未到开始时间',
        content: 'c',
        audience: 'all',
        priority: 999,
        startsAt: futureDate(1),
        endsAt: futureDate(2),
        status: 'published',
      },
    })
    await prisma.announcement.create({
      data: {
        title: '已过期',
        content: 'd',
        audience: 'all',
        priority: 999,
        startsAt: pastDate(5),
        endsAt: pastDate(1),
        status: 'published',
      },
    })
    await prisma.announcement.create({
      data: {
        title: '草稿不显示',
        content: 'e',
        audience: 'all',
        priority: 999,
        startsAt: pastDate(1),
        endsAt: null,
        status: 'draft',
      },
    })

    const res = await api.get('/api/announcements').expect(200)
    expect(res.body).toHaveLength(2)
    expect(res.body[0].title).toBe('生效-高优先级')
    expect(res.body[1].title).toBe('生效-低优先级')
  })

  it('returns empty array when no announcements exist', async () => {
    const res = await api.get('/api/announcements').expect(200)
    expect(res.body).toEqual([])
  })

  it('unauthenticated request returns only audience=all', async () => {
    await prisma.announcement.create({
      data: {
        title: '全员公告', content: 'x', audience: 'all', priority: 1,
        startsAt: pastDate(1), endsAt: null, status: 'published',
      },
    })
    await prisma.announcement.create({
      data: {
        title: '商家专属', content: 'y', audience: 'merchant', priority: 1,
        startsAt: pastDate(1), endsAt: null, status: 'published',
      },
    })

    const res = await api.get('/api/announcements').expect(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].title).toBe('全员公告')
  })

  it('derives targeted announcements from the authenticated role and rejects caller-selected audiences', async () => {
    await prisma.announcement.create({
      data: {
        title: '全员', content: 'x', audience: 'all', priority: 1,
        startsAt: pastDate(1), endsAt: null, status: 'published',
      },
    })
    await prisma.announcement.create({
      data: {
        title: '商家', content: 'y', audience: 'merchant', priority: 2,
        startsAt: pastDate(1), endsAt: null, status: 'published',
      },
    })
    await prisma.announcement.create({
      data: {
        title: '用户', content: 'z', audience: 'user', priority: 3,
        startsAt: pastDate(1), endsAt: null, status: 'published',
      },
    })

    await prisma.announcement.create({
      data: {
        title: '管理员', content: 'a', audience: 'admin', priority: 4,
        startsAt: pastDate(1), endsAt: null, status: 'published',
      },
    })
    const { user: normalUser, password: normalPassword } = await createTestUser('ann-user@test.local', 'pass123', 'user')
    const { user: merchantUser, password: merchantPassword } = await createTestUser('ann-merchant@test.local', 'pass123', 'merchant')
    const { user: adminUser, password: adminPassword } = await createTestUser('ann-role-admin@test.local', 'admin123', 'admin')
    const normalLogin = await loginAs(normalUser.email, normalPassword)
    const merchantLogin = await loginAs(merchantUser.email, merchantPassword)
    const adminLogin = await loginAs(adminUser.email, adminPassword)

    const normal = await api
      .get('/api/announcements')
      .set(authHeader(normalLogin.accessToken))
      .expect(200)
    expect(normal.body.map((a: { title: string }) => a.title).sort()).toEqual(['全员', '用户'])

    const merchant = await api
      .get('/api/announcements')
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    expect(merchant.body.map((a: { title: string }) => a.title).sort()).toEqual(['全员', '商家'])

    const admin = await api
      .get('/api/announcements')
      .set(authHeader(adminLogin.accessToken))
      .expect(200)
    expect(admin.body.map((a: { title: string }) => a.title).sort()).toEqual(['全员', '管理员'])

    await api
      .get('/api/announcements')
      .query({ audience: 'admin' })
      .set(authHeader(normalLogin.accessToken))
      .expect(400)
  })

  it('rejects invalid audience with 400', async () => {
    await api
      .get('/api/announcements')
      .query({ audience: 'nonsense' })
      .expect(400)
  })
})
