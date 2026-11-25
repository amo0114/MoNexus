import api from './client'
import type { ProductSummary } from '../types/product'
export { loadStoreCandidates } from './storeCandidates'

export interface StoreProductQuery {
  pageSize: number
  cursor?: string
  q?: string
  categoryCode?: string
  category?: string
  sort?: 'sales' | 'price_asc' | 'price_desc'
  inStock?: boolean
  instant?: boolean
  /** The server applies the caller's own balance; no points value is sent. */
  affordable?: boolean
}

interface ProductListResponse {
  items: ProductSummary[]
  nextCursor: string | null
  hasMore: boolean
}

export async function listStoreProducts(params: StoreProductQuery, signal?: AbortSignal): Promise<ProductListResponse> {
  const { data } = await api.get<ProductListResponse>('/products', { params, signal })
  return data
}
