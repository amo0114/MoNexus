/**
 * SPEC-NOTIFY-001 notification inbox service (list / unread / mark read).
 * NTF-09: callers may only access rows where recipientUserId = me.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { buildNotificationEnvelope, type NotificationEnvelope } from './realtime/protocol.js'
export type ListNotificationsParams = {
  cursor?: number
  limit?: number
  status?: 'unread' | 'read' | 'archived'
  category?: string
}

/**
 * D-05：逻辑未过期条件（expiresAt 为空或**严格晚于** now，等于 now 视为
 * 已过期——与归档 cron 的 `lte` 判定同向）。unread-count / 列表各视图 /
 * markAllAsRead / 单条 markAsRead 都按它过滤，正确性不依赖归档 cron 的
 * 及时性；cron（expiryCron.ts）只负责把存储状态最终收敛为 archived。
 */
function notExpired(now: Date): Prisma.NotificationWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
}

/** 行级判断：该通知是否仍在逻辑有效期内。 */
function isNotExpired(row: { expiresAt: Date | null }, now: Date): boolean {
  return row.expiresAt === null || row.expiresAt.getTime() > now.getTime()
}

function serializeNotification(row: {
  id: number
  eventType: string
  category: string
  title: string
  body: string
  level: string
  status: string
  deeplink: string
  relatedOrderId: number | null
  readAt: Date | null
  createdAt: Date
  payload: Prisma.JsonValue | null
}) {
  return {
    id: row.id,
    eventType: row.eventType,
    category: row.category,
    title: row.title,
    body: row.body,
    level: row.level,
    status: row.status,
    deeplink: row.deeplink,
    relatedOrderId: row.relatedOrderId,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    // payload is optional in list responses; keep for clients that need orderId
    payload: row.payload ?? null,
  }
}

export async function listNotifications(userId: number, params: ListNotificationsParams = {}) {
  const limit = params.limit ?? 20
  const where: Prisma.NotificationWhereInput = {
    recipientUserId: userId,
  }
  if (params.status) {
    // D-05 复审：unread / read 视图同样立即排除逻辑过期行——只有显式
    // status=archived 历史查询允许跨时间读取归档行。
    where.status = params.status
    if (params.status !== 'archived') {
      Object.assign(where, notExpired(new Date()))
    }
  } else {
    // 默认视图排除 archived 与逻辑已过期行（D-05）。
    where.status = { not: 'archived' }
    Object.assign(where, notExpired(new Date()))
  }
  if (params.category) where.category = params.category
  if (params.cursor != null) {
    where.id = { lt: params.cursor }
  }

  const rows = await prisma.notification.findMany({
    where,
    orderBy: { id: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      eventType: true,
      category: true,
      title: true,
      body: true,
      level: true,
      status: true,
      deeplink: true,
      relatedOrderId: true,
      readAt: true,
      createdAt: true,
      payload: true,
    },
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? page[page.length - 1]!.id : null

  return {
    notifications: page.map(serializeNotification),
    nextCursor,
    hasMore,
  }
}

export async function getUnreadCount(userId: number): Promise<{ count: number }> {
  const count = await prisma.notification.count({
    // D-05：立即排除逻辑已过期行——铃铛角标不依赖归档 cron 是否已跑。
    where: { recipientUserId: userId, status: 'unread', ...notExpired(new Date()) },
  })
  return { count }
}

export async function markAsRead(userId: number, notificationId: number) {
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, recipientUserId: userId },
    select: {
      id: true,
      status: true,
      readAt: true,
      expiresAt: true,
      eventType: true,
      category: true,
      title: true,
      body: true,
      level: true,
      deeplink: true,
      relatedOrderId: true,
      createdAt: true,
      payload: true,
    },
  })
  if (!existing) throw notFound('通知不存在')

  if (existing.status === 'read' || existing.status === 'archived') {
    return {
      id: existing.id,
      status: existing.status,
      readAt: existing.readAt ? existing.readAt.toISOString() : null,
    }
  }

  const now = new Date()

  // D-05 复审：逻辑已过期的未读行不能被改成 read——原子收敛为 archived
  // （与归档 cron 同一朝向，绝不复活），并按实际状态返回。
  if (!isNotExpired(existing, now)) {
    await prisma.notification.updateMany({
      where: { id: notificationId, recipientUserId: userId, status: 'unread', expiresAt: { lte: now } },
      data: { status: 'archived' },
    })
    const converged = await prisma.notification.findFirst({
      where: { id: notificationId, recipientUserId: userId },
      select: { id: true, status: true, readAt: true },
    })
    if (!converged) throw notFound('通知不存在')
    return {
      id: converged.id,
      status: converged.status,
      readAt: converged.readAt ? converged.readAt.toISOString() : null,
    }
  }

  const updated = await prisma.notification.updateMany({
    // 过期判定进入原子条件：行在本函数运行期间到期时这里落空，走下方
    // 回读路径返回实际状态（不得把已到期行改成 read）。
    where: { id: notificationId, recipientUserId: userId, status: 'unread', ...notExpired(now) },
    data: { status: 'read', readAt: now },
  })

  // Concurrent mark-as-read: treat as already read (idempotent 200).
  if (updated.count === 0) {
    const again = await prisma.notification.findFirst({
      where: { id: notificationId, recipientUserId: userId },
      select: { id: true, status: true, readAt: true },
    })
    if (!again) throw notFound('通知不存在')
    return {
      id: again.id,
      status: again.status,
      readAt: again.readAt ? again.readAt.toISOString() : null,
    }
  }

  return {
    id: existing.id,
    status: 'read' as const,
    readAt: now.toISOString(),
  }
}

export async function markAllAsRead(userId: number): Promise<{ updated: number }> {
  const now = new Date()
  const result = await prisma.notification.updateMany({
    // D-05：过期未读行归档 cron 会收走，「全部已读」不处理它们
    // （既不读也不复活——它们对用户已不可见）。
    where: { recipientUserId: userId, status: 'unread', ...notExpired(now) },
    data: { status: 'read', readAt: now },
  })
  return { updated: result.count }
}

/**
 * SPEC-NOTIFY-RT-001 (T-BE-003): safe realtime envelope projection.
 *
 * Explicit column allowlist only — the full Json `payload` (and dedupeKey /
 * recipientUserId) is never returned. deliveryMode / deliveryKind are pulled
 * out as JSON sub-values and re-validated by buildNotificationEnvelope (second
 * sanitization pass). Invalid rows return null (wait for REST convergence).
 */
export async function getRealtimeEnvelope(
  notificationId: number,
  recipientUserId: number
): Promise<NotificationEnvelope | null> {
  type ProjectionRow = {
    id: number
    eventType: string
    category: string
    title: string
    body: string
    level: string
    deeplink: string
    relatedOrderId: number | null
    createdAt: Date
    deliveryMode: string | null
    deliveryKind: string | null
  }
  const rows = await prisma.$queryRaw<ProjectionRow[]>`
    SELECT id, "eventType", category, title, body, level, deeplink, "relatedOrderId", "createdAt",
           payload->>'deliveryMode' AS "deliveryMode",
           payload->>'deliveryKind' AS "deliveryKind"
    FROM "Notification"
    WHERE id = ${notificationId} AND "recipientUserId" = ${recipientUserId}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return buildNotificationEnvelope({
    id: Number(row.id),
    eventType: row.eventType,
    category: row.category,
    title: row.title,
    body: row.body,
    level: row.level,
    deeplink: row.deeplink,
    relatedOrderId: row.relatedOrderId == null ? null : Number(row.relatedOrderId),
    createdAt: row.createdAt,
    deliveryMode: row.deliveryMode ?? undefined,
    deliveryKind: row.deliveryKind ?? undefined,
  })
}
