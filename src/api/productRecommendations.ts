import api from './client'
import type { ProductSummary as Product } from '../types/product'

/** Same public card shape as `/products` list items, plus the server-computed seller relation. */
export type RecommendedProduct = Product & { recommendation: { sameSeller: boolean } }

export interface ProductRecommendations {
  productId: number
  tracking?: { listToken: string }
  items: RecommendedProduct[]
}

export async function getProductRecommendations(
  productId: number,
  signal?: AbortSignal,
): Promise<ProductRecommendations> {
  const { data } = await api.get<ProductRecommendations>(`/products/${productId}/recommendations`, { signal })
  return data
}
