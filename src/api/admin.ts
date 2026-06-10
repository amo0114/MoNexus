import api from './client'

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
  user?: { id: number; email: string } | null
  merchant?: { id: number; name: string } | null
  product?: { name: string } | null
  delivery?: { status: string } | null
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
