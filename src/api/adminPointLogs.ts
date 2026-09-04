import api from './client'

export const VALID_POINT_LOG_TYPES = new Set([
  'in',
  'out',
  'hold',
  'release',
  'refund',
  'sandbox_in',
] as const)

export type PointLogType = 'in' | 'out' | 'hold' | 'release' | 'refund' | 'sandbox_in'

export interface AdminPointLogUser {
  id: number
  email: string
  nickname: string | null
}

export interface AdminPointLogItem {
  id: number
  userId: number
  type: PointLogType
  amount: number
  balanceAfter: number
  reason: string | null
  orderId: number | null
  createdAt: string
  user?: AdminPointLogUser | null
  order?: {
    id: number
  } | null
}

export interface AdminPointLogsPaged {
  items: AdminPointLogItem[]
  total: number
  page: number
  pageSize: number
}

export interface ListAdminPointLogsParams {
  page?: number
  pageSize?: number
  userId?: number
  email?: string
  type?: string
  from?: string
  to?: string
}

export function isValidPointLogUser(user: unknown): boolean {
  if (user === null || user === undefined) return true
  if (typeof user !== 'object' || Array.isArray(user)) return false
  const candidate = user as Record<string, unknown>
  return (
    typeof candidate.id === 'number' &&
    Number.isSafeInteger(candidate.id) &&
    candidate.id > 0 &&
    typeof candidate.email === 'string' &&
    candidate.email.trim().length > 0 &&
    'nickname' in candidate &&
    (candidate.nickname === null || typeof candidate.nickname === 'string')
  )
}

export function isValidPointLogOrder(order: unknown): boolean {
  if (order === null || order === undefined) return true
  if (typeof order !== 'object' || Array.isArray(order)) return false
  const candidate = order as Record<string, unknown>
  return (
    typeof candidate.id === 'number' &&
    Number.isSafeInteger(candidate.id) &&
    candidate.id > 0
  )
}

export function isValidAdminPointLogItem(item: unknown): item is AdminPointLogItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  const candidate = item as Record<string, unknown>
  return (
    typeof candidate.id === 'number' &&
    Number.isSafeInteger(candidate.id) &&
    candidate.id > 0 &&
    typeof candidate.userId === 'number' &&
    Number.isSafeInteger(candidate.userId) &&
    candidate.userId > 0 &&
    typeof candidate.type === 'string' &&
    VALID_POINT_LOG_TYPES.has(candidate.type as PointLogType) &&
    typeof candidate.amount === 'number' &&
    Number.isSafeInteger(candidate.amount) &&
    typeof candidate.balanceAfter === 'number' &&
    Number.isSafeInteger(candidate.balanceAfter) &&
    'reason' in candidate &&
    (candidate.reason === null || typeof candidate.reason === 'string') &&
    'orderId' in candidate &&
    (candidate.orderId === null ||
      (typeof candidate.orderId === 'number' &&
        Number.isSafeInteger(candidate.orderId) &&
        candidate.orderId > 0)) &&
    typeof candidate.createdAt === 'string' &&
    candidate.createdAt.trim().length > 0 &&
    !Number.isNaN(Date.parse(candidate.createdAt)) &&
    isValidPointLogUser(candidate.user) &&
    isValidPointLogOrder(candidate.order)
  )
}

export async function listAdminPointLogs(
  params?: ListAdminPointLogsParams,
): Promise<AdminPointLogsPaged> {
  const { data } = await api.get<AdminPointLogsPaged>('/admin/point-logs', {
    params,
  })

  const isValidEnvelope =
    Boolean(data) &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    Array.isArray(data.items) &&
    typeof data.total === 'number' &&
    Number.isSafeInteger(data.total) &&
    data.total >= 0 &&
    typeof data.page === 'number' &&
    Number.isSafeInteger(data.page) &&
    data.page >= 1 &&
    typeof data.pageSize === 'number' &&
    Number.isSafeInteger(data.pageSize) &&
    data.pageSize >= 1 &&
    data.pageSize <= 100 &&
    data.items.every(isValidAdminPointLogItem)

  if (!isValidEnvelope) {
    throw new Error('积分流水接口契约异常：预期分页对象格式 { items, total, page, pageSize }')
  }

  return data
}
