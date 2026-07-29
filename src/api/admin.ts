import api from './client'
import {
  AdminAnnouncement,
  AdminAnnouncementListQuery,
  CreateAnnouncementRequest,
  UpdateAnnouncementRequest,
} from '../types/admin'

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface AdminUserItem {
  id: number
  email: string
  role: string
  status: string
  inviteCode: string | null
  createdAt: string
  pointAccount: { balance: number } | null
}

export interface AdminUserListQuery {
  q?: string
  page?: number
  pageSize?: number
}

export interface AdminOrderItem {
  id: number
  status: string
  price: number
  createdAt: string
  // P6c：预约日期（本地零点时刻的 ISO 串）
  bookingDate?: string | null
  // P6a：续费单指向的原订单号
  renewalOfOrderId?: number | null
  user?: { id: number; email: string } | null
  merchant?: { id: number; name: string } | null
  product?: { name: string } | null
  // P6a：expired 以服务端裁决为准，前端不自行比对时钟
  delivery?: { status: string; expiresAt?: string | null; expired?: boolean } | null
  // P7b：自动开通任务的安全投影（脱敏诊断码）；null = 非自动开通单。
  provisionTask?: import('../types/merchant').ProvisionTaskSummary | null
}

export interface AdminOrderListQuery {
  status?: string
  q?: string
  page?: number
  pageSize?: number
}

export async function getAdminUsers(
  params?: AdminUserListQuery,
): Promise<PaginatedResult<AdminUserItem>> {
  const { data } = await api.get<PaginatedResult<AdminUserItem>>('/admin/users', { params })
  return data
}

export async function getAdminOrders(
  params?: AdminOrderListQuery,
): Promise<PaginatedResult<AdminOrderItem>> {
  const { data } = await api.get<PaginatedResult<AdminOrderItem>>('/admin/orders', { params })
  return data
}

export async function resolveAdminOrder(
  id: number,
  payload: { result: 'refund' | 'close'; note?: string },
): Promise<unknown> {
  const { data } = await api.post(`/admin/orders/${id}/resolve`, payload)
  return data
}

export async function adjustUserPoints(
  userId: number,
  payload: { type: 'add' | 'deduct'; amount: number; reason: string },
): Promise<void> {
  await api.post(`/admin/users/${userId}/adjust`, payload)
}

export async function banUser(userId: number, reason: string): Promise<void> {
  await api.put(`/admin/users/${userId}/ban`, { reason })
}

export async function unbanUser(userId: number): Promise<void> {
  await api.put(`/admin/users/${userId}/unban`)
}

export async function getAnnouncements(
  params?: AdminAnnouncementListQuery,
): Promise<PaginatedResult<AdminAnnouncement>> {
  const { data } = await api.get<PaginatedResult<AdminAnnouncement>>(
    '/admin/announcements',
    { params },
  )
  return data
}

export async function createAnnouncement(
  payload: CreateAnnouncementRequest,
): Promise<AdminAnnouncement> {
  const { data } = await api.post<AdminAnnouncement>('/admin/announcements', payload)
  return data
}

export async function updateAnnouncement(
  id: number,
  payload: UpdateAnnouncementRequest,
): Promise<AdminAnnouncement> {
  const { data } = await api.put<AdminAnnouncement>(`/admin/announcements/${id}`, payload)
  return data
}

export async function deleteAnnouncement(id: number): Promise<void> {
  await api.delete(`/admin/announcements/${id}`)
}
