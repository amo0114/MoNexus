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

export async function getUnreadCount(): Promise<number> {
  const { data } = await api.get<NotificationUnreadCountResponse>('/notifications/unread-count')
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
