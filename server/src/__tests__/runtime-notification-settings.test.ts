import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { NotificationDispatcher } from '../modules/notifications/dispatcher.js'

const keys = ['notificationEnabled', 'notificationExpiryDays']
const original = { ...config.notification }
let token: string
let userId: number
beforeEach(async () => {
  await prisma.systemConfig.deleteMany({ where: { key: { in: keys } } })
  config.notification.enabled = false
  config.notification.expiryDays = 90
  const actor = await createTestUser('runtime-notifications@test.local', 'pass123', 'admin')
  userId = actor.user.id
  token = (await loginAs(actor.user.email, actor.password)).accessToken
})
afterEach(async () => {
  Object.assign(config.notification, original)
  await prisma.systemConfig.deleteMany({ where: { key: { in: keys } } })
})
const save = (key: string, value: number) => api.put(`/api/admin/config/${key}`).set(authHeader(token)).send({ value })
const emit = (id: number) => prisma.$transaction(tx => NotificationDispatcher.emit({
  type: 'order.delivered_buyer', recipientUserId: userId, recipientRole: 'user',
  order: { id, deliveryMode: 'instant_fixed', productName: '商品' },
}, tx))

describe('notification operational settings', () => {
  it('uses env bootstrap until an admin save, then updates REST, registry and writes without a restart', async () => {
    await api.get('/api/notifications').set(authHeader(token)).expect(404)
    await emit(1)
    expect(await prisma.notification.count()).toBe(0)
    await save('notificationEnabled', 1).expect(200)
    await api.get('/api/notifications').set(authHeader(token)).expect(200)
    expect((await api.get('/api/config/registry')).body.capabilities.notifications).toBe(true)
    await emit(2)
    expect(await prisma.notification.count()).toBe(1)
    await save('notificationEnabled', 0).expect(200)
    config.notification.enabled = true // stale bootstrap cannot override saved zero
    await api.get('/api/notifications').set(authHeader(token)).expect(404)
    expect((await api.get('/api/config/registry')).body.capabilities.notifications).toBe(false)
    await emit(3)
    expect(await prisma.notification.count()).toBe(1)
  })

  it('reads settings within the business transaction and only changes expiry for new notifications', async () => {
    const started = Date.now()
    await prisma.$transaction(async tx => {
      await tx.systemConfig.createMany({ data: [{ key: 'notificationEnabled', value: 1 }, { key: 'notificationExpiryDays', value: 3 }] })
      await NotificationDispatcher.emit({
        type: 'order.delivered_buyer', recipientUserId: userId, recipientRole: 'user',
        order: { id: 1, deliveryMode: 'instant_fixed', productName: '商品' },
      }, tx)
    })
    const first = await prisma.notification.findFirstOrThrow()
    expect(first.expiresAt!.getTime()).toBeGreaterThanOrEqual(started + 3 * 86400_000)
    expect(first.expiresAt!.getTime()).toBeLessThan(Date.now() + 3 * 86400_000 + 1000)
    await save('notificationExpiryDays', 7).expect(200)
    await emit(2)
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: first.id } })).expiresAt).toEqual(first.expiresAt)
    const second = await prisma.notification.findFirstOrThrow({ where: { relatedOrderId: 2 } })
    expect(second.expiresAt!.getTime()).toBeGreaterThanOrEqual(started + 7 * 86400_000)
  })

  it('validates boolean and retention bounds and audits operational changes', async () => {
    await save('notificationEnabled', 2).expect(400)
    await save('notificationExpiryDays', 0).expect(400)
    await save('notificationExpiryDays', 366).expect(400)
    await save('notificationEnabled', 1).expect(200)
    const logs = await prisma.adminLog.findMany({ where: { targetType: 'systemConfig' } })
    expect(logs.some(log => log.detail?.includes('notificationEnabled: 0 -> 1'))).toBe(true)
  })
})
