import { describe, expect, it } from 'vitest'
import {
  countAttentionOrders,
  filterOrdersByTab,
  formatBadgeCount,
  isAttentionOrderStatus,
  orderListTabOf,
} from './orderAttention'

describe('orderAttention', () => {
  it('classifies attention statuses', () => {
    expect(isAttentionOrderStatus('pending')).toBe(true)
    expect(isAttentionOrderStatus('processing')).toBe(true)
    expect(isAttentionOrderStatus('disputed')).toBe(true)
    expect(isAttentionOrderStatus('delivered')).toBe(false)
    expect(isAttentionOrderStatus('closed')).toBe(false)
  })

  it('buckets statuses for list tabs', () => {
    expect(orderListTabOf('pending')).toBe('active')
    expect(orderListTabOf('delivered')).toBe('delivered')
    expect(orderListTabOf('completed')).toBe('delivered')
    expect(orderListTabOf('refunded')).toBe('done')
  })

  it('filters and counts', () => {
    const orders = [
      { status: 'pending' },
      { status: 'processing' },
      { status: 'delivered' },
      { status: 'closed' },
    ]
    expect(countAttentionOrders(orders)).toBe(2)
    expect(filterOrdersByTab(orders, 'active')).toHaveLength(2)
    expect(filterOrdersByTab(orders, 'delivered')).toHaveLength(1)
    expect(filterOrdersByTab(orders, 'done')).toHaveLength(1)
  })

  it('formats badge 99+', () => {
    expect(formatBadgeCount(0)).toBe('')
    expect(formatBadgeCount(3)).toBe('3')
    expect(formatBadgeCount(99)).toBe('99')
    expect(formatBadgeCount(100)).toBe('99+')
  })
})
