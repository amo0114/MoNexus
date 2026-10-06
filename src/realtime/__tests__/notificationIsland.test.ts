import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { showOrderNotificationIsland } from '../notificationIsland'
import { handleRealtimeNotification } from '../../components/NotificationRealtimeBridge'
import { resetRealtimeRuntime } from '../runtime'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import type { RealtimeNotificationData } from '../notificationInvalidation'
import { markAsRead } from '../../api/notifications'

vi.mock('../../api/notifications', () => ({ markAsRead: vi.fn().mockResolvedValue({}), getUnreadCount: vi.fn().mockResolvedValue(0) }))
vi.mock('../readSyncBroadcast', () => ({ broadcastReadInvalidation: vi.fn() }))
const navigate = vi.fn()
const toast = vi.fn()
const event = (id: number, eventType = 'order.delivered_buyer'): RealtimeNotificationData => ({ id, relatedOrderId: id + 100, eventType, title: '订单已更新', body: '订单状态有更新', category: 'order', level: 'info', deeplink: 'https://invalid.example', createdAt: '2026-10-06T00:00:00Z' })
const receive = (n: RealtimeNotificationData) => handleRealtimeNotification(n, toast, (item, level) => showOrderNotificationIsland(item, level, navigate))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  resetRealtimeRuntime()
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({ matches: true, media }) as MediaQueryList)
  useAuthStore.setState({ user: { id: 1 } as never, accessToken: `e30.${btoa(JSON.stringify({ userId: 1, sid: 'test' }))}.sig`, isLoggedIn: true })
  useAppStore.setState({ islandNotice: null, islandQueue: [], islandNoticeAvailable: true, toasts: [] })
})
afterEach(() => { resetRealtimeRuntime(); vi.useRealTimers(); vi.restoreAllMocks() })

it('dedupes live events and opens the authoritative local order route; only clicks mark read', async () => {
  receive(event(1)); receive(event(1))
  expect(useAppStore.getState().islandQueue).toEqual([])
  expect(toast).not.toHaveBeenCalled()
  expect(markAsRead).not.toHaveBeenCalled()
  useAppStore.getState().islandNotice?.onAction?.()
  expect(navigate).toHaveBeenCalledWith('/orders?focus=101')
  expect(markAsRead).toHaveBeenCalledWith(1)
  await Promise.resolve()
})

it('combines merchant bursts with a real list destination without marking all events read', () => {
  receive(event(1, 'order.created_merchant')); receive(event(2, 'order.created_merchant'))
  expect(useAppStore.getState().islandNotice?.title).toBe('2 笔新订单待处理')
  expect(useAppStore.getState().islandQueue).toEqual([])
  useAppStore.getState().islandNotice?.onAction?.()
  expect(navigate).toHaveBeenCalledWith('/merchant/orders')
  expect(markAsRead).not.toHaveBeenCalled()
})

it('keeps a displayed merchant summary while focus pauses it beyond the queue deadline', () => {
  receive(event(1, 'order.created_merchant'))
  vi.advanceTimersByTime(30_001)
  receive(event(2, 'order.created_merchant'))
  expect(useAppStore.getState().islandNotice?.title).toBe('2 笔新订单待处理')
  expect(markAsRead).not.toHaveBeenCalled()
})

it('overflow, expiry and dismissal never mark unseen order notifications as read', () => {
  for (let i = 1; i < 12; i++) receive(event(i))
  expect(useAppStore.getState().islandQueue).toHaveLength(4)
  vi.advanceTimersByTime(30_001)
  useAppStore.getState().clearIslandNotice()
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(markAsRead).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
})

it('keeps instant delivery, unknown events and hidden-tab events silent; disputes stay warnings', () => {
  receive({ ...event(1), deliveryKind: 'instant' })
  receive(event(2, 'unknown'))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  receive(event(3))
  expect(useAppStore.getState().islandNotice).toBeNull()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  receive(event(4, 'order.disputed_buyer'))
  expect(toast).toHaveBeenCalledWith('订单已更新', 'warning')
  expect(useAppStore.getState().islandNotice).toBeNull()
})

it('does not execute stale session actions and falls back on desktop', () => {
  receive(event(1))
  const action = useAppStore.getState().islandNotice?.onAction
  useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 })
  action?.()
  expect(navigate).not.toHaveBeenCalled()
  expect(markAsRead).not.toHaveBeenCalled()
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({ matches: false, media }) as MediaQueryList)
  receive(event(2))
  expect(toast).toHaveBeenCalledWith('订单已更新', 'success')
})
