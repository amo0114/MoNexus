import api from './client'
import type { ProductSummary } from '../types/product'
import type { SponsoredShelfItem, EditorialPlacement } from '../types/merchandising'

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

interface PublicEditorialItem {
  productId: number
  placement: EditorialPlacement
  publicReason: string | null
  label: '平台精选'
}

export async function listStoreProducts(params: StoreProductQuery): Promise<ProductListResponse> {
  const { data } = await api.get<ProductListResponse>('/products', { params })
  return data
}

export async function loadStoreCandidates(categoryCode?: string, signal?: AbortSignal) {
  const [sponsoredResult, editorialResult] = await Promise.allSettled([
    api.get<{ items: SponsoredShelfItem[] }>('/products/sponsored', {
      signal,
      params: {
        placement: categoryCode ? 'category_sponsored' : 'store_home_sponsored',
        ...(categoryCode ? { categoryCode } : {}),
        limit: 6,
      },
    }),
    api.get<{ items: PublicEditorialItem[] }>('/products/editorial', {
      signal,
      params: {
        placement: categoryCode ? 'category_editorial' : 'store_editorial',
        limit: 6,
      },
    }),
  ])
  const sponsoredItems = sponsoredResult.status === 'fulfilled' ? sponsoredResult.value.data.items : []
  const editorialItems = editorialResult.status === 'fulfilled' ? editorialResult.value.data.items : []
  const ids = [...new Set([...sponsoredItems, ...editorialItems].map(item => item.productId))]
  const response = ids.length
    ? await api.get<{ items: ProductSummary[] }>('/products/summaries', { params: { ids: ids.join(',') }, signal }).catch(() => null)
    : null
  const byId = new Map((response?.data.items ?? []).map(product => [product.id, product]))

  return {
    sponsored: sponsoredItems.map(item => ({
      productId: item.productId,
      product: byId.get(item.productId) ?? null,
    })),
    editorial: editorialItems.map(item => {
      const product = byId.get(item.productId)
      return {
        productId: item.productId,
        product: product && (!categoryCode || product.category?.code === categoryCode) ? product : null,
        publicReason: item.publicReason,
      }
    }),
  }
}
