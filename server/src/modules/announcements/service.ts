import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'

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

function visibleAnnouncementWhere(audience?: AnnouncementAudience): Prisma.AnnouncementWhereInput {
  const now = new Date()
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
  const items = await prisma.announcement.findMany({
    where: visibleAnnouncementWhere(audience),
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

async function findVisibleAnnouncement(id: number, audience?: AnnouncementAudience) {
  const announcement = await prisma.announcement.findFirst({
    where: { AND: [visibleAnnouncementWhere(audience), { id }] },
  })
  if (!announcement) throw notFound('公告不存在或当前不可见')
  return announcement
}

export async function markAnnouncementRead(id: number, userId: number, audience?: AnnouncementAudience) {
  const announcement = await findVisibleAnnouncement(id, audience)
  const receipt = await prisma.announcementReceipt.upsert({
    where: {
      announcementId_userId_version: {
        announcementId: announcement.id,
        userId,
        version: announcement.version,
      },
    },
    create: {
      announcementId: announcement.id,
      userId,
      version: announcement.version,
      readAt: new Date(),
    },
    update: { readAt: new Date() },
    select: { readAt: true, acknowledgedAt: true },
  })

  return {
    id: announcement.id,
    version: announcement.version,
    readAt: receipt.readAt!.toISOString(),
    acknowledgedAt: receipt.acknowledgedAt?.toISOString() ?? null,
  }
}

export async function acknowledgeAnnouncement(id: number, userId: number, audience?: AnnouncementAudience) {
  const announcement = await findVisibleAnnouncement(id, audience)
  if (announcement.presentation !== 'acknowledgement_required') {
    throw badRequest('该公告无需确认')
  }

  const now = new Date()
  const receipt = await prisma.announcementReceipt.upsert({
    where: {
      announcementId_userId_version: {
        announcementId: announcement.id,
        userId,
        version: announcement.version,
      },
    },
    create: {
      announcementId: announcement.id,
      userId,
      version: announcement.version,
      readAt: now,
      acknowledgedAt: now,
    },
    update: { readAt: now, acknowledgedAt: now },
    select: { readAt: true, acknowledgedAt: true },
  })

  return {
    id: announcement.id,
    version: announcement.version,
    readAt: receipt.readAt!.toISOString(),
    acknowledgedAt: receipt.acknowledgedAt!.toISOString(),
  }
}
