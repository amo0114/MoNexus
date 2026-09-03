import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { __runNotificationExpiryBatchForTests } from '../modules/notifications/expiryCron.js'
import {
  getUnreadCount,
  listNotifications,
  markAllAsRead,
} from '../modules/notifications/service.js'

/**
 * PR-4 / SPEC-ORDER-NOTIFY D-05：通知过期生命周期。
 * - 过期未读立即从铃铛计数与默认列表消失（不依赖 cron 及时性）；
 * - 归档 cron 把到期行收敛为 archived（幂等，不物理删除）；
 * - status=archived 保留为显式历史查询；
 * - markAllAsRead 不处理过期行。
 */

const PASSWORD = 'pass123'
const HOUR = 60 * 60 * 1000

let userSeq = 0

async function makeUser() {
  userSeq += 1
  const { user } = await createTestUser(`notif-expiry-${userSeq}@test.local`, PASSWORD, 'user', 0)
  return user
}

async function makeNotification(userId: number, opts: { expiresAt?: Date | null; status?: string; dedupe?: string } = {}) {
  return prisma.notification.create({
    data: {
      recipientUserId: userId,
      recipientRole: 'user',
      eventType: 'order.delivered_buyer',
      category: 'order',
      title: '过期生命周期测试通知',
      body: 'PR-4 测试用例',
      dedupeKey: `dedupe-${opts.dedupe ?? Math.random().toString(36).slice(2)}`,
      deeplink: '/orders',
      status: opts.status ?? 'unread',
      expiresAt: opts.expiresAt ?? null,
    },
  })
}

beforeEach(async () => {
  // Notification 在 setup.ts 的 TRUNCATE 列表内，无需额外清理。
  // HTTP 用例需要通知功能开关打开（测试环境默认关闭，惯例同 service.test.ts）。
  config.notification.enabled = true
})

afterEach(() => {
  config.notification.enabled = false
})

describe('通知过期 — 读取侧立即排除 (D-05)', () => {
  it('过期未读不计入铃铛未读数；未过期与无过期时间的照常计入', async () => {
    const user = await makeUser()
    await makeNotification(user.id, { expiresAt: new Date(Date.now() - HOUR) }) // 已过期
    await makeNotification(user.id, { expiresAt: new Date(Date.now() + HOUR) }) // 未过期
    await makeNotification(user.id, { expiresAt: null }) // 永不过期

    const { count } = await getUnreadCount(user.id)
    expect(count).toBe(2)
  })

  it('默认列表排除逻辑过期与 archived 行；status=archived 显式历史查询可见', async () => {
    const user = await makeUser()
    const expired = await makeNotification(user.id, { expiresAt: new Date(Date.now() - HOUR) })
    const archived = await makeNotification(user.id, { status: 'archived', dedupe: 'arch' })
    const live = await makeNotification(user.id, { expiresAt: new Date(Date.now() + HOUR), dedupe: 'live' })

    const list = await listNotifications(user.id)
    expect(list.notifications.map(n => n.id)).toEqual([live.id])

    // 显式历史查询：archived 行原样可见。
    const history = await listNotifications(user.id, { status: 'archived' })
    expect(history.notifications.map(n => n.id)).toEqual([archived.id])

    // 行未物理删除：过期行仍在库里，只是不可见。
    expect(await prisma.notification.findUnique({ where: { id: expired.id } })).not.toBeNull()
  })

  it('markAllAsRead 不处理过期未读行', async () => {
    const user = await makeUser()
    const expired = await makeNotification(user.id, { expiresAt: new Date(Date.now() - HOUR) })
    const live = await makeNotification(user.id, { dedupe: 'live' })

    const { updated } = await markAllAsRead(user.id)
    expect(updated).toBe(1)

    const rows = await prisma.notification.findMany({ where: { recipientUserId: user.id } })
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get(live.id)!.status).toBe('read')
    expect(byId.get(expired.id)!.status).toBe('unread')
  })
})

describe('通知过期 — 归档 cron (D-05)', () => {
  it('到期行收敛为 archived（幂等），未到期行不受影响', async () => {
    const user = await makeUser()
    const expiredUnread = await makeNotification(user.id, { expiresAt: new Date(Date.now() - HOUR) })
    const expiredRead = await makeNotification(user.id, { expiresAt: new Date(Date.now() - 2 * HOUR), status: 'read', dedupe: 'r' })
    const live = await makeNotification(user.id, { expiresAt: new Date(Date.now() + HOUR), dedupe: 'live' })

    await __runNotificationExpiryBatchForTests()

    expect((await prisma.notification.findUniqueOrThrow({ where: { id: expiredUnread.id } })).status).toBe('archived')
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: expiredRead.id } })).status).toBe('archived')
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('unread')

    // 幂等：重复执行零副作用。
    await __runNotificationExpiryBatchForTests()
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: expiredUnread.id } })).status).toBe('archived')
  })

  it('unread-count 接口（HTTP）对过期行立即归零', async () => {
    const user = await makeUser()
    await makeNotification(user.id, { expiresAt: new Date(Date.now() - HOUR) })

    const { accessToken } = await loginAs(`notif-expiry-${userSeq}@test.local`, PASSWORD)
    const res = await api.get('/api/notifications/unread-count').set(authHeader(accessToken)).expect(200)
    expect(res.body.count).toBe(0)
  })
})
