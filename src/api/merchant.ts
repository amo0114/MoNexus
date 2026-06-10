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
  Settlement,
  ListEnvelope
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

// M9: 商品响应新增 images（types/merchant.ts 归属其他模块，这里做本地扩展）
export type MerchantProductWithImages = MerchantProduct & { images?: string[] }

export type CreateMerchantProductPayload = CreateMerchantProductRequest & { images?: string[] }
export type UpdateMerchantProductPayload = UpdateMerchantProductRequest & { images?: string[] }

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
  merchantId: number
  actorUserId: number
  action: 'import' | 'void'
  delta: number
  reason: string | null
  createdAt: string
}

export async function getMerchantProducts(params?: MerchantProductListParams): Promise<ListEnvelope<MerchantProductWithImages>> {
  const { data } = await api.get<ListEnvelope<MerchantProductWithImages>>('/merchant/products', { params })
  return data
}

export async function createMerchantProduct(payload: CreateMerchantProductPayload): Promise<MerchantProduct> {
  const { data } = await api.post<MerchantProduct>('/merchant/products', payload)
  return data
}

export async function updateMerchantProduct(id: number, payload: UpdateMerchantProductPayload): Promise<MerchantProduct> {
  const { data } = await api.put<MerchantProduct>(`/merchant/products/${id}`, payload)
  return data
}

export async function voidMerchantInventory(id: number, payload: { count: number; reason?: string }): Promise<{ voided: number; stock: number }> {
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

export async function getMerchantOrders(params?: { page?: number; pageSize?: number; status?: string; q?: string; productId?: number; dateFrom?: string; dateTo?: string }): Promise<ListEnvelope<MerchantOrder>> {
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

export async function deliverOrder(id: number, payload: { deliveryContent: string; publicNote?: string }): Promise<void> {
  await api.post(`/merchant/orders/${id}/fulfillment/deliver`, payload)
}

export async function respondDispute(id: number, payload: { resolution: 'resume' | 'close'; publicNote?: string }): Promise<void> {
  await api.post(`/merchant/orders/${id}/fulfillment/respond-dispute`, payload)
}

export async function getMerchantSettlements(params?: { page?: number; pageSize?: number; status?: string }): Promise<Settlement[]> {
  const { data } = await api.get<Settlement[]>('/merchant/settlements', { params })
  return data
}
