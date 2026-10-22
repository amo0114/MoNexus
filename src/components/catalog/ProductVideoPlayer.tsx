import { useEffect, useRef, useState, useCallback } from 'react'
import { getProductVideoPlayback, previewProductVideo, type VideoTicket } from '../../api/productVideos'
import type { ProductEditorActor } from '../../api/catalog'
import { useAuthStore } from '../../stores/authStore'

interface Props { assetId: string; productId?: number; actor?: ProductEditorActor; cover?: string }

/** Signed addresses live only in this mounted player, never in DTO/localStorage. */
export default function ProductVideoPlayer({ assetId, productId, actor, cover }: Props) {
  const epoch = useAuthStore(state => state.authEpoch)
  const identity = useAuthStore(state => state.user?.id)
  const session = useAuthStore(state => state.sessionId)
  return <VideoSession key={`${assetId}:${productId}:${actor}:${epoch}:${identity}:${session}`} assetId={assetId} productId={productId} actor={actor} cover={cover} />
}
function VideoSession({ assetId, productId, actor, cover }: Props) {
  const [ticket, setTicket] = useState<VideoTicket | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const video = useRef<HTMLVideoElement | null>(null)
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    const previous = video.current
    if (previous && previous !== node) { previous.pause(); previous.removeAttribute('src'); previous.load() }
    video.current = node
  }, [])
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const retried = useRef(false)
  const position = useRef(0)
  useEffect(() => {
    setTicket(null); setBusy(false); setError(false); retried.current = false
    return () => {
      generation.current++
      request.current?.abort()
      const element = video.current
      if (element) { element.pause(); element.removeAttribute('src'); element.load() }
    }
  }, [assetId, productId, actor])

  async function load(renew = false) {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    const current = ++generation.current
    if (!renew) { position.current = 0; retried.current = false }
    setBusy(true); setError(false)
    try {
      const result = actor
        ? await previewProductVideo(actor, assetId, controller.signal)
        : await getProductVideoPlayback(productId!, assetId, controller.signal)
      if (controller.signal.aborted || current !== generation.current) return
      if (result.videoAssetId !== assetId) throw new Error('media changed')
      setTicket(result)
    } catch {
      if (!controller.signal.aborted && current === generation.current) { setTicket(null); setError(true) }
    } finally { if (current === generation.current) setBusy(false) }
  }
  function mediaError() {
    if (ticket && Date.parse(ticket.expiresAt) <= Date.now() && !retried.current) {
      retried.current = true
      position.current = video.current?.currentTime || 0
      void load(true)
    } else { setTicket(null); setError(true) }
  }
  return <div className="relative flex h-full min-h-40 w-full items-center justify-center bg-black rounded-lg overflow-hidden" data-testid="product-video-player">
    {ticket ? <video ref={attachVideo} key={ticket.playbackUrl} src={ticket.playbackUrl} poster={ticket.posterUrl} controls playsInline preload="none" muted
      className="w-full h-full max-h-[400px]" aria-label="商品展示视频"
      onLoadedMetadata={event => { if (event.currentTarget === video.current) event.currentTarget.currentTime = position.current }}
      onError={event => { if (event.currentTarget === video.current) mediaError() }} /> : <>
      {cover && <img src={cover} alt="商品视频封面" className="absolute inset-0 w-full h-full object-contain opacity-70" />}
      <button type="button" disabled={busy} onClick={() => void load()} className="relative z-10 rounded-full bg-black/70 text-white px-5 py-3">
        {busy ? '正在获取播放权限…' : error ? '视频暂不可播放，点击重试' : '▶ 播放商品视频'}
      </button>
    </>}
  </div>
}
