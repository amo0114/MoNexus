import { useEffect, useRef, useState } from 'react'
import { uploadProductVideo, listProductVideoJobs, type VideoJob } from '../../api/productVideos'
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
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const controller = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange
  useEffect(() => () => { controller.current?.abort(); busyCallback.current?.(false) }, [])
  useEffect(() => {
    const request = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      let delay = 0
      try {
        const result = await listProductVideoJobs(actor, request.signal, actor === 'admin' ? merchantId : undefined)
        if (!request.signal.aborted) setJobs(result)
        if (result.some(job => ['queued', 'processing'].includes(job.status))) delay = 3_000
      } catch { delay = 15_000 }
      if (delay && !request.signal.aborted) timer = setTimeout(() => void refresh(), delay)
    }
    setJobs([]); void refresh()
    return () => { request.abort(); clearTimeout(timer) }
  }, [actor, merchantId, refreshVersion])
  async function upload(file?: File) {
    if (!file || controller.current) return
    if (file.size > 90 * 1024 * 1024 || !file.size) { setError('请选择不超过 90 MiB 的视频'); return }
    const active = new AbortController(); controller.current = active
    setError(''); setProgress(0); busyCallback.current?.(true)
    try {
      const job = await uploadProductVideo(file, setProgress, active.signal, actor === 'admin' ? merchantId : undefined)
      if (!active.signal.aborted) { setJobs(previous => [job, ...previous.filter(j => j.assetId !== job.assetId)]); setRefreshVersion(v => v + 1) }
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
    <p className="text-xs text-[var(--color-text-muted)]">最多 1 个，60 秒、90 MiB 以内，支持手机 MP4、MOV。上传后自动处理，完成后选择并保存商品。内容审核通过后才向买家展示。</p>
    <input ref={input} type="file" className="block w-full min-w-0 max-w-full text-sm" accept="video/mp4,video/quicktime,.mp4,.mov" aria-label="选择商品视频" disabled={disabled || progress !== null}
      onChange={event => void upload(event.target.files?.[0])} />
    {progress !== null && <div role="status">{progress < 100 ? `上传中 ${progress}%` : '正在保存原片…'} <button type="button" onClick={() => controller.current?.abort()}>取消上传</button></div>}
    {jobs.filter(j => j.assetId !== value?.assetId).map(job => <div key={job.assetId} className="text-sm border rounded p-2" role="status">
      {['queued', 'processing'].includes(job.status) ? '视频正在后台处理，可离开页面，稍后回来选择。原视频仍保留。' : job.status === 'failed' ? (job.error || '处理失败，请重新上传，原视频仍保留。') : job.video ? <>
        <span>视频已处理完成（{(job.video.durationMs / 1000).toFixed(1)} 秒）</span>{' '}
        <button type="button" className="btn-secondary" disabled={disabled || progress !== null} onClick={() => onChange(job.video)}>使用此视频（保存后生效）</button>
      </> : '正在更新状态…'}
    </div>)}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {value && <>
      <p className="text-xs">{(value.durationMs / 1000).toFixed(1)} 秒 · {value.width} × {value.height} · {value.moderation === 'approved' ? '视频审核已通过' : value.moderation === 'rejected' ? `视频未通过审核：${value.moderationReason || '请更换素材'}` : '待视频内容审核'}</p>
      <div className="max-w-md h-56"><ProductVideoPlayer key={value.assetId} assetId={value.assetId} actor={actor} /></div>
      <button type="button" className="btn-secondary" disabled={disabled || progress !== null} onClick={() => onChange(null)}>移除视频（保存后生效）</button>
    </>}
  </section>
}
