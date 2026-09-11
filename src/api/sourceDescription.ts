import api from './client'

export type SourceDescriptionField = 'description' | 'richDescription'

export type SourceDescriptionPreview = {
  sourceHash: string
  descriptionHash: string
  source: { description: string; richDescription: string | null }
  local: { description: string | null; richDescription: string | null; contentVersion: number }
  changedSinceAccepted: boolean | null
}

export type SourceDescriptionApplyRequest = {
  sourceHash: string
  descriptionHash: string
  expectedContentVersion: number
  fields: SourceDescriptionField[]
}

export type SourceDescriptionApplyResult = {
  id: number
  contentVersion: number
  appliedFields: SourceDescriptionField[]
  sourceHash: string
  descriptionHash: string
}

export async function previewAdminSourceDescription(productId: number) {
  const { data } = await api.post<SourceDescriptionPreview>(
    `/admin/products/${productId}/source-description/preview`,
  )
  return data
}

export async function applyAdminSourceDescription(
  productId: number,
  payload: SourceDescriptionApplyRequest,
) {
  const { data } = await api.post<SourceDescriptionApplyResult>(
    `/admin/products/${productId}/source-description/apply`,
    payload,
  )
  return data
}
