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
  Settlement
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

export async function getMerchantProducts(params?: { page?: number; pageSize?: number; status?: string }): Promise<MerchantProduct[]> {
  const { data } = await api.get<MerchantProduct[]>('/merchant/products', { params })
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

export async function importMerchantInventory(id: number, payload: ImportInventoryRequest): Promise<{ imported: number }> {
  const { data } = await api.post<{ imported: number }>(`/merchant/products/${id}/inventory`, payload)
  return data
}

export async function getMerchantOrders(params?: { page?: number; pageSize?: number }): Promise<MerchantOrder[]> {
  const { data } = await api.get<MerchantOrder[]>('/merchant/orders', { params })
  return data
}

export async function getMerchantOrderDetail(id: number): Promise<MerchantOrder> {
  const { data } = await api.get<MerchantOrder>(`/merchant/orders/${id}`)
  return data
}

export async function getMerchantSettlements(params?: { page?: number; pageSize?: number; status?: string }): Promise<Settlement[]> {
  const { data } = await api.get<Settlement[]>('/merchant/settlements', { params })
  return data
}
