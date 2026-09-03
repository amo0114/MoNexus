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
  fromDate?: string
  toDate?: string
}

export interface AdminOrderDetail extends AdminOrderItem {
  updatedAt?: string
  holdingPoints?: number
  fulfillmentDeadline?: string | null
  deliveryModeSnapshot?: string | null
  delivery?: {
    id?: number
    content?: string | null
    status: string
    expiresAt?: string | null
    expired?: boolean
    deliveredAt?: string | null
  } | null
  product?: {
    id: number
    name: string
    icon?: string | null
    type?: string | null
    imageUrl?: string | null
    price?: number
    deliveryMode?: string | null
  } | null
  purchaseFormSnapshot?: Array<{
    id: string
    label: string
    type: string
    required?: boolean
  }> | null
  purchaseFormAnswers?: Record<string, unknown> | null
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

export async function getAdminOrderDetail(id: number): Promise<AdminOrderDetail> {
  const { data } = await api.get<AdminOrderDetail>(`/admin/orders/${id}`)
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

export type AdminPlatformProductCreateRequest = {
  name: string
  categoryId: number
  description?: string
  richDescription?: string
  icon?: string
  imageUrl?: string
  images?: string[]
  price: number
  originalPrice?: number
  deliveryMode: 'instant_inventory' | 'instant_fixed' | 'manual_service'
  stockMode: 'limited' | 'unlimited'
  fixedContent?: string
  fixedContentType?: 'text' | 'url'
}

export type AdminPlatformProduct = {
  id: number
  merchantId: null
  name: string
  categoryId: number
  type: string
  status: 'draft'
  publishedAt: null
}

/** Admin-authored platform products are always server-owned drafts (merchantId=null). */
export async function createAdminPlatformProduct(
  payload: AdminPlatformProductCreateRequest,
): Promise<AdminPlatformProduct> {
  const { data } = await api.post<AdminPlatformProduct>('/admin/products', payload)
  return data
}

export type AdminInventoryPreview = {
  totalRows: number
  validRows: number
  emptyRows: number
  duplicateRows: number
  existingDuplicateRows: number
  canImport: boolean
  rowErrors?: Array<{ row: number; message: string }>
}

export async function previewAdminOfferInventory(
  productId: number,
  offerId: number,
  payload: { text: string },
): Promise<AdminInventoryPreview> {
  const { data } = await api.post<AdminInventoryPreview>(
    `/admin/products/${productId}/offers/${offerId}/inventory/preview`,
    payload,
  )
  return data
}

export async function importAdminOfferInventory(
  productId: number,
  offerId: number,
  payload: { items: string[] },
): Promise<{ imported: number }> {
  const { data } = await api.post<{ imported: number }>(
    `/admin/products/${productId}/offers/${offerId}/inventory`,
    payload,
  )
  return data
}

export async function deleteAdminProduct(
  productId: number,
): Promise<{ mode: 'archived'; productId: number; status?: string; archivedAt?: string }> {
  const { data } = await api.delete(`/admin/products/${productId}`)
  return data
}

export type AdminProductUpdateRequest = {
  name?: string
  description?: string
  richDescription?: string
  categoryId?: number
  imageUrl?: string | null
  images?: string[]
  purchaseForm?: unknown
  price?: number
  originalPrice?: number | null
}

export async function updateAdminProduct(
  productId: number,
  payload: AdminProductUpdateRequest,
): Promise<{ id: number; name: string; status: string }> {
  const { data } = await api.put(`/admin/products/${productId}`, payload)
  return data
}

export async function archiveAdminProduct(
  productId: number,
  payload?: { reason?: string },
): Promise<{ mode: 'archived'; productId: number; status: string; archivedAt: string; idempotent?: boolean }> {
  const { data } = await api.post(`/admin/products/${productId}/archive`, payload ?? {})
  return data
}

export async function restoreAdminProduct(
  productId: number,
): Promise<{ productId: number; status: string; archivedAt: null; idempotent?: boolean }> {
  const { data } = await api.post(`/admin/products/${productId}/restore`)
  return data
}

export type AdminOfferPatchRequest = {
  name?: string
  price?: number
  originalPrice?: number | null
  validityDays?: number | null
  sortOrder?: number
}

export async function patchAdminOffer(
  productId: number,
  offerId: number,
  payload: AdminOfferPatchRequest,
) {
  const { data } = await api.patch(`/admin/products/${productId}/offers/${offerId}`, payload)
  return data
}

export async function archiveAdminOffer(productId: number, offerId: number) {
  const { data } = await api.post(`/admin/products/${productId}/offers/${offerId}/archive`)
  return data
}

export async function restoreAdminOffer(productId: number, offerId: number) {
  const { data } = await api.post(`/admin/products/${productId}/offers/${offerId}/restore`)
  return data
}

export async function makeDefaultAdminOffer(productId: number, offerId: number) {
  const { data } = await api.post(`/admin/products/${productId}/offers/${offerId}/make-default`)
  return data
}

export type AdminFakaSyncPreview = {
  productId: number
  productName: string
  archived: boolean
  productStatus: string
  sourceHash: string
  currentSourceHash: string
  sourceChanged: boolean
  plan: {
    showSell: boolean
    capacity: { limit: number | null; activeUsers: number; remaining: number | null; sellable: boolean }
    name: string
    plainDescription: string
    localDescription: string | null
  }
  added: Array<{ period: string; sku: string; remotePriceHint: number; suggestedName: string; suggestedValidityDays: number | null }>
  removed: Array<{ offerId: number; name: string; sku: string | null; period: string | null; status: string; price: number }>
  skuChanged: Array<{ offerId: number; period: string; from: string | null; to: string }>
  kept: Array<{ offerId: number; period: string; name: string; status: string; localPricePoints: number; remotePriceHint: number; sku: string | null }>
  suggestedActions: Array<'add_missing' | 'archive_removed' | 'keep_local' | 'restore_product' | 'update_sku' | 'apply_price'>
  ownership: { xboard: string[]; monexus: string[] }
}

export type AdminFakaSyncAction = {
  type: 'add_missing' | 'archive_removed' | 'keep_local' | 'restore_product' | 'update_sku' | 'apply_price'
  period?: string
  offerId?: number
  sku?: string
  pricePoints?: number
  offerName?: string
  validityDays?: number | null
}

export async function previewAdminFakaSync(productId: number): Promise<AdminFakaSyncPreview> {
  const { data } = await api.post<AdminFakaSyncPreview>(`/admin/products/${productId}/faka-sync/preview`)
  return data
}

export async function confirmAdminFakaSync(
  productId: number,
  payload: { sourceHash: string; actions?: AdminFakaSyncAction[] },
  idempotencyKey: string,
): Promise<{ productId: number; replayed: boolean; sourceHash: string }> {
  const { data } = await api.post(`/admin/products/${productId}/faka-sync`, payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  })
  return data
}

export type AdminProductStatus = 'draft' | 'active' | 'inactive'

export interface AdminProductOffer {
  id: number
  name: string
  deliveryMode?: string
  status?: string
  isDefault?: boolean
  deliveryFields?: unknown[] | null
  externalIntegration?: string | null
  externalSku?: string | null
  stockMode?: string
  stock?: number | null
  price?: number
  originalPrice?: number | null
  validityDays?: number | null
  sortOrder?: number
  fakaCapacity?: AdminFakaCapacity | null
}

export interface AdminProductListItem {
  id: number
  name: string
  status: string
  merchantId: number | null
  type?: string
  categoryId?: number
  price?: number
  originalPrice?: number | null
  description?: string | null
  richDescription?: string | null
  purchaseForm?: unknown
  deliveryMode?: string
  stockMode?: string
  stock?: number | null
  imageUrl?: string | null
  images?: string[]
  archivedAt?: string | null
  archiveReason?: string | null
  fakaBridge?: boolean
  fakaCapacity?: AdminFakaCapacity | null
  offers: AdminProductOffer[]
  _count?: { inventory?: number }
}

export interface AdminProductReadiness {
  ready: boolean
  productId: number
  issues: Array<{
    code: string
    field: string
    offerId: number | null
  }>
}

export interface AdminProductStatusResult {
  id: number
  status: AdminProductStatus
  publishedAt: string | null
}

export async function getAdminProducts(
  params?: { archived?: 'exclude' | 'only' | 'all' },
): Promise<AdminProductListItem[]> {
  const { data } = params
    ? await api.get<AdminProductListItem[]>('/admin/products', { params })
    : await api.get<AdminProductListItem[]>('/admin/products')
  return data
}

export async function getAdminProductReadiness(
  productId: number,
): Promise<AdminProductReadiness> {
  const { data } = await api.get<AdminProductReadiness>(
    `/admin/products/${productId}/readiness`,
  )
  return data
}

export async function publishAdminProduct(
  productId: number,
): Promise<AdminProductStatusResult> {
  const { data } = await api.post<AdminProductStatusResult>(
    `/admin/products/${productId}/publish`,
  )
  return data
}

export async function unpublishAdminProduct(
  productId: number,
): Promise<AdminProductStatusResult> {
  const { data } = await api.post<AdminProductStatusResult>(
    `/admin/products/${productId}/unpublish`,
  )
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

export type AdminFakaCoverChoice =
  | { mode: 'uploaded'; objectKey: string }
  | { mode: 'category_default' }

export type AdminFakaImportRequest = {
  planId: number
  productName?: string
  categoryId: number
  cover: AdminFakaCoverChoice
  offers: AdminFakaImportOffer[]
}

export type AdminFakaImportPreview = {
  sourceHash: string
  capacity: {
    limit: number | null
    activeUsers: number
    remaining: number | null
    sellable: boolean
  }
  productName: string
  plainDescription: string
  richDescription: string | null
  cover: { imageUrl: string; images: string[] } | null
  offers: Array<{
    period: string
    sku: string
    offerName: string
    pricePoints: number
    validityDays: number | null
  }>
  issues: Array<{ code: string; field: string; message: string; action?: string }>
  canConfirm: boolean
  existingProductId?: number | null
  archived?: boolean
  suggestedActions?: string[]
}

export async function previewAdminFakaPlan(
  payload: AdminFakaImportRequest,
): Promise<AdminFakaImportPreview> {
  const { data } = await api.post<AdminFakaImportPreview>('/admin/faka/import/preview', payload)
  return data
}

/** Confirm repeats the preview request and binds it to sourceHash + Idempotency-Key. */
export async function importAdminFakaPlan(
  payload: AdminFakaImportRequest & { sourceHash: string },
  idempotencyKey: string,
): Promise<{
  productId: number
  offerCount?: number
  offers?: Array<{ period: string; sku: string; offerName: string; pricePoints: number }>
  replayed: boolean
}> {
  const { data } = await api.post('/admin/faka/import', payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  })
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
