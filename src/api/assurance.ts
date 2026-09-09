import api from './client'

export type AssuranceApplicationDto = {
  id: number
  productId: number
  merchantId: number
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  reviewReason: string | null
  reviewedAt: string | null
  createdAt: string
  reviewedByUserId?: number | null
}

export type AssuranceGrantDto = {
  id: number
  productId: number
  status: 'active' | 'expired' | 'revoked'
  policyCode: string
  policyText: string
  validFrom: string
  validUntil: string
  revokedAt: string | null
  createdAt: string
  applicationId?: number | null
  grantedByUserId?: number
  grantReason?: string
  revokedByUserId?: number | null
  revokeReason?: string | null
}

export async function getMerchantAssurance(productId: number) {
  const { data } = await api.get<{ application: AssuranceApplicationDto | null; grant: AssuranceGrantDto | null }>(
    `/merchant/products/${productId}/assurance`,
  )
  return data
}

export async function applyMerchantAssurance(productId: number, reason: string) {
  const { data } = await api.post<AssuranceApplicationDto>(
    `/merchant/products/${productId}/assurance/applications`,
    { reason },
  )
  return data
}

export async function withdrawMerchantAssurance(applicationId: number) {
  const { data } = await api.post<AssuranceApplicationDto>(
    `/merchant/assurance-applications/${applicationId}/withdraw`,
    {},
  )
  return data
}

export async function getAdminProductAssurance(productId: number) {
  const { data } = await api.get<{ application: AssuranceApplicationDto | null; grant: AssuranceGrantDto | null }>(
    `/admin/products/${productId}/assurance`,
  )
  return data
}

export async function listAdminAssuranceApplications(params: { status?: string; page?: number; pageSize?: number } = {}) {
  const { data } = await api.get<{
    items: AssuranceApplicationDto[]
    total: number
    page: number
    pageSize: number
  }>('/admin/assurance-applications', { params })
  return data
}

export async function approveAdminAssuranceApplication(id: number, body: { validUntil: string; reason: string }) {
  const { data } = await api.post<{ application: AssuranceApplicationDto; grant: AssuranceGrantDto }>(
    `/admin/assurance-applications/${id}/approve`,
    body,
  )
  return data
}

export async function rejectAdminAssuranceApplication(id: number, reason: string) {
  const { data } = await api.post<AssuranceApplicationDto>(`/admin/assurance-applications/${id}/reject`, { reason })
  return data
}

export async function grantAdminProductAssurance(productId: number, body: { validUntil: string; reason: string }) {
  const { data } = await api.post<AssuranceGrantDto>(`/admin/products/${productId}/assurance/grants`, body)
  return data
}

export async function revokeAdminAssuranceGrant(grantId: number, reason: string) {
  const { data } = await api.post<AssuranceGrantDto>(`/admin/assurance-grants/${grantId}/revoke`, { reason })
  return data
}
