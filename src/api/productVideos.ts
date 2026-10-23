import api from './client'
import type { ProductVideoSummary } from '../types/product'
import type { ProductEditorActor } from './catalog'

export interface VideoTicket {
  videoAssetId: string
  playbackUrl: string
  posterUrl: string
  expiresAt: string
}
export async function uploadProductVideo(file: File, onProgress: (percent: number) => void, signal: AbortSignal, merchantId?: number | null): Promise<VideoJob> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post<VideoJob>('/uploads/product-video', form, {
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

export interface VideoJob { assetId: string; status: string; error: string | null; video: ProductVideoSummary | null }
export async function listProductVideoJobs(actor: ProductEditorActor, signal: AbortSignal, merchantId?: number | null): Promise<VideoJob[]> {
  return (await api.get<VideoJob[]>(`/${actor}/product-videos`, { signal, params: merchantId == null ? undefined : { merchantId } })).data
}
export interface VideoReview extends ProductVideoSummary { product: { id: number; name: string; visibility: string } }
export async function listVideoReviews(signal: AbortSignal, moderation = 'pending'): Promise<VideoReview[]> {
  return (await api.get<VideoReview[]>('/admin/product-videos/reviews', { signal, params: { moderation } })).data
}
export async function reviewProductVideo(assetId: string, input: { productId: number; expectedVersion: number; action: 'approve' | 'reject'; watched?: boolean; listened?: boolean; reason?: string }): Promise<ProductVideoSummary> {
  return (await api.post<ProductVideoSummary>(`/admin/product-videos/${encodeURIComponent(assetId)}/review`, input)).data
}
