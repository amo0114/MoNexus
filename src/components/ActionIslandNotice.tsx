import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bell, ChevronRight, Coins, X } from 'lucide-react'
import { type IslandNotice, useAppStore } from '../stores/appStore'
import { useMediaQuery } from '../hooks/useMediaQuery'
import './QuietIslandNotice.css'
import './ActionIslandNotice.css'

interface Props {
  notice: IslandNotice | null
  suppressed: boolean
  onVisibleChange: (visible: boolean) => void
}

/** Actionable, non-transactional feedback. Never changes the document lane. */
export default function ActionIslandNotice({ notice, suppressed, onVisibleChange }: Props) {
  const [content, setContent] = useState<IslandNotice | null>(null)
  const [interacting, setInteracting] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [foreground, setForeground] = useState(document.visibilityState === 'visible')
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const panelRef = useRef<HTMLDivElement>(null)
  const pointerInside = useRef(false)
  const remaining = useRef(8000)
  const presented = useRef(new WeakSet<IslandNotice>())
  const open = Boolean(notice) && !suppressed

  // Mount the empty live region before inserting text, including the first result.
  useEffect(() => {
    setAnnouncement(open && foreground ? [notice?.title, notice?.subtitle].filter(Boolean).join('，') : '')
  }, [notice, open, foreground])

  useLayoutEffect(() => {
    if (suppressed) {
      pointerInside.current = false
      setInteracting(false)
      setContent(null)
      onVisibleChange(false)
      return
    }
    if (notice) {
      setContent(notice)
      onVisibleChange(true)
      return
    }
    const timer = window.setTimeout(() => {
      setContent(null)
      onVisibleChange(false)
    }, reducedMotion ? 0 : 250)
    return () => window.clearTimeout(timer)
  }, [notice, suppressed, reducedMotion, onVisibleChange])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel || !content || suppressed) return
    const measure = () => {
      document.documentElement.style.setProperty('--action-island-bottom', `calc(var(--safe-top) + ${12 + panel.offsetHeight}px)`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--action-island-bottom')
    }
  }, [content, suppressed])

  useEffect(() => {
    const update = () => setForeground(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    if (!notice || !open || !foreground || presented.current.has(notice)) return
    presented.current.add(notice)
    notice.onPresented?.()
  }, [notice, open, foreground])

  useEffect(() => {
    remaining.current = notice?.durationMs ?? 8000
    if (!notice) pointerInside.current = false
    setInteracting(pointerInside.current || Boolean(panelRef.current?.contains(document.activeElement)))
  }, [notice?.id, notice?.durationMs])

  useEffect(() => {
    if (!notice || !open || !foreground || interacting) return
    const start = Date.now()
    const timer = window.setTimeout(() => useAppStore.getState().clearIslandNotice(notice.id), remaining.current)
    return () => {
      window.clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (Date.now() - start))
    }
  }, [notice, open, foreground, interacting])

  const dismiss = () => {
    if (!content) return
    if (useAppStore.getState().islandNotice?.id !== content.id) return
    useAppStore.getState().clearIslandNotice(content.id)
    content.onDismiss?.()
  }
  const act = () => {
    if (!content) return
    if (useAppStore.getState().islandNotice?.id !== content.id) return
    useAppStore.getState().clearIslandNotice(content.id)
    content.onAction?.()
  }
  return <>
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</span>
    {content && !suppressed && (
    <div className="action-island-layer" data-open={open} aria-hidden={!open}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') { pointerInside.current = true; setInteracting(true) } }}
      onPointerLeave={() => { pointerInside.current = false; if (!panelRef.current?.contains(document.activeElement)) setInteracting(false) }}
      onFocusCapture={() => setInteracting(true)}
      onKeyDown={(event) => { if (event.key === 'Escape') dismiss() }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setInteracting(pointerInside.current) }}>
      <div ref={panelRef} className="action-island-panel" data-testid="action-island-notice">
        <div className="flex items-start gap-2.5">
          <span className="action-island-icon" aria-hidden="true">{content.kind === 'points' ? <Coins size={20} /> : <Bell size={20} />}</span>
          <div className="action-island-copy flex-1 min-w-0 pt-1">
            <strong className="block text-sm leading-5">{content.title}</strong>
            {content.subtitle && <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)] line-clamp-2">{content.subtitle}</p>}
          </div>
          <button className="action-island-dismiss" type="button" aria-label="收起通知" disabled={!open} tabIndex={open ? 0 : -1} onClick={dismiss}><X size={16} aria-hidden="true" /></button>
        </div>
        {content.onAction && <button className="action-island-action" type="button" disabled={!open} tabIndex={open ? 0 : -1} onClick={act}>
          <span>{content.actionLabel || '查看详情'}</span><ChevronRight size={15} aria-hidden="true" />
        </button>}
      </div>
    </div>
    )}
  </>
}
