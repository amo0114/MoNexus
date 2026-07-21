import { createHash } from 'node:crypto'
import { businessRegistry } from '../../lib/businessRegistry.js'
import {
  bumpCacheVersion,
  bumpProductListVersionCoalesced,
  getCacheVersion,
  makeCacheKey,
} from '../../lib/cache.js'

type ProductListCacheParams = {
  query?: string
  category?: string
  cursor?: string
  page?: number
  pageSize?: number
}

type ProductPublicInvalidationScope = {
  detail?: boolean
  reviews?: boolean
  list?: boolean | 'coalesced'
}

const productTypeValues = new Set<string>(businessRegistry.productTypes.map(type => type.value))

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hashParams(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('base64url').slice(0, 24)
}

function normalizeSearchQuery(query?: string) {
  const normalized = query?.trim().toLowerCase().normalize('NFKC')
  if (!normalized) return undefined
  return normalized
}

function normalizeCategory(category?: string) {
  const normalized = category?.trim()
  if (!normalized || normalized === '全部') return undefined
  return productTypeValues.has(normalized) ? normalized : normalized
}

function normalizeProductListParams(params: ProductListCacheParams) {
  const pageSize = Number(params.pageSize ?? 20)
  const query = normalizeSearchQuery(params.query)

  if (query && (query.length < 2 || query.length > 50)) {
    return null
  }

  const normalized: Record<string, unknown> = {
    status: 'active',
    orderBy: ['isHot:desc', 'sales:desc', 'id:desc'],
    pageSize,
  }

  if (query) normalized.q = query

  const category = normalizeCategory(params.category)
  if (category) normalized.category = category

  if (params.cursor) {
    normalized.cursor = params.cursor
  } else {
    normalized.page = Number(params.page ?? 1)
  }

  return normalized
}

export async function buildProductListCacheKey(params: ProductListCacheParams) {
  const normalized = normalizeProductListParams(params)
  if (!normalized) return null

  const version = await getCacheVersion({ name: 'product-list' })
  if (version == null) return null
  return makeCacheKey('product-list', version, hashParams(normalized))
}

export async function buildProductDetailCacheKey(productId: number) {
  const version = await getCacheVersion({ name: 'product-detail', productId })
  if (version == null) return null
  return makeCacheKey('product-detail', productId, version)
}

export async function buildProductReviewsCacheKey(productId: number, page: number, pageSize: number) {
  const version = await getCacheVersion({ name: 'product-reviews', productId })
  if (version == null) return null
  return makeCacheKey('product-reviews', productId, version, 'p', page, 's', pageSize)
}

export async function invalidateProductPublicCache(
  productId: number,
  scopes: ProductPublicInvalidationScope
) {
  const tasks: Array<Promise<void>> = []

  if (scopes.detail) {
    tasks.push(bumpCacheVersion({ name: 'product-detail', productId }))
  }
  if (scopes.reviews) {
    tasks.push(bumpCacheVersion({ name: 'product-reviews', productId }))
  }
  if (scopes.list === 'coalesced') {
    tasks.push(bumpProductListVersionCoalesced())
  } else if (scopes.list) {
    tasks.push(bumpCacheVersion({ name: 'product-list' }))
  }

  await Promise.all(tasks)
}
