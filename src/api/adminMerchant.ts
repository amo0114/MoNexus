import api from './client'
import {
  Merchant,
  MerchantDetail,
  RejectMerchantRequest,
  UpdateCommissionRequest,
  Settlement,
  BatchSettleRequest,
  BatchSettleResponse,
  ListEnvelope,
} from '../types/merchant'

function validateListEnvelope<T>(data: unknown, entityName: string): ListEnvelope<T> {
  const env = data as Partial<ListEnvelope<T>> | undefined
  if (
    !env ||
    typeof env !== 'object' ||
    !Array.isArray(env.items) ||
    !Number.isSafeInteger(env.total) ||
    (env.total as number) < 0 ||
    !Number.isSafeInteger(env.page) ||
    (env.page as number) < 1 ||
    !Number.isSafeInteger(env.pageSize) ||
    (env.pageSize as number) < 1 ||
    (env.pageSize as number) > 100
  ) {
    throw new Error(`无效的${entityName}分页响应结构，缺少 ListEnvelope 契约字段`)
  }
  return data as ListEnvelope<T>
}

export async function getAdminMerchants(params?: {
  status?: string
  q?: string
  page?: number
  pageSize?: number
}): Promise<ListEnvelope<Merchant>> {
  const { data } = await api.get<ListEnvelope<Merchant>>('/admin/merchants', { params })
  return validateListEnvelope<Merchant>(data, '商家列表')
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

export async function getAdminSettlements(params?: {
  status?: string
  page?: number
  pageSize?: number
}): Promise<ListEnvelope<Settlement>> {
  const { data } = await api.get<ListEnvelope<Settlement>>('/admin/settlements', { params })
  return validateListEnvelope<Settlement>(data, '结算列表')
}

export async function batchSettle(payload: BatchSettleRequest): Promise<BatchSettleResponse> {
  const { data } = await api.post<BatchSettleResponse>('/admin/settlements/batch-settle', payload)
  return data
}
