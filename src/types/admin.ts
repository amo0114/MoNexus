// 公告相关类型 — 与后端 announcements / admin 模块序列化形状对齐

export type AnnouncementAudience = 'all' | 'user' | 'merchant' | 'admin'
export type AnnouncementStatus = 'draft' | 'published' | 'archived'

/** GET /api/announcements 公开查询返回的精简形状 */
export interface PublicAnnouncement {
  id: number
  title: string
  content: string
  audience: AnnouncementAudience
  priority: number
  startsAt: string
  endsAt: string | null
}

/** GET /api/admin/announcements 返回的完整形状 */
export interface AdminAnnouncement {
  id: number
  title: string
  content: string
  audience: AnnouncementAudience
  priority: number
  startsAt: string
  endsAt: string | null
  status: AnnouncementStatus
  createdBy: number | null
  createdAt: string
  updatedAt: string
}

export interface AdminAnnouncementListQuery {
  status?: AnnouncementStatus
  audience?: AnnouncementAudience
  page?: number
  pageSize?: number
}

export interface CreateAnnouncementRequest {
  title: string
  content: string
  audience?: AnnouncementAudience
  priority?: number
  startsAt: string
  endsAt?: string | null
  status?: AnnouncementStatus
}

export type UpdateAnnouncementRequest = Partial<CreateAnnouncementRequest>
