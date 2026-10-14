import api from './client'
import type { Product } from '../components/store/types'

/** Same public card shape as `/products` list items, plus the server-computed seller relation. */
export type RecommendedProduct = Product & { recommendation: { sameSeller: boolean } }

export interface ProductRecommendations {
  productId: number
  items: RecommendedProduct[]
}

export async function getProductRecommendations(
  productId: number,
  signal?: AbortSignal,
): Promise<ProductRecommendations> {
  const { data } = await api.get(`/products/${productId}/recommendations`, { signal })
  return data
}
