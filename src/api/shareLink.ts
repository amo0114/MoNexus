import api from './client'

export type ProductShareLinkResponse = {
  productId: number
  url: string
  reused: boolean
}

/** POST /api/products/:id/share-link — body must stay `{}` (spec §6.5). */
export async function createProductShareLink(productId: number): Promise<ProductShareLinkResponse> {
  const { data } = await api.post<ProductShareLinkResponse>(`/products/${productId}/share-link`, {})
  return data
}
