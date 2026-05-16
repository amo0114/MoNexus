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

export async function getMerchantProducts(params?: { page?: number; pageSize?: number; status?: string; q?: string; type?: string; deliveryMode?: string; lowStock?: boolean }): Promise<ListEnvelope<MerchantProduct>> {
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
