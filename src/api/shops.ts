import api from './client'
import type { Product } from '../components/store/types'

export interface ShopProfile {
  id: number
  name: string
  description: string | null
}

export interface ShopProductsPage {
  shop: ShopProfile
  items: Product[]
  nextCursor: string | null
  hasMore: boolean
}

export async function getShopProducts(
  merchantId: number,
  params: { q?: string; cursor?: string },
  signal?: AbortSignal,
): Promise<ShopProductsPage> {
  const { data } = await api.get(`/shops/${merchantId}/products`, {
    params: {
      ...(params.q ? { q: params.q } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    },
    signal,
  })
  return data
}
