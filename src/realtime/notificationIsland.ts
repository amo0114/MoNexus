import { markAsRead } from '../api/notifications'
import { getAuthSessionContext, matchesAuthSessionContext } from '../auth/sessionContext'
import { useAuthStore } from '../stores/authStore'
import { islandQueueNow, useAppStore } from '../stores/appStore'
import { broadcastReadInvalidation } from './readSyncBroadcast'
import type { RealtimeNotificationData } from './notificationInvalidation'

/** Called only for first, visible live events admitted by the existing matrix. */
export function showOrderNotificationIsland(n: RealtimeNotificationData, level: 'success' | 'info' | 'warning', navigate: (path: string) => void): boolean {
  const state = useAppStore.getState()
  const context = getAuthSessionContext(useAuthStore.getState())
  if (!context || level === 'warning' || !state.islandNoticeAvailable || !window.matchMedia('(max-width: 767px)').matches) return false
  const merchant = n.eventType.endsWith('_merchant')
  const orderId = n.relatedOrderId
  if (!orderId || !Number.isSafeInteger(orderId) || orderId <= 0) return false
  const newMerchantOrder = n.eventType === 'order.created_merchant'
  const groupKey = newMerchantOrder ? 'merchant:new-orders' : `${merchant ? 'merchant' : 'buyer'}:order:${orderId}`
  const existing = [state.islandNotice, ...state.islandQueue].find((item) => item?.groupKey === groupKey
    && (item === state.islandNotice || (item.expiresAt ?? 0) > islandQueueNow(state)))
  const orderIds: number[] = newMerchantOrder ? [...new Set<number>([...(existing?.payload?.orderIds ?? []), orderId])].slice(-100) : [orderId]
  const aggregate = orderIds.length > 1
  const isCurrent = () => matchesAuthSessionContext(context, getAuthSessionContext(useAuthStore.getState()))
  state.triggerIslandActivity({
    kind: 'notification',
    groupKey,
    type: level,
    title: aggregate ? `${orderIds.length} 笔新订单待处理` : n.title,
    subtitle: aggregate ? '前往订单管理查看并处理' : `订单 #${orderId}${n.body ? ` · ${n.body}` : ''}`,
    actionLabel: aggregate ? '查看待处理订单' : '查看订单',
    payload: { orderIds },
    onAction: () => {
      if (!isCurrent()) return
      // Construct only known app routes; a notification is never an external redirect.
      navigate(aggregate ? '/merchant/orders' : merchant ? `/merchant/orders/${orderId}` : `/orders?focus=${orderId}`)
      // Opening a summary does not read every unseen notification. Only the
      // single event explicitly opened is marked; dismissal/expiry is silent.
      if (!aggregate) void markAsRead(n.id).then(() => {
        if (!isCurrent()) return
        void useAppStore.getState().refreshNotificationUnread()
        broadcastReadInvalidation()
      }).catch(() => { /* Failed reads remain unread in the notification center. */ })
    },
  })
  return true
}
