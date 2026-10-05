import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import {
  announcementVersionChanged,
  badRequest,
  notFound,
} from '../../lib/httpError.js'

export type AnnouncementAudience = 'all' | 'user' | 'merchant' | 'admin'

type Receipt = {
  announcementId: number
  version: number
  readAt: Date | null
  acknowledgedAt: Date | null
}

type AnnouncementForPublic = {
  id: number
  title: string
  content: string
  audience: string
  priority: number
  presentation: string
  maxImpressions: number
  version: number
  startsAt: Date
  endsAt: Date | null
  updatedAt: Date
}

function serializePublicAnnouncement(a: AnnouncementForPublic, receipt?: Receipt) {
  return {
    id: a.id,
    title: a.title,
    content: a.content,
    audience: a.audience,
    priority: a.priority,
    presentation: a.presentation,
    maxImpressions: a.maxImpressions,
    version: a.version,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt ? a.endsAt.toISOString() : null,
    updatedAt: a.updatedAt.toISOString(),
    readAt: receipt?.readAt?.toISOString() ?? null,
    acknowledgedAt: receipt?.acknowledgedAt?.toISOString() ?? null,
  }
}

function visibleAnnouncementWhere(
  audience: AnnouncementAudience | undefined,
  now: Date,
): Prisma.AnnouncementWhereInput {
  const timeFilter: Prisma.AnnouncementWhereInput = {
    status: 'published',
    startsAt: { lte: now },
    OR: [{ endsAt: null }, { endsAt: { gte: now } }],
  }

  return audience && audience !== 'all'
    ? { AND: [timeFilter, { OR: [{ audience: 'all' }, { audience }] }] }
    : { ...timeFilter, audience: 'all' }
}

// 公开查询只返回 published 且在时间窗口内的公告。访客仅看到 all；
// 已认证调用方的 audience 始终由当前用户角色派生，不能由请求参数指定。
export async function listPublicAnnouncements(audience?: AnnouncementAudience, userId?: number) {
  const now = new Date()
  const items = await prisma.announcement.findMany({
    where: visibleAnnouncementWhere(audience, now),
    orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'desc' }],
    take: 50,
  })

  if (!userId || items.length === 0) {
    return items.map((item) => serializePublicAnnouncement(item))
  }

  const receipts = await prisma.announcementReceipt.findMany({
    where: { userId, announcementId: { in: items.map((item) => item.id) } },
    select: {
      announcementId: true,
      version: true,
      readAt: true,
      acknowledgedAt: true,
    },
  })
  const receiptByAnnouncementVersion = new Map(
    receipts.map((receipt) => [`${receipt.announcementId}:${receipt.version}`, receipt]),
  )

  return items.map((item) => serializePublicAnnouncement(
    item,
    receiptByAnnouncementVersion.get(`${item.id}:${item.version}`),
  ))
}

async function lockVisibleAnnouncementVersion(
  tx: Prisma.TransactionClient,
  id: number,
  expectedVersion: number,
  audience?: AnnouncementAudience,
) {
  await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "Announcement" WHERE "id" = ${id} FOR UPDATE
  `

  const now = new Date()
  const announcement = await tx.announcement.findFirst({
    where: { AND: [visibleAnnouncementWhere(audience, now), { id }] },
  })
  if (!announcement) throw notFound('公告不存在或当前不可见')
  if (announcement.version !== expectedVersion) throw announcementVersionChanged()

  return { announcement, now }
}

async function markReceiptRead(
  tx: Prisma.TransactionClient,
  announcementId: number,
  userId: number,
  version: number,
  now: Date,
) {
  const where = {
    announcementId_userId_version: { announcementId, userId, version },
  }
  const existing = await tx.announcementReceipt.findUnique({
    where,
    select: { readAt: true, acknowledgedAt: true },
  })

  if (!existing) {
    return tx.announcementReceipt.create({
      data: { announcementId, userId, version, readAt: now },
      select: { readAt: true, acknowledgedAt: true },
    })
  }
  if (existing.readAt) return existing

  return tx.announcementReceipt.update({
    where,
    data: { readAt: now },
    select: { readAt: true, acknowledgedAt: true },
  })
}

export async function markAnnouncementRead(
  id: number,
  userId: number,
  version: number,
  audience?: AnnouncementAudience,
) {
  return prisma.$transaction(async (tx) => {
    const { announcement, now } = await lockVisibleAnnouncementVersion(tx, id, version, audience)
    const receipt = await markReceiptRead(tx, announcement.id, userId, version, now)

    return {
      id: announcement.id,
      version,
      readAt: receipt.readAt!.toISOString(),
      acknowledgedAt: receipt.acknowledgedAt?.toISOString() ?? null,
    }
  })
}

export async function acknowledgeAnnouncement(
  id: number,
  userId: number,
  version: number,
  audience?: AnnouncementAudience,
) {
  return prisma.$transaction(async (tx) => {
    const { announcement, now } = await lockVisibleAnnouncementVersion(tx, id, version, audience)
    if (announcement.presentation !== 'acknowledgement_required') {
      throw badRequest('该公告无需确认')
    }

    const where = {
      announcementId_userId_version: { announcementId: announcement.id, userId, version },
    }
    const existing = await tx.announcementReceipt.findUnique({
      where,
      select: { readAt: true, acknowledgedAt: true },
    })
    const receipt = !existing
      ? await tx.announcementReceipt.create({
          data: {
            announcementId: announcement.id,
            userId,
            version,
            readAt: now,
            acknowledgedAt: now,
          },
          select: { readAt: true, acknowledgedAt: true },
        })
      : existing.acknowledgedAt
        ? existing
        : await tx.announcementReceipt.update({
            where,
            data: {
              readAt: existing.readAt ?? now,
              acknowledgedAt: now,
            },
            select: { readAt: true, acknowledgedAt: true },
          })

    return {
      id: announcement.id,
      version,
      readAt: receipt.readAt!.toISOString(),
      acknowledgedAt: receipt.acknowledgedAt!.toISOString(),
    }
  })
}
