import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, RotateCcw } from 'lucide-react'
import { getProductVideoPlayback, previewProductVideo, type VideoTicket } from '../../api/productVideos'
import type { ProductEditorActor } from '../../api/catalog'
import { useAuthStore } from '../../stores/authStore'

interface Props { assetId: string; productId?: number; actor?: ProductEditorActor; cover?: string; autoPlay?: boolean }

/** Signed addresses live only in this mounted player, never in DTO/localStorage. */
export default function ProductVideoPlayer({ assetId, productId, actor, cover, autoPlay = false }: Props) {
  const epoch = useAuthStore(state => state.authEpoch)
  const identity = useAuthStore(state => state.user?.id)
  const session = useAuthStore(state => state.sessionId)
  return <VideoSession key={`${assetId}:${productId}:${actor}:${epoch}:${identity}:${session}`} assetId={assetId} productId={productId} actor={actor} cover={cover} autoPlay={autoPlay} />
}
function VideoSession({ assetId, productId, actor, cover, autoPlay = false }: Props) {
  const [ticket, setTicket] = useState<VideoTicket | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [playBlocked, setPlayBlocked] = useState(false)
  const [eligible, setEligible] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement | null>(null)
  const eligibleRef = useRef(false)
  const wantsPlayback = useRef(autoPlay)
  const userPaused = useRef(false)
  const programmaticPauses = useRef(new WeakMap<HTMLVideoElement, number>())
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    const previous = video.current
    video.current = node
    if (previous && previous !== node) { previous.pause(); previous.removeAttribute('src'); previous.load() }
  }, [])
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const retried = useRef(false)
  const position = useRef(0)
  useEffect(() => () => {
    generation.current++
    request.current?.abort()
    const element = video.current
    if (element) { element.pause(); element.removeAttribute('src'); element.load() }
  }, [])

  // Autoplay is a best-effort enhancement. Do not load an offscreen gallery or
  // resume a video the visitor deliberately paused (or already finished).
  useEffect(() => {
    let inView = typeof IntersectionObserver === 'undefined'
    function update() {
      const next = inView && document.visibilityState !== 'hidden'
      eligibleRef.current = next
      const element = video.current
      if (!next && element && !element.paused) {
        // pause events are queued: the player may already be visible again
        // when this event arrives. Track its cause instead of current visibility.
        programmaticPauses.current.set(element, (programmaticPauses.current.get(element) || 0) + 1)
        element.pause()
      }
      setEligible(next)
    }
    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? false; update() })
      : null
    if (frame.current) observer?.observe(frame.current)
    document.addEventListener('visibilitychange', update)
    update()
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [])

  const load = useCallback(async (renew = false) => {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    const current = ++generation.current
    if (!renew) { position.current = 0; retried.current = false }
    setBusy(true); setError(false); setPlayBlocked(false)
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
  }, [actor, assetId, productId])

  const play = useCallback(() => {
    const element = video.current
    if (!element) return
    setPlayBlocked(false)
    void element.play().catch(() => {
      if (element === video.current && eligibleRef.current) setPlayBlocked(true)
    })
  }, [])

  useEffect(() => {
    if (!eligible || busy || userPaused.current) return
    if (ticket && wantsPlayback.current) play()
    else if (autoPlay && !ticket && !busy && !error) void load()
  }, [eligible, ticket, autoPlay, busy, error, load, play])

  function start() {
    wantsPlayback.current = true; userPaused.current = false
    if (ticket) play()
    else void load()
  }
  function mediaError() {
    if (ticket && Date.parse(ticket.expiresAt) <= Date.now() && !retried.current) {
      retried.current = true
      position.current = video.current?.currentTime || 0
      void load(true)
    } else { setTicket(null); setError(true) }
  }
  const poster = ticket?.posterUrl || cover
  const showButton = !busy && (!ticket || playBlocked)
  return <div ref={frame} className="relative isolate flex h-full min-h-40 w-full items-center justify-center bg-black rounded-lg overflow-hidden" data-testid="product-video-player">
    {poster && <img src={poster} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-2xl opacity-60" />}
    {ticket ? <video ref={attachVideo} key={ticket.playbackUrl} src={ticket.playbackUrl} poster={ticket.posterUrl} controls playsInline preload="none" muted
      className="relative h-full w-full object-contain" aria-label="商品展示视频"
      onLoadedMetadata={event => { if (event.currentTarget === video.current) event.currentTarget.currentTime = position.current }}
      onPlay={event => { if (event.currentTarget === video.current) { userPaused.current = false; setPlayBlocked(false) } }}
      onPause={event => {
        const element = event.currentTarget
        const pending = programmaticPauses.current.get(element) || 0
        if (pending) { programmaticPauses.current.set(element, pending - 1); return }
        if (element === video.current && !element.error && !element.ended && eligibleRef.current) userPaused.current = true
      }}
      onEnded={() => { userPaused.current = true }}
      onError={event => { if (event.currentTarget === video.current) mediaError() }} />
      : poster && <img src={poster} alt="商品视频封面" className="pointer-events-none absolute inset-0 w-full h-full object-contain" />}
    {busy && <span role="status" className="absolute rounded-lg bg-black/70 px-3 py-2 text-sm text-white">正在加载视频…</span>}
    {showButton && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
      <button type="button" aria-label={error ? '视频暂不可播放，点击重试' : '播放商品视频'} onClick={start}
        className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full border border-white/60 bg-black/55 text-white shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
        {error ? <RotateCcw size={28} aria-hidden="true" /> : <Play size={30} fill="currentColor" aria-hidden="true" className="ml-1" />}
      </button>
      {error && <span role="status" className="rounded-lg bg-black/70 px-3 py-2 text-sm text-white">视频暂不可播放，可重试</span>}
    </div>}
  </div>
}
