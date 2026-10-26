import api from './client'
import type { ProductSummary } from '../types/product'
export { loadStoreCandidates } from './storeCandidates'

export interface StoreProductQuery {
  pageSize: number
  cursor?: string
  q?: string
  categoryCode?: string
  category?: string
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
