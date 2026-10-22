import { useEffect, useRef, useState } from 'react'
import { uploadProductVideo } from '../../api/productVideos'
import type { ProductEditorActor } from '../../api/catalog'
import type { ProductVideoSummary } from '../../types/product'
import ProductVideoPlayer from '../catalog/ProductVideoPlayer'

export interface ProductVideoUploaderProps {
  value?: ProductVideoSummary | null
  onChange: (value: ProductVideoSummary | null) => void
  onBusyChange?: (busy: boolean) => void
  disabled?: boolean
  actor?: ProductEditorActor
  merchantId?: number | null
}
export default function ProductVideoUploader({ value, onChange, onBusyChange, disabled, actor = 'merchant', merchantId }: ProductVideoUploaderProps) {
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange
  useEffect(() => () => { controller.current?.abort(); busyCallback.current?.(false) }, [])
  async function upload(file?: File) {
    if (!file || controller.current) return
    if (file.size > 40 * 1024 * 1024 || !file.size) { setError('请选择不超过 40 MiB 的 MP4 视频'); return }
    const active = new AbortController(); controller.current = active
    setError(''); setProgress(0); busyCallback.current?.(true)
    try {
      const asset = await uploadProductVideo(file, setProgress, active.signal, actor === 'admin' ? merchantId : undefined)
      if (!active.signal.aborted) onChange(asset)
    } catch (err) {
      if (!active.signal.aborted) {
        const message = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
        setError(message || '视频上传失败，原视频已保留，请重试')
      }
    } finally {
      if (controller.current === active) { controller.current = null; setProgress(null); busyCallback.current?.(false) }
      if (input.current) input.current.value = ''
    }
  }
  return <section className="space-y-2" aria-label="商品视频上传">
    <p className="font-medium text-sm">商品视频（可选）</p>
    <p className="text-xs text-[var(--color-text-muted)]">最多 1 个，60 秒、40 MiB 以内，1080p H.264 SDR MP4，AAC-LC 音频或无音轨。视频变化需保存商品，公开资格需要重新审核。</p>
    <input ref={input} type="file" className="block w-full min-w-0 max-w-full text-sm" accept="video/mp4,.mp4" aria-label="选择商品视频" disabled={disabled || progress !== null}
      onChange={event => void upload(event.target.files?.[0])} />
    {progress !== null && <div role="status">{progress < 100 ? `上传中 ${progress}%` : '校验处理中…'} <button type="button" onClick={() => controller.current?.abort()}>取消上传</button></div>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {value && <>
      <p className="text-xs">{(value.durationMs / 1000).toFixed(1)} 秒 · {value.width} × {value.height}</p>
      <div className="max-w-md h-56"><ProductVideoPlayer key={value.assetId} assetId={value.assetId} actor={actor} /></div>
      <button type="button" className="btn-secondary" disabled={disabled || progress !== null} onClick={() => onChange(null)}>移除视频（保存后生效）</button>
    </>}
  </section>
}
