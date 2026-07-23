import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'

type AnnouncementAudience = 'all' | 'user' | 'merchant' | 'admin'

function serializePublicAnnouncement(a: {
  id: number
  title: string
  content: string
  audience: string
  priority: number
  startsAt: Date
  endsAt: Date | null
  updatedAt: Date
}) {
  return {
    id: a.id,
    title: a.title,
    content: a.content,
    audience: a.audience,
    priority: a.priority,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt ? a.endsAt.toISOString() : null,
    updatedAt: a.updatedAt.toISOString(),
  }
}

// PRD §4.3.4：公开查询仅返回 published 且在时间窗口内（startsAt<=now 且 endsAt 为空或 >=now）的公告。
// 访客仅返回 audience='all'；已认证调用方的 audience 由其 Token 角色派生。
export async function listPublicAnnouncements(audience?: AnnouncementAudience) {
  const now = new Date()
  const timeFilter: Prisma.AnnouncementWhereInput = {
    status: 'published',
    startsAt: { lte: now },
    OR: [{ endsAt: null }, { endsAt: { gte: now } }],
  }

  const where: Prisma.AnnouncementWhereInput = audience && audience !== 'all'
    ? { AND: [timeFilter, { OR: [{ audience: 'all' }, { audience }] }] }
    : { ...timeFilter, audience: 'all' }

  const items = await prisma.announcement.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'desc' }],
    take: 50,
  })
  return items.map(serializePublicAnnouncement)
}
