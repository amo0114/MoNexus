import api from './client'
import { uploadDeliveryFile as uploadMerchantDeliveryFile } from './merchant'
import type { CreateProductV2OfferRequest, ProductEditorDto } from './catalog'
import type { DeliveryMode, StockMode } from '../types/merchant'

export type PlatformOfferWriteRequest = CreateProductV2OfferRequest

export type PlatformOfferPatchRequest = {
  name?: string
  price?: number
  originalPrice?: number | null
  validityDays?: number | null
  sortOrder?: number
  attributes?: Record<string, string | number | boolean | string[]>
  deliveryMode?: DeliveryMode
  stockMode?: StockMode
  fixedContentType?: 'text' | 'url' | 'file'
  fixedContent?: string | null
  fixedFileId?: number | null
  fixedStructuredContent?: unknown | null
}

/** Reuses the shared delivery-file upload protocol (admin MFA → merchantId null). */
export async function uploadDeliveryFile(file: File): Promise<{ id: number; fileName: string; size: number }> {
  return uploadMerchantDeliveryFile(file)
}

export async function createPlatformOffer(productId: number, payload: PlatformOfferWriteRequest) {
  const { data } = await api.post(`/admin/products/${productId}/offers`, payload)
  return data
}

export async function patchPlatformOffer(
  productId: number,
  offerId: number,
  payload: PlatformOfferPatchRequest,
) {
  const { data } = await api.patch(`/admin/products/${productId}/offers/${offerId}`, payload)
  return data
}

export async function getAdminProductEditor(productId: number): Promise<ProductEditorDto> {
  const { data } = await api.get<ProductEditorDto>(`/admin/products/${productId}/editor`)
  return data
}
