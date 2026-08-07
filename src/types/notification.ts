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
