import api from './client'
import {
  Merchant,
  MerchantDetail,
  RejectMerchantRequest,
  UpdateCommissionRequest,
  Settlement,
  BatchSettleRequest
} from '../types/merchant'

export async function getAdminMerchants(params?: { status?: string; q?: string; page?: number; pageSize?: number }): Promise<Merchant[]> {
  const { data } = await api.get<Merchant[]>('/admin/merchants', { params })
  return data
}

export async function getAdminMerchantDetail(id: number): Promise<MerchantDetail> {
  const { data } = await api.get<MerchantDetail>(`/admin/merchants/${id}`)
  return data
}

export async function approveMerchant(id: number): Promise<Merchant> {
  const { data } = await api.put<Merchant>(`/admin/merchants/${id}/approve`)
  return data
}

export async function rejectMerchant(id: number, payload: RejectMerchantRequest): Promise<Merchant> {
  const { data } = await api.put<Merchant>(`/admin/merchants/${id}/reject`, payload)
  return data
}

export async function suspendMerchant(id: number): Promise<Merchant> {
  const { data } = await api.put<Merchant>(`/admin/merchants/${id}/suspend`)
  return data
}

export async function updateMerchantCommission(id: number, payload: UpdateCommissionRequest): Promise<Merchant> {
  const { data } = await api.put<Merchant>(`/admin/merchants/${id}/commission`, payload)
  return data
}

export async function getAdminSettlements(params?: { status?: string; page?: number; pageSize?: number }): Promise<Settlement[]> {
  const { data } = await api.get<Settlement[]>('/admin/settlements', { params })
  return data
}

export async function batchSettle(payload: BatchSettleRequest): Promise<{ settled: number }> {
  const { data } = await api.post<{ settled: number }>('/admin/settlements/batch-settle', payload)
  return data
}
