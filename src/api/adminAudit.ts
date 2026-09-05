import api from './client'

export interface AdminAuditItem {
  id: number
  adminId: number
  adminEmail: string
  action: string
  targetType: string | null
  targetId: number | null
  createdAt: string
}

export interface AdminAuditPaged {
  items: AdminAuditItem[]
  total: number
  page: number
  pageSize: number
}

// Backward compatibility aliases
export type AdminLogEntry = AdminAuditItem
export type AdminLogListResponse = AdminAuditPaged

export interface AdminLogQuery {
  page?: number
  pageSize?: number
  adminId?: number
  action?: string
  targetType?: string
  fromDate?: string
  toDate?: string
}

const ISO_DATE_REGEX = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

export function isValidIsoDateString(val: unknown): boolean {
  if (typeof val !== 'string') return false
  const match = ISO_DATE_REGEX.exec(val)
  if (!match) return false
  const [, datePart, hourStr, minStr, secStr] = match
  const [yearStr, monthStr, dayStr] = datePart.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const d = new Date(Date.UTC(year, month - 1, day))
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return false
  }
  const hour = Number(hourStr)
  const min = Number(minStr)
  const sec = Number(secStr)
  if (hour > 23 || min > 59 || sec > 59) return false
  return !isNaN(Date.parse(val))
}

export function isValidAdminAuditItem(item: unknown): item is AdminAuditItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return false
  }
  const record = item as Record<string, unknown>

  if (
    typeof record.id !== 'number' ||
    !Number.isSafeInteger(record.id) ||
    record.id <= 0
  ) {
    return false
  }

  if (
    typeof record.adminId !== 'number' ||
    !Number.isSafeInteger(record.adminId) ||
    record.adminId <= 0
  ) {
    return false
  }

  if (typeof record.adminEmail !== 'string' || record.adminEmail.trim().length === 0) {
    return false
  }

  if (typeof record.action !== 'string' || record.action.trim().length === 0) {
    return false
  }

  if (record.targetType !== null) {
    if (typeof record.targetType !== 'string' || record.targetType.trim().length === 0) {
      return false
    }
  }

  if (record.targetId !== null) {
    if (
      typeof record.targetId !== 'number' ||
      !Number.isSafeInteger(record.targetId) ||
      record.targetId <= 0
    ) {
      return false
    }
  }

  if (!isValidIsoDateString(record.createdAt)) {
    return false
  }

  return true
}

export function parseAdminAuditResponse(data: unknown): AdminAuditPaged {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }')
  }

  const record = data as Record<string, unknown>

  if (
    typeof record.total !== 'number' ||
    !Number.isSafeInteger(record.total) ||
    record.total < 0
  ) {
    throw new Error('操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }')
  }

  if (
    typeof record.page !== 'number' ||
    !Number.isSafeInteger(record.page) ||
    record.page <= 0
  ) {
    throw new Error('操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }')
  }

  if (
    typeof record.pageSize !== 'number' ||
    !Number.isSafeInteger(record.pageSize) ||
    record.pageSize < 1 ||
    record.pageSize > 100
  ) {
    throw new Error('操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }')
  }

  if (!Array.isArray(record.items)) {
    throw new Error('操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }')
  }

  for (const item of record.items) {
    if (!isValidAdminAuditItem(item)) {
      throw new Error('操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }')
    }
  }

  return {
    items: record.items as AdminAuditItem[],
    total: record.total,
    page: record.page,
    pageSize: record.pageSize,
  }
}

export async function listAdminAudit(query: AdminLogQuery = {}): Promise<AdminAuditPaged> {
  const { data } = await api.get('/admin/audit', { params: query })
  return parseAdminAuditResponse(data)
}
