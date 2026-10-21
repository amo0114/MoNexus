import { businessRegistry } from './businessRegistry.js'

/** Absolute bound shared by configurable pagination and configuration writes. */
export const MAX_CONFIGURABLE_PAGE_SIZE = 500

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}

/** Pure normalization; endpoint-specific fixed limits remain explicit policies. */
export function normalizePagination(
  page: number | undefined,
  pageSize: number | undefined,
  policy: { defaultPageSize: number; maxPageSize: number },
) {
  const maxPageSize = Math.min(positiveInteger(policy.maxPageSize, MAX_CONFIGURABLE_PAGE_SIZE), MAX_CONFIGURABLE_PAGE_SIZE)
  return {
    page: positiveInteger(page, 1),
    pageSize: Math.min(positiveInteger(pageSize, positiveInteger(policy.defaultPageSize, businessRegistry.pagination.defaultPageSize)), maxPageSize),
  }
}
