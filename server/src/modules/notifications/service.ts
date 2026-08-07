/**
 * SPEC-NOTIFY-001 notification inbox service (list / unread / mark read).
 * NTF-09: callers may only access rows where recipientUserId = me.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'

export type ListNotificationsParams = {
  cursor?: number
  limit?: number
  status?: 'unread' | 'read' | 'archived'
  category?: string
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
  if (params.status) where.status = params.status
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
    where: { recipientUserId: userId, status: 'unread' },
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
  const updated = await prisma.notification.updateMany({
    where: { id: notificationId, recipientUserId: userId, status: 'unread' },
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
    where: { recipientUserId: userId, status: 'unread' },
    data: { status: 'read', readAt: now },
  })
  return { updated: result.count }
}
