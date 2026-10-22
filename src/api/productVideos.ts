import api from './client'
import type { ProductVideoSummary } from '../types/product'
import type { ProductEditorActor } from './catalog'

export interface VideoTicket {
  videoAssetId: string
  playbackUrl: string
  posterUrl: string
  expiresAt: string
}
export async function uploadProductVideo(file: File, onProgress: (percent: number) => void, signal: AbortSignal, merchantId?: number | null): Promise<ProductVideoSummary> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post<ProductVideoSummary>('/uploads/product-video', form, {
    signal, timeout: 250_000, params: merchantId == null ? undefined : { merchantId },
    onUploadProgress: event => onProgress(Math.min(100, Math.round(event.loaded / (event.total || file.size) * 100))),
  })
  return data
}
export async function previewProductVideo(actor: ProductEditorActor, assetId: string, signal: AbortSignal): Promise<VideoTicket> {
  return (await api.get<VideoTicket>(`/${actor}/product-videos/${encodeURIComponent(assetId)}/preview`, { signal })).data
}
export async function getProductVideoPlayback(productId: number, assetId: string, signal: AbortSignal): Promise<VideoTicket> {
  return (await api.get<VideoTicket>(`/products/${productId}/video-playback`, { signal, params: { expectedVideoAssetId: assetId } })).data
}
