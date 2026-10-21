import { businessRegistry } from './businessRegistry.js'
import { getSystemConfigValue } from './systemConfig.js'
import { normalizePagination } from './paginationPolicy.js'

export async function resolvePagination(page?: number, pageSize?: number) {
  const [defaultPageSize, maxPageSize] = await Promise.all([
    getSystemConfigValue('defaultPageSize'),
    getSystemConfigValue('maxPageSize'),
  ])
  const safeDefaultPageSize = defaultPageSize > 0 ? defaultPageSize : businessRegistry.pagination.defaultPageSize
  const safeMaxPageSize = maxPageSize > 0 ? maxPageSize : businessRegistry.pagination.maxPageSize
  return normalizePagination(page, pageSize, { defaultPageSize: safeDefaultPageSize, maxPageSize: safeMaxPageSize })
}
