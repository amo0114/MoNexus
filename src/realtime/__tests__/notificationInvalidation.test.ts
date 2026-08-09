import { describe, expect, it } from 'vitest'
import {
  ExactIdLru,
  InvalidationScheduler,
  EXACT_ID_LRU_CAPACITY,
  resolveInvalidation,
  type RealtimeNotificationData,
} from '../notificationInvalidation.js'

describe('ExactIdLru (SPEC-NOTIFY-RT-001 / CHK-FE-005~006)', () => {
  it('records and dedupes by exact id (never maxSeen)', () => {
    const lru = new ExactIdLru()
    expect(lru.has(100)).toBe(false)
    lru.record(100)
    expect(lru.has(100)).toBe(true)
    // 101 arriving after 100 is NOT dropped (out-of-order preserved).
    lru.record(101)
    expect(lru.has(101)).toBe(true)
    expect(lru.has(100)).toBe(true)
  })

  it('caps capacity at 512 and evicts the least recently used', () => {
    const lru = new ExactIdLru()
    for (let i = 1; i <= EXACT_ID_LRU_CAPACITY + 1; i += 1) lru.record(i)
    expect(lru.size).toBe(EXACT_ID_LRU_CAPACITY)
    // 1 was evicted after the 513th insert; a very late repeat may fire a live hint.
    expect(lru.has(1)).toBe(false)
    expect(lru.has(EXACT_ID_LRU_CAPACITY + 1)).toBe(true)
  })

  it('refreshes recency on re-record', () => {
    const lru = new ExactIdLru(3)
    lru.record(1)
    lru.record(2)
    lru.record(3)
    lru.record(1) // refresh 1
    lru.record(4) // evicts 2
    expect(lru.has(1)).toBe(true)
    expect(lru.has(2)).toBe(false)
  })

  it('clears on logout / user change', () => {
    const lru = new ExactIdLru()
    lru.record(1)
    lru.record(2)
    lru.clear()
    expect(lru.size).toBe(0)
    expect(lru.has(1)).toBe(false)
  })
})

describe('event matrix + toast rules (SPEC-NOTIFY-RT-001 / CHK-FE-011~012)', () => {
  function n(eventType: string, extra: Partial<RealtimeNotificationData> = {}): RealtimeNotificationData {
    return { id: 1, eventType, category: 'order', title: 't', body: 'b', level: 'info', deeplink: '/', relatedOrderId: 1, createdAt: new Date().toISOString(), ...extra }
  }

  it('maps the 10 known eventTypes to their matrix topics (CHK-FE-012)', () => {
    expect(resolveInvalidation(n('order.created_merchant')).topics).toEqual(['notifications', 'merchant.orders', 'merchant.stats'])
    expect(resolveInvalidation(n('order.processing_buyer')).topics).toEqual(['notifications', 'buyer.orders'])
    expect(resolveInvalidation(n('order.delivered_buyer')).topics).toEqual(['notifications', 'buyer.orders'])
    expect(resolveInvalidation(n('order.refunded_merchant')).topics).toEqual(['notifications', 'merchant.orders', 'merchant.stats'])
    expect(resolveInvalidation(n('order.disputed_buyer')).toast).toEqual({ level: 'warning' })
    expect(resolveInvalidation(n('order.dispute_resolved_merchant')).topics).toEqual(['notifications', 'merchant.orders', 'merchant.stats'])
    expect(resolveInvalidation(n('order.closed_buyer')).toast).toEqual({ level: 'info' })
  })

  it('unknown events only invalidate notifications and never toast (NRT-022)', () => {
    const r = resolveInvalidation(n('order.some_future_event'))
    expect(r.topics).toEqual(['notifications'])
    expect(r.toast.level).toBeNull()
  })

  it('instant delivered is silent but still syncs buyer state (CHK-FE-012)', () => {
    const r = resolveInvalidation(n('order.delivered_buyer', { deliveryKind: 'instant' }))
    expect(r.topics).toEqual(['notifications', 'buyer.orders'])
    expect(r.toast.level).toBeNull()
  })

  it('manual delivered toasts as success', () => {
    const r = resolveInvalidation(n('order.delivered_buyer', { deliveryKind: 'manual' }))
    expect(r.toast.level).toBe('success')
  })
})

describe('InvalidationScheduler (SPEC-NOTIFY-RT-001 / CHK-FE-007)', () => {
  it('coalesces multiple invalidations within 300ms into one publish', async () => {
    const scheduler = new InvalidationScheduler()
    let calls = 0
    scheduler.subscribe('notifications', () => {
      calls += 1
    })
    scheduler.invalidate('notifications')
    scheduler.invalidate('notifications')
    scheduler.invalidate('notifications')
    await new Promise(r => setTimeout(r, 400))
    expect(calls).toBe(1)
  })

  it('separate topics coalesce independently', async () => {
    const scheduler = new InvalidationScheduler()
    let a = 0
    let b = 0
    scheduler.subscribe('notifications', () => {
      a += 1
    })
    scheduler.subscribe('buyer.orders', () => {
      b += 1
    })
    scheduler.invalidate('notifications')
    scheduler.invalidate('buyer.orders')
    await new Promise(r => setTimeout(r, 400))
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('publishNow fires immediately (ready / fallback / visible)', () => {
    const scheduler = new InvalidationScheduler()
    let calls = 0
    scheduler.subscribe('all.visible', () => {
      calls += 1
    })
    scheduler.publishNow('all.visible')
    expect(calls).toBe(1)
  })

  it('clearAll drops pending timers', async () => {
    const scheduler = new InvalidationScheduler()
    let calls = 0
    scheduler.subscribe('notifications', () => {
      calls += 1
    })
    scheduler.invalidate('notifications')
    scheduler.clearAll()
    await new Promise(r => setTimeout(r, 400))
    expect(calls).toBe(0)
    expect(scheduler.pendingTimers).toBe(0)
  })

  it('unsubscribe stops future calls', async () => {
    const scheduler = new InvalidationScheduler()
    let calls = 0
    const off = scheduler.subscribe('notifications', () => {
      calls += 1
    })
    off()
    scheduler.invalidate('notifications')
    await new Promise(r => setTimeout(r, 400))
    expect(calls).toBe(0)
  })
})
