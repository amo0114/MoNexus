/**
 * 买家订单「注意力」与列表分桶。
 * - active（进行中）：待处理 / 处理中 / 争议 —— 需要跟进，红点计数
 * - delivered（已交付）：已发货，可验收/关闭/续费
 * - done（已结束）：已关闭 / 已退款
 */

export type OrderListTab = 'all' | 'active' | 'delivered' | 'done'

const ACTIVE = new Set(['pending', 'processing', 'disputed'])
const DELIVERED = new Set(['delivered', 'completed'])
const DONE = new Set(['closed', 'refunded'])

export function normalizeBuyerOrderStatus(status: string | null | undefined): string {
  return (status ?? '').trim().toLowerCase()
}

/** 未完成且需关注 → 顶栏/Tab 红点 */
export function isAttentionOrderStatus(status: string | null | undefined): boolean {
  return ACTIVE.has(normalizeBuyerOrderStatus(status))
}

export function orderListTabOf(status: string | null | undefined): Exclude<OrderListTab, 'all'> {
  const s = normalizeBuyerOrderStatus(status)
  if (DELIVERED.has(s)) return 'delivered'
  if (DONE.has(s)) return 'done'
  return 'active'
}

export function filterOrdersByTab<T extends { status: string }>(
  orders: T[],
  tab: OrderListTab
): T[] {
  if (tab === 'all') return orders
  return orders.filter(o => orderListTabOf(o.status) === tab)
}

export function countAttentionOrders(orders: Array<{ status: string }>): number {
  return orders.reduce((n, o) => n + (isAttentionOrderStatus(o.status) ? 1 : 0), 0)
}

/** 角标文案：1–99 原样，≥100 → 99+ */
export function formatBadgeCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n > 99) return '99+'
  return String(Math.floor(n))
}

export const ORDER_LIST_TABS: Array<{ id: OrderListTab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中' },
  { id: 'delivered', label: '已交付' },
  { id: 'done', label: '已结束' },
]
