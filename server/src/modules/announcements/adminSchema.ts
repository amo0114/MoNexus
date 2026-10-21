import { z } from 'zod'

// ---- Announcements ----

export const ANNOUNCEMENT_AUDIENCES = ['all', 'user', 'merchant', 'admin'] as const
export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const
export const ANNOUNCEMENT_PRESENTATIONS = ['notice', 'important', 'acknowledgement_required'] as const

export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200, '标题最多 200 字'),
  content: z.string().trim().min(1, '内容不能为空').max(5000, '内容最多 5000 字'),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).default('all'),
  priority: z.number().int().min(-1000).max(1000).default(0),
  presentation: z.enum(ANNOUNCEMENT_PRESENTATIONS).default('notice'),
  maxImpressions: z.number().int().min(1).max(3).default(3),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  status: z.enum(ANNOUNCEMENT_STATUSES).default('draft'),
}).strict().refine(
  (data) => !data.endsAt || data.endsAt >= data.startsAt,
  { message: '结束时间必须晚于开始时间', path: ['endsAt'] }
)

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>

export const updateAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(5000).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  presentation: z.enum(ANNOUNCEMENT_PRESENTATIONS).optional(),
  maxImpressions: z.number().int().min(1).max(3).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
}).strict().refine(
  (data) => {
    if (data.endsAt !== undefined && data.endsAt !== null && data.startsAt) {
      return data.endsAt >= data.startsAt
    }
    return true
  },
  { message: '结束时间必须晚于开始时间', path: ['endsAt'] }
)

export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>

export const listAnnouncementsQuerySchema = z.object({
  status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

export type ListAnnouncementsQuery = z.infer<typeof listAnnouncementsQuerySchema>
