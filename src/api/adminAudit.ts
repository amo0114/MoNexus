import api from './client'

export interface AdminLogEntry {
  id: number
  adminId: number
  adminEmail: string
  action: string
  targetType: string
  targetId: number | null
  metadata: Record<string, unknown> | null
  createdAt: string  // ISO
}

export interface AdminLogListResponse {
  items: AdminLogEntry[]
  total: number
  page: number
  pageSize: number
}

export interface AdminLogQuery {
  page?: number
  pageSize?: number
  adminId?: number
  action?: string
  fromDate?: string  // YYYY-MM-DD
  toDate?: string
}

export async function listAdminAudit(query: AdminLogQuery = {}): Promise<AdminLogListResponse> {
  const { data } = await api.get<AdminLogListResponse>('/admin/audit', { params: query })
  return data
}
