/**
 * Who may buy with real points. A merchant buying its own goods fabricates
 * sales/reviews and turns its other points into settlement income; an
 * administrator account can grant points and sees operational data, so it
 * operates the platform rather than trading on it (test with a normal account).
 */
export function buyerRestrictionReason(
  buyer: { id: number; role: string },
  merchantUserId: number | null,
): string | null {
  if (buyer.role === 'admin') return '管理员账号不能下单，请使用普通用户账号'
  if (merchantUserId != null && merchantUserId === buyer.id) return '不能购买自己店铺的商品'
  return null
}
