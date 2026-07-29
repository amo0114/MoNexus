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

/** FakaBridge Xboard capacity (admin MFA only). */
export interface AdminFakaCapacity {
  sku: string
  planId: number | null
  capacityLimit: number | null
  activeUsers: number | null
  remaining: number | null
  sellable: boolean
  source: 'xboard' | 'unavailable'
  reason?: string
}

export async function deleteAdminProduct(
  productId: number,
): Promise<{ mode: 'hard' | 'soft'; productId: number; orderCount: number; status?: string }> {
  const { data } = await api.delete(`/admin/products/${productId}`)
  return data
}

export async function setAdminFakaCapacity(
  productId: number,
  payload: { offerId?: number; capacityLimit: number | null },
): Promise<AdminFakaCapacity> {
  const { data } = await api.put<AdminFakaCapacity>(
    `/admin/products/${productId}/faka-capacity`,
    payload,
  )
  return data
}

export interface AdminFakaCatalogPlan {
  plan_id: number
  name: string
  show: boolean
  sell: boolean
  capacity_limit: number | null
  active_users: number
  remaining: number | null
  periods: Array<{ period: string; price: number; sku_alias: string }>
  named_skus: Array<{ sku: string; period: string }>
}

export async function getAdminFakaCatalog(): Promise<{ plans: AdminFakaCatalogPlan[] }> {
  const { data } = await api.get<{ plans: AdminFakaCatalogPlan[] }>('/admin/faka/catalog')
  return data
}

export type AdminFakaImportOffer = {
  period: string
  sku?: string
  offerName?: string
  pricePoints: number
  validityDays?: number | null
}

/** 一商品多规格导入（推荐传 offers）；兼容单 period+pricePoints */
export async function importAdminFakaPlan(payload: {
  planId: number
  productName?: string
  type?: string
  offers?: AdminFakaImportOffer[]
  period?: string
  sku?: string
  offerName?: string
  pricePoints?: number
}): Promise<{
  productId: number
  offerCount: number
  offers: Array<{ period: string; sku: string; offerName: string; pricePoints: number }>
  fakaCapacity: AdminFakaCapacity
}> {
  const { data } = await api.post('/admin/faka/import', payload)
  return data
}

/** 给已有 Faka 商品追加周期规格 */
export async function addAdminFakaOffers(
  productId: number,
  payload: { offers: AdminFakaImportOffer[] },
): Promise<{ productId: number; added: AdminFakaImportOffer[] }> {
  const { data } = await api.post(`/admin/products/${productId}/faka-offers`, payload)
  return data
}

export interface AdminFakaTask {
  id: number
  orderId: number
  status: string
  attempts: number
  maxAttempts: number
  lastError: string | null
  xboardTradeNo: string | null
  requestOrderNo: string
  emailSnapshot: string
  skuSnapshot: string
  periodSnapshot: string
  revokeStatus: string | null
  revokeAttempts: number
  revokedAt: string | null
  lastRevokeError: string | null
  reconcileNote: string | null
  createdAt: string
  completedAt: string | null
  nextAttemptAt: string
  order: {
    id: number
    status: string
    price: number
    productNameSnapshot: string | null
    user: { id: number; email: string }
  }
}

export async function getAdminFakaTaskStats(): Promise<{
  byStatus: Record<string, number>
  byRevoke: Record<string, number>
  configured: boolean
}> {
  const { data } = await api.get('/admin/faka/tasks/stats')
  return data
}

export async function listAdminFakaTasks(params?: {
  status?: string
  revokeStatus?: string
  page?: number
  pageSize?: number
}): Promise<{ items: AdminFakaTask[]; total: number; page: number; pageSize: number }> {
  const { data } = await api.get('/admin/faka/tasks', { params })
  return data
}

export async function retryAdminFakaTask(taskId: number): Promise<{ ok: boolean; taskId: number }> {
  const { data } = await api.post(`/admin/faka/tasks/${taskId}/retry`)
  return data
}

export async function revokeAdminFakaTask(
  taskId: number,
): Promise<{ ok: boolean; taskId: number; outcome: string }> {
  const { data } = await api.post(`/admin/faka/tasks/${taskId}/revoke`)
  return data
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
