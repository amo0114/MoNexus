import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import type { CreateAnnouncementInput, UpdateAnnouncementInput, ListAnnouncementsQuery } from './adminSchema.js'

// ---- Announcements ----
//
// PRD §4.3.4：运营自助。公告支持 audience 分发（all/user/merchant/admin）、
// priority 倒序、时间窗口（startsAt/endsAt）、状态（draft/published/archived）。

function serializeAnnouncement(a: {
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
  status: string
  createdBy: number | null
  createdAt: Date
  updatedAt: Date
}) {
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
    status: a.status,
    createdBy: a.createdBy,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

export async function createAnnouncement(adminUserId: number, input: CreateAnnouncementInput) {
  return prisma.$transaction(async tx => {
    const created = await tx.announcement.create({
      data: {
        title: input.title,
        content: input.content,
        audience: input.audience,
        priority: input.priority,
        presentation: input.presentation,
        maxImpressions: input.maxImpressions,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        status: input.status,
        createdBy: adminUserId,
      },
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '创建公告',
        targetType: 'announcement',
        targetId: created.id,
        detail: `标题: ${input.title}，受众: ${input.audience}，展示: ${input.presentation}，状态: ${input.status}`,
      },
    })
    return serializeAnnouncement(created)
  })
}

export async function updateAnnouncement(adminUserId: number, id: number, input: UpdateAnnouncementInput) {
  return prisma.$transaction(async tx => {
    const existing = await tx.announcement.findUnique({ where: { id } })
    if (!existing) throw notFound('公告不存在')

    const startsAt = input.startsAt ?? existing.startsAt
    const endsAt = input.endsAt === undefined ? existing.endsAt : input.endsAt
    if (endsAt && endsAt < startsAt) {
      throw badRequest('结束时间必须晚于开始时间')
    }

    const data: Prisma.AnnouncementUpdateInput = {}
    if (input.title !== undefined) data.title = input.title
    if (input.content !== undefined) data.content = input.content
    if (input.audience !== undefined) data.audience = input.audience
    if (input.priority !== undefined) data.priority = input.priority
    if (input.presentation !== undefined) data.presentation = input.presentation
    if (input.maxImpressions !== undefined) data.maxImpressions = input.maxImpressions
    if (input.startsAt !== undefined) data.startsAt = input.startsAt
    if (input.endsAt !== undefined) data.endsAt = input.endsAt === null ? null : input.endsAt
    if (input.status !== undefined) data.status = input.status

    // A version is a user-facing contract: when the message or its delivery
    // policy changes, previously read/confirmed receipts must not suppress the
    // revised announcement. No-op saves deliberately keep the current version.
    const hasMeaningfulChange =
      (input.title !== undefined && input.title !== existing.title) ||
      (input.content !== undefined && input.content !== existing.content) ||
      (input.audience !== undefined && input.audience !== existing.audience) ||
      (input.priority !== undefined && input.priority !== existing.priority) ||
      (input.presentation !== undefined && input.presentation !== existing.presentation) ||
      (input.maxImpressions !== undefined && input.maxImpressions !== existing.maxImpressions) ||
      (input.status !== undefined && input.status !== existing.status) ||
      (input.startsAt !== undefined && input.startsAt.getTime() !== existing.startsAt.getTime()) ||
      (input.endsAt !== undefined && (input.endsAt?.getTime() ?? null) !== (existing.endsAt?.getTime() ?? null))
    if (hasMeaningfulChange) data.version = { increment: 1 }

    const updated = await tx.announcement.update({ where: { id }, data })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '更新公告',
        targetType: 'announcement',
        targetId: id,
        detail: `字段: ${Object.keys(input).join(',')}`,
      },
    })
    return serializeAnnouncement(updated)
  })
}

export async function listAnnouncements(query: ListAnnouncementsQuery = { page: 1, pageSize: 20 }) {
  const where: Prisma.AnnouncementWhereInput = {}
  if (query.status) where.status = query.status
  if (query.audience) where.audience = query.audience

  const [total, items] = await prisma.$transaction([
    prisma.announcement.count({ where }),
    prisma.announcement.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ])
  return { items: items.map(serializeAnnouncement), total, page: query.page, pageSize: query.pageSize }
}

export async function deleteAnnouncement(adminUserId: number, id: number) {
  return prisma.$transaction(async tx => {
    const existing = await tx.announcement.findUnique({ where: { id } })
    if (!existing) throw notFound('公告不存在')
    await tx.announcement.delete({ where: { id } })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '删除公告',
        targetType: 'announcement',
        targetId: id,
        detail: `标题: ${existing.title}`,
      },
    })
    return { deleted: id }
  })
}
