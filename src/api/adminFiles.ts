import api from './client'

/** P5.5 T1：管理端文件治理——交付文件列表、发放流水与吊销。 */

export interface AdminDeliveryFile {
  id: number
  fileName: string
  size: number
  sha256: string
  mimeType: string
  status: string  // active | revoked | deleted
  createdAt: string  // ISO
  merchant: { id: number; name: string } | null
  refCounts: { offers: number; deliveryRecords: number }
}

export interface AdminDeliveryFileListResponse {
  items: AdminDeliveryFile[]
  total: number
  page: number
  pageSize: number
}

export interface AdminDeliveryFileQuery {
  page?: number
  pageSize?: number
  merchantId?: number
  status?: string
  fileName?: string
}

export interface AdminFileGrant {
  id: number
  orderId: number
  userId: number
  role: string
  outcome: string  // granted | denied_*
  ipHash: string | null
  userAgent: string | null
  expiresAt: string | null
  createdAt: string  // ISO
}

export interface AdminFileGrantListResponse {
  items: AdminFileGrant[]
  total: number
  page: number
  pageSize: number
}

export async function listAdminDeliveryFiles(query: AdminDeliveryFileQuery = {}): Promise<AdminDeliveryFileListResponse> {
  const { data } = await api.get<AdminDeliveryFileListResponse>('/admin/delivery-files', { params: query })
  return data
}

export async function listAdminFileGrants(fileId: number, query: { page?: number; pageSize?: number } = {}): Promise<AdminFileGrantListResponse> {
  const { data } = await api.get<AdminFileGrantListResponse>(`/admin/delivery-files/${fileId}/grants`, { params: query })
  return data
}

export async function revokeAdminDeliveryFile(fileId: number, reason?: string): Promise<void> {
  await api.post(`/admin/delivery-files/${fileId}/revoke`, reason ? { reason } : {})
}
