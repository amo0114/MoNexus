/** Preserve the explicit checkout target through login/recharge navigation. */
export function productCheckoutReturn(productId: string | number, offerId?: number, xboardAccountLinkId?: string) {
  const query = new URLSearchParams()
  if (offerId) query.set('offerId', String(offerId))
  if (xboardAccountLinkId) query.set('xboardAccountLinkId', xboardAccountLinkId)
  return `/product/${productId}${query.size ? `?${query}` : ''}`
}
