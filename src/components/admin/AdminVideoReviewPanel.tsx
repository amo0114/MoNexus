import { useEffect, useState } from 'react'
import { listVideoReviews, reviewProductVideo, type VideoReview } from '../../api/productVideos'
import { getApiErrorMessage } from '../../api/error'
import ProductVideoPlayer from '../catalog/ProductVideoPlayer'

export default function AdminVideoReviewPanel() {
  const [filter, setFilter] = useState('pending')
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<VideoReview[]>([])
  const [current, setCurrent] = useState<VideoReview | null>(null)
  const [watched, setWatched] = useState(false)
  const [listened, setListened] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void listVideoReviews(controller.signal, filter).then(result => { if (!controller.signal.aborted) setRows(result) }).catch(err => { if (!controller.signal.aborted) setError(getApiErrorMessage(err, '视频审核列表加载失败')) })
    return () => controller.abort()
  }, [open, revision, filter])
  function select(row: VideoReview) { setCurrent(row); setWatched(false); setListened(false); setReason(''); setError('') }
  async function submit(action: 'approve' | 'reject') {
    if (!current || busy) return
    setBusy(true); setError('')
    try {
      await reviewProductVideo(current.assetId, { productId: current.product.id, expectedVersion: current.moderationVersion!, action, watched, listened, ...(reason.trim() ? { reason: reason.trim() } : {}) })
      setCurrent(null); setRevision(v => v + 1)
    } catch (err) {
      setError(getApiErrorMessage(err, '审核失败，请刷新后重试'))
      // Do not reuse a stale attestation after a CAS conflict.
      setCurrent(null); setRevision(v => v + 1)
    } finally { setBusy(false) }
  }
  return <section className="my-4 border rounded-lg p-3 space-y-3" aria-label="视频内容审核">
    <button type="button" className="btn-secondary" onClick={() => setOpen(v => !v)}>视频内容审核（含仅登录商品）</button>
    {open && <>
      <p className="text-sm">先审核视频，再进行游客公开审核。拒绝或撤销后，会员和游客都无法获取新的播放地址。</p>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setCurrent(null); setRevision(v => v + 1) }}>刷新视频列表</button>
      <label className="block">视频审核状态 <select aria-label="视频审核状态" className="input" disabled={busy} value={filter} onChange={e => { setCurrent(null); setRows([]); setFilter(e.target.value) }}><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已拒绝</option></select></label>
      <p className="text-xs">每次显示最早的 100 条，完成后刷新查看下一批。</p>
      <ul className="space-y-2 max-h-64 overflow-auto">{rows.map(row => <li key={row.assetId}>
        <button type="button" className="text-sm underline" disabled={busy} onClick={() => select(row)}>{row.product.name} · {row.moderation === 'approved' ? '已通过' : row.moderation === 'rejected' ? '已拒绝' : '待审核'}</button>
      </li>)}</ul>
      {rows.length === 0 && <p>暂无已关联的视频。</p>}
      {current && <div className="space-y-3" key={`${current.assetId}:${current.moderationVersion}`}>
        <p className="font-medium">{current.product.name}</p>
        <div className="max-w-lg h-64"><ProductVideoPlayer assetId={current.assetId} actor="admin" /></div>
        <p className="text-sm">检查完整画面、文字、二维码；有声音时请打开声音并听完。以下勾选记录您的审核声明。</p>
        <label className="block"><input type="checkbox" checked={watched} onChange={e => setWatched(e.target.checked)} /> 我已完整观看视频</label>
        {current.hasAudio && <label className="block"><input type="checkbox" checked={listened} onChange={e => setListened(e.target.checked)} /> 我已听完音频</label>}
        <label className="block">拒绝或撤销原因<input className="input w-full" value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label>
        <div className="flex gap-2">
          <button type="button" className="btn-primary" disabled={busy || !watched || (current.hasAudio && !listened)} onClick={() => void submit('approve')}>批准视频内容</button>
          <button type="button" className="btn-secondary" disabled={busy || !reason.trim()} onClick={() => void submit('reject')}>拒绝或撤销视频</button>
        </div>
      </div>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>
}
