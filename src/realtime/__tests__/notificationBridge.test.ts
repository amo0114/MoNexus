import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRealtimeNotification } from '../../components/NotificationRealtimeBridge.js'
import { getInvalidationScheduler, resetRealtimeRuntime } from '../runtime.js'
import type { RealtimeNotificationData } from '../notificationInvalidation.js'

function notification(id: number): RealtimeNotificationData {
  return {
    id,
    eventType: 'order.created_merchant',
    category: 'order',
    title: '新单',
    body: '已创建',
    level: 'info',
    deeplink: `/merchant/orders/${id}`,
    relatedOrderId: id,
    createdAt: '2026-08-09T00:00:00.000Z',
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetRealtimeRuntime()
})

afterEach(() => {
  resetRealtimeRuntime()
  vi.useRealTimers()
})

describe('NotificationRealtimeBridge exact-ID boundary', () => {
  it('publishes invalidation topics only for the first exact ID', async () => {
    const scheduler = getInvalidationScheduler()
    const calls = {
      notifications: 0,
      orders: 0,
      stats: 0,
    }
    const off = [
      scheduler.subscribe('notifications', () => { calls.notifications += 1 }),
      scheduler.subscribe('merchant.orders', () => { calls.orders += 1 }),
      scheduler.subscribe('merchant.stats', () => { calls.stats += 1 }),
    ]
    const showToast = vi.fn()

    handleRealtimeNotification(notification(42), showToast)
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toEqual({ notifications: 1, orders: 1, stats: 1 })

    handleRealtimeNotification(notification(42), showToast)
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toEqual({ notifications: 1, orders: 1, stats: 1 })

    off.forEach((unsubscribe) => unsubscribe())
  })
})
