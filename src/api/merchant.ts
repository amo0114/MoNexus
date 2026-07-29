import api from './client'
import {
  Merchant,
  ApplyMerchantRequest,
  UpdateMerchantRequest,
  MerchantStats,
  MerchantProduct,
  CreateMerchantProductRequest,
  UpdateMerchantProductRequest,
  ImportInventoryRequest,
  MerchantOrder,
  Offer,
  OfferWriteRequest,
  Settlement,
  ListEnvelope,
  MerchantWebhookConfig
} from '../types/merchant'

export async function applyMerchant(payload: ApplyMerchantRequest): Promise<Merchant> {
  const { data } = await api.post<Merchant>('/merchant/register', payload)
  return data
}

export async function getMerchantMe(): Promise<Merchant> {
  const { data } = await api.get<Merchant>('/merchant/me')
  return data
}

export async function updateMerchantMe(payload: UpdateMerchantRequest): Promise<Merchant> {
  const { data } = await api.put<Merchant>('/merchant/me', payload)
  return data
}

export async function getMerchantStats(): Promise<MerchantStats> {
  const { data } = await api.get<MerchantStats>('/merchant/stats')
  return data
}

export interface MerchantProductListParams {
  page?: number
  pageSize?: number
  status?: string
  q?: string
  type?: string
  deliveryMode?: string
  lowStock?: boolean
}

export interface InventoryLog {
  id: number
  productId: number
  merchantId: number | null
  actorUserId: number
  action: 'import' | 'void' | 'sale' | 'capacity_adjust'
  delta: number
  reason: string | null
  orderId: number | null
  batchId: string | null
  createdAt: string
}

export async function getMerchantProducts(params?: MerchantProductListParams): Promise<ListEnvelope<MerchantProduct>> {
  const { data } = await api.get<ListEnvelope<MerchantProduct>>('/merchant/products', { params })
  return data
}

export async function createMerchantProduct(payload: CreateMerchantProductRequest): Promise<MerchantProduct> {
  const { data } = await api.post<MerchantProduct>('/merchant/products', payload)
  return data
}

export async function updateMerchantProduct(id: number, payload: UpdateMerchantProductRequest): Promise<MerchantProduct> {
  const { data } = await api.put<MerchantProduct>(`/merchant/products/${id}`, payload)
  return data
}

export async function voidMerchantInventory(id: number, payload: { count: number; reason?: string; offerId?: number }): Promise<{ voided: number; stock: number }> {
  const { data } = await api.post<{ voided: number; stock: number }>(`/merchant/products/${id}/inventory/void`, payload)
  return data
}

export async function getMerchantInventoryLogs(id: number, params?: { page?: number; pageSize?: number }): Promise<ListEnvelope<InventoryLog>> {
  const { data } = await api.get<ListEnvelope<InventoryLog>>(`/merchant/products/${id}/inventory/logs`, { params })
  return data
}

export async function previewMerchantInventory(id: number, payload: ImportInventoryRequest): Promise<any> {
  const { data } = await api.post<any>(`/merchant/products/${id}/inventory/preview`, payload)
  return data
}

export async function importMerchantInventory(id: number, payload: ImportInventoryRequest): Promise<{ imported: number }> {
  const { data } = await api.post<{ imported: number }>(`/merchant/products/${id}/inventory`, payload)
  return data
}

/**
 * 调整非即时库存商品的剩余名额。delta 为正时补充、为负时减少。
 * 即时库存商品必须通过交付库存导入/作废接口管理。
 */
export async function adjustMerchantProductCapacity(id: number, payload: { delta: number; reason: string; offerId?: number }): Promise<void> {
  await api.post(`/merchant/products/${id}/capacity/adjust`, payload)
}

export async function getMerchantOrders(params?: { page?: number; pageSize?: number; status?: string; q?: string; productId?: number; dateFrom?: string; dateTo?: string; sort?: 'booking' }): Promise<ListEnvelope<MerchantOrder>> {
  const { data } = await api.get<ListEnvelope<MerchantOrder>>('/merchant/orders', { params })
  return data
}

export async function getMerchantOrderDetail(id: number): Promise<MerchantOrder> {
  const { data } = await api.get<MerchantOrder>(`/merchant/orders/${id}`)
  return data
}

export async function startFulfillment(id: number, payload?: { publicNote?: string }): Promise<void> {
  await api.post(`/merchant/orders/${id}/fulfillment/start`, payload)
}

export async function deliverOrder(
  id: number,
  payload: {
    deliveryContent?: string
    /** P4b：按规格交付字段模板提交的字段值(与 deliveryContent 二选一)。 */
    structuredValues?: Record<string, string>
    /** P5：交付附件(先经 uploadDeliveryFile 获得);可与文本/结构化并存。 */
    attachmentFileId?: number
    publicNote?: string
  },
): Promise<void> {
  await api.post(`/merchant/orders/${id}/fulfillment/deliver`, payload)
}

/** P6b：商家发布履约进度（仅 processing 人工服务订单；服务端按单频控）。 */
export async function postOrderProgress(id: number, note: string): Promise<{ ok: true }> {
  const { data } = await api.post<{ ok: true }>(`/merchant/orders/${id}/progress`, { note })
  return data
}

export async function respondDispute(id: number, payload: { resolution: 'resume' | 'close'; publicNote?: string }): Promise<void> {
  await api.post(`/merchant/orders/${id}/fulfillment/respond-dispute`, payload)
}

export async function rejectOrder(
  id: number,
  payload?: { publicNote?: string; internalNote?: string },
): Promise<void> {
  await api.post(`/merchant/orders/${id}/fulfillment/reject`, payload ?? {})
}

export async function getMerchantSettlements(params?: { page?: number; pageSize?: number; status?: string }): Promise<Settlement[]> {
  const { data } = await api.get<Settlement[]>('/merchant/settlements', { params })
  return data
}

// ---- Offers (P4a: SKU 管理) ----

/**
 * P5：交付文件上传（私有桶，流式）。返回 fileId 供规格挂载/交付附件；
 * 响应不含对象键。
 */
export async function uploadDeliveryFile(file: File): Promise<{ id: number; fileName: string; size: number }> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post('/uploads/delivery-file', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}

export async function getMerchantOffers(productId: number): Promise<Offer[]> {
  const { data } = await api.get<Offer[]>(`/merchant/products/${productId}/offers`)
  return data
}

export async function createMerchantOffer(
  productId: number,
  payload: OfferWriteRequest & { name: string; price: number },
): Promise<Offer> {
  const { data } = await api.post<Offer>(`/merchant/products/${productId}/offers`, payload)
  return data
}

export async function updateMerchantOffer(
  productId: number,
  offerId: number,
  payload: OfferWriteRequest,
): Promise<Offer> {
  const { data } = await api.put<Offer>(`/merchant/products/${productId}/offers/${offerId}`, payload)
  return data
}

export async function deleteMerchantOffer(productId: number, offerId: number): Promise<{ deleted: boolean }> {
  const { data } = await api.delete<{ deleted: boolean }>(`/merchant/products/${productId}/offers/${offerId}`)
  return data
}

// ---- P7b: 自动开通 webhook 配置 ----

/** 读取当前 active 配置;未配置返回 null。仅出 secretLast4,绝不出明文。 */
export async function getMyWebhookConfig(): Promise<MerchantWebhookConfig | null> {
  const { data } = await api.get<MerchantWebhookConfig | null>('/merchant/webhook-config')
  return data
}

/**
 * 保存(创建或轮换)。响应里的 `secret` 是明文的**唯一**出口——只在此刻展示一次,
 * 之后无法再取。轮换会撤销旧配置并把引用它的未发任务降级人工。
 */
export async function saveMyWebhookConfig(url: string): Promise<MerchantWebhookConfig & { secret: string }> {
  const { data } = await api.put<MerchantWebhookConfig & { secret: string }>('/merchant/webhook-config', { url })
  return data
}

/** 撤销配置:同时强制关闭该商家全部规格的自动开通开关(需刷新规格列表)。 */
export async function deleteMyWebhookConfig(): Promise<{ revoked: boolean; disabledOffers: number }> {
  const { data } = await api.delete<{ revoked: boolean; disabledOffers: number }>('/merchant/webhook-config')
  return data
}

/** 发送测试事件(与真实外呼同一安全路径);只回 HTTP 状态与脱敏诊断码。 */
export async function testMyWebhookConfig(): Promise<{ ok: boolean; httpStatus: number | null; error?: string }> {
  const { data } = await api.post<{ ok: boolean; httpStatus: number | null; error?: string }>('/merchant/webhook-config/test')
  return data
}
