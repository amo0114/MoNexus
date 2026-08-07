import api from './client'
import type {
  ListNotificationsParams,
  MarkAllNotificationsReadResponse,
  MarkNotificationReadResponse,
  NotificationListResponse,
  NotificationUnreadCountResponse,
} from '../types/notification'

export async function getNotifications(
  params: ListNotificationsParams = {},
): Promise<NotificationListResponse> {
  const { data } = await api.get<NotificationListResponse>('/notifications', { params })
  return {
    notifications: Array.isArray(data?.notifications) ? data.notifications : [],
    nextCursor: data?.nextCursor ?? null,
    hasMore: Boolean(data?.hasMore),
  }
}

/**
 * Badge polling must never log the user out.
 * UI-only E2E fixtures use unsigned tokens; a 401 here would otherwise hit the
 * shared refresh path and terminal-logout the session (m3/gallery mocks).
 * Real expired sessions still refresh when the user hits a full API surface.
 */
export async function getUnreadCount(): Promise<number> {
  const { data } = await api.get<NotificationUnreadCountResponse>('/notifications/unread-count', {
    skipAuthRefresh: true,
  })
  return typeof data?.count === 'number' ? data.count : 0
}

export async function markAsRead(id: number): Promise<MarkNotificationReadResponse> {
  const { data } = await api.post<MarkNotificationReadResponse>(`/notifications/${id}/read`)
  return data
}

export async function markAllAsRead(): Promise<MarkAllNotificationsReadResponse> {
  const { data } = await api.post<MarkAllNotificationsReadResponse>('/notifications/read-all')
  return data
}
