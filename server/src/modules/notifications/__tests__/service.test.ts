import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from '../../../__tests__/helpers.js'
import { prisma } from '../../../lib/prisma.js'
import { config } from '../../../config/index.js'
import { NotificationDispatcher } from '../dispatcher.js'

async function seedNotification(
  recipientUserId: number,
  opts: { eventType?: string; status?: string; orderId?: number; title?: string } = {},
) {
  const orderId = opts.orderId ?? Math.floor(Math.random() * 1_000_000) + 1
  const eventType = opts.eventType ?? 'order.delivered_buyer'
  return prisma.notification.create({
    data: {
      recipientUserId,
      recipientRole: 'user',
      eventType,
      category: 'order',
      title: opts.title ?? '测试通知',
      body: '测试正文',
      payload: { orderId },
      deeplink: `/orders?focus=${orderId}`,
      level: 'info',
      status: opts.status ?? 'unread',
      dedupeKey: `order:${orderId}:${eventType}:seed-${Math.random().toString(36).slice(2)}`,
      relatedOrderId: orderId,
    },
  })
}

describe('Notification service API', () => {
  const prev = config.notification.enabled

  beforeEach(() => {
    config.notification.enabled = true
  })

  afterEach(() => {
    config.notification.enabled = prev
  })

  it('lists only the caller notifications', async () => {
    const a = await createTestUser('n-list-a@test.local')
    const b = await createTestUser('n-list-b@test.local')
    await seedNotification(a.user.id, { title: 'A 的通知' })
    await seedNotification(b.user.id, { title: 'B 的通知' })
    const { accessToken } = await loginAs('n-list-a@test.local', a.password)

    const res = await api.get('/api/notifications').set(authHeader(accessToken)).expect(200)
    expect(res.body.notifications).toHaveLength(1)
    expect(res.body.notifications[0].title).toBe('A 的通知')
    expect(res.body.hasMore).toBe(false)
  })

  it('returns 404 for cross-user mark as read (A-07)', async () => {
    const a = await createTestUser('n-x-a@test.local')
    const b = await createTestUser('n-x-b@test.local')
    const note = await seedNotification(b.user.id)
    const { accessToken } = await loginAs('n-x-a@test.local', a.password)

    await api
      .post(`/api/notifications/${note.id}/read`)
      .set(authHeader(accessToken))
      .expect(404)
  })

  it('returns unread count and decrements after mark read (A-09)', async () => {
    const { user, password } = await createTestUser('n-unread@test.local')
    const n1 = await seedNotification(user.id)
    await seedNotification(user.id)
    const { accessToken } = await loginAs('n-unread@test.local', password)

    const before = await api
      .get('/api/notifications/unread-count')
      .set(authHeader(accessToken))
      .expect(200)
    expect(before.body.count).toBe(2)

    await api.post(`/api/notifications/${n1.id}/read`).set(authHeader(accessToken)).expect(200)

    const after = await api
      .get('/api/notifications/unread-count')
      .set(authHeader(accessToken))
      .expect(200)
    expect(after.body.count).toBe(1)
  })

  it('mark as read is idempotent (200 twice)', async () => {
    const { user, password } = await createTestUser('n-idem@test.local')
    const note = await seedNotification(user.id)
    const { accessToken } = await loginAs('n-idem@test.local', password)

    const first = await api
      .post(`/api/notifications/${note.id}/read`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(first.body.status).toBe('read')

    const second = await api
      .post(`/api/notifications/${note.id}/read`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(second.body.status).toBe('read')
  })

  it('mark all as read updates remaining unread', async () => {
    const { user, password } = await createTestUser('n-all@test.local')
    await seedNotification(user.id)
    await seedNotification(user.id)
    await seedNotification(user.id, { status: 'read' })
    const { accessToken } = await loginAs('n-all@test.local', password)

    const res = await api
      .post('/api/notifications/read-all')
      .set(authHeader(accessToken))
      .expect(200)
    expect(res.body.updated).toBe(2)

    const count = await api
      .get('/api/notifications/unread-count')
      .set(authHeader(accessToken))
      .expect(200)
    expect(count.body.count).toBe(0)
  })

  it('cursor pagination returns hasMore and nextCursor', async () => {
    const { user, password } = await createTestUser('n-page@test.local')
    for (let i = 0; i < 5; i++) {
      await seedNotification(user.id, { title: `N${i}` })
    }
    const { accessToken } = await loginAs('n-page@test.local', password)

    const page1 = await api
      .get('/api/notifications')
      .query({ limit: 2 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(page1.body.notifications).toHaveLength(2)
    expect(page1.body.hasMore).toBe(true)
    expect(page1.body.nextCursor).toBeTypeOf('number')

    const page2 = await api
      .get('/api/notifications')
      .query({ limit: 2, cursor: page1.body.nextCursor })
      .set(authHeader(accessToken))
      .expect(200)
    expect(page2.body.notifications).toHaveLength(2)
    expect(page2.body.notifications[0].id).toBeLessThan(page1.body.notifications[1].id)
  })

  it('filters by status and category', async () => {
    const { user, password } = await createTestUser('n-filter@test.local')
    await seedNotification(user.id, { status: 'unread' })
    await seedNotification(user.id, { status: 'read' })
    const { accessToken } = await loginAs('n-filter@test.local', password)

    const unread = await api
      .get('/api/notifications')
      .query({ status: 'unread' })
      .set(authHeader(accessToken))
      .expect(200)
    expect(unread.body.notifications.every((n: { status: string }) => n.status === 'unread')).toBe(true)

    const orderCat = await api
      .get('/api/notifications')
      .query({ category: 'order' })
      .set(authHeader(accessToken))
      .expect(200)
    expect(orderCat.body.notifications.length).toBeGreaterThanOrEqual(1)
  })

  it('returns 404 when feature flag is off', async () => {
    config.notification.enabled = false
    const { password } = await createTestUser('n-off@test.local')
    const { accessToken } = await loginAs('n-off@test.local', password)
    await api.get('/api/notifications').set(authHeader(accessToken)).expect(404)
    await api.get('/api/notifications/unread-count').set(authHeader(accessToken)).expect(404)
  })

  it('requires authentication', async () => {
    await api.get('/api/notifications').expect(401)
  })

  it('merchant and buyer inboxes are separate', async () => {
    const buyer = await createTestUser('n-roles-b@test.local')
    const merchantUser = await createTestUser('n-roles-m@test.local', 'pass123', 'merchant')
    await prisma.$transaction(async (tx) => {
      await NotificationDispatcher.emit({
        type: 'order.delivered_buyer',
        recipientUserId: buyer.user.id,
        recipientRole: 'user',
        order: { id: 88, deliveryMode: 'manual_service', productName: 'X' },
      }, tx)
      await NotificationDispatcher.emit({
        type: 'order.created_merchant',
        recipientUserId: merchantUser.user.id,
        recipientRole: 'merchant',
        order: { id: 88, merchantId: 1, deliveryMode: 'manual_service', productName: 'X' },
      }, tx)
    })

    const buyerLogin = await loginAs('n-roles-b@test.local', buyer.password)
    const merchantLogin = await loginAs('n-roles-m@test.local', merchantUser.password)

    const buyerList = await api
      .get('/api/notifications')
      .set(authHeader(buyerLogin.accessToken))
      .expect(200)
    expect(buyerList.body.notifications).toHaveLength(1)
    expect(buyerList.body.notifications[0].eventType).toBe('order.delivered_buyer')

    const merchantList = await api
      .get('/api/notifications')
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    expect(merchantList.body.notifications).toHaveLength(1)
    expect(merchantList.body.notifications[0].eventType).toBe('order.created_merchant')
  })
})
