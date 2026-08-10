export type NotificationStatus = 'unread' | 'read' | 'archived'
export type NotificationCategory = 'order' | 'provision' | 'booking' | 'inventory' | 'system'
export type NotificationLevel = 'info' | 'success' | 'warning' | 'critical'

export interface Notification {
  id: number
  eventType: string
  category: NotificationCategory | string
  title: string
  body: string
  level: NotificationLevel | string
  status: NotificationStatus | string
  deeplink: string
  relatedOrderId: number | null
  readAt: string | null
  createdAt: string
  payload?: Record<string, unknown> | null
}

export interface NotificationListResponse {
  notifications: Notification[]
  nextCursor: number | null
  hasMore: boolean
}

export interface NotificationUnreadCountResponse {
  count: number
}

export interface MarkNotificationReadResponse {
  id: number
  status: string
  readAt: string | null
}

export interface MarkAllNotificationsReadResponse {
  updated: number
}

export interface ListNotificationsParams {
  cursor?: number
  limit?: number
  status?: NotificationStatus
  category?: NotificationCategory
}

// ===========================================================================
// SPEC-NOTIFY-RT-001 realtime SSE types (T-FE-001 — additions only).
// ===========================================================================

/** Safe SSE `notification.created` envelope (server allowlist, spec 6.5). */
export interface RealtimeNotificationPayload {
  v: 1
  notification: {
    id: number
    eventType: string
    category: string
    title: string
    body: string
    level: string
    deeplink: string
    relatedOrderId: number | null
    createdAt: string
    deliveryMode?: string
    deliveryKind?: string
  }
}

export interface RealtimeReadyPayload {
  v: 1
  serverTime: string
  heartbeatMs: number
  resyncRequired: boolean
}

export interface RealtimeAuthExpiringPayload {
  v: 1
  expiresAt: string
}

export interface RealtimeDegradedPayload {
  v: 1
  reason: 'listener_unavailable' | 'server_shutdown' | 'slow_consumer'
  retryAfterMs: number
}
