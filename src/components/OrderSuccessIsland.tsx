import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Clock, X } from 'lucide-react'
import { type IslandNotice, useAppStore } from '../stores/appStore'
import { useMediaQuery } from '../hooks/useMediaQuery'
import HeartBurst from './ui/HeartBurst'
import './OrderSuccessIsland.css'

export type OrderIslandPhase = 'processing' | 'confirmed' | 'details'

interface Props {
  notice: IslandNotice | null
  obscured: boolean
  onOpenChange: (open: boolean) => void
  onHeightChange: (height: number) => void
  onPhaseChange: (phase: OrderIslandPhase) => void
}

/** Keep the outgoing content mounted while the navbar returns to its resting size. */
export default function OrderSuccessIsland({ notice, obscured, onOpenChange, onHeightChange, onPhaseChange }: Props) {
  const clearNotice = useAppStore((s) => s.clearIslandNotice)
  const [content, setContent] = useState<IslandNotice | null>(null)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [phase, setPhase] = useState<OrderIslandPhase>('processing')
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const remaining = useRef(0)
  const layerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (notice) setPhase('processing')
  }, [notice?.id])

  useLayoutEffect(() => onPhaseChange(phase), [phase, onPhaseChange])

  useLayoutEffect(() => {
    if (phase !== 'details') {
      onHeightChange(112)
      return
    }
    const panel = panelRef.current
    if (!panel) return
    // Measure the natural content, never the animated shell. Long names and
    // larger text can grow vertically without moving the document beneath it.
    const measure = () => onHeightChange(Math.ceil(panel.getBoundingClientRect().height) + 2)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [content, phase, onHeightChange])

  useLayoutEffect(() => {
    if (notice) setContent(notice)
    if (!notice || obscured) {
      setOpen(false)
      onOpenChange(false)
      return
    }
    // Commit the resting geometry first, then transition the same shell.
    let secondFrame = 0
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        setOpen(true)
        onOpenChange(true)
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(secondFrame)
    }
  }, [notice, obscured, onOpenChange])

  useEffect(() => {
    if (!open || obscured || reducedMotion || phase !== 'processing' || notice?.kind !== 'order_success') return
    // The animation event normally advances at the next revolution. If CSS or
    // the browser suppresses that event, an already accepted order must still
    // reach its details. Never use this clock to infer a server-side success.
    const spinMs = parseFloat(getComputedStyle(layerRef.current!).getPropertyValue('--order-island-spin'))
    const timer = window.setTimeout(() => setPhase('confirmed'), (Number.isFinite(spinMs) && spinMs > 0 ? spinMs : 800) * 2)
    return () => window.clearTimeout(timer)
  }, [notice, open, obscured, phase, reducedMotion])

  useEffect(() => {
    if (!open || obscured || notice?.kind !== 'order_success') return
    if (reducedMotion) {
      setPhase('details')
      return
    }
    if (phase !== 'confirmed') return
    const duration = parseFloat(getComputedStyle(layerRef.current!).getPropertyValue('--order-island-confirm'))
    const timer = window.setTimeout(() => setPhase('details'), duration)
    return () => window.clearTimeout(timer)
  }, [notice, open, obscured, phase, reducedMotion])

  useEffect(() => {
    remaining.current = notice?.durationMs ?? 7000
    setHovered(false)
    setFocused(false)
  }, [notice?.id, notice?.durationMs])

  useEffect(() => {
    if (!notice || phase !== 'details' || !open || obscured || hovered || focused) return
    const startedAt = Date.now()
    const timer = window.setTimeout(() => clearNotice(notice.id), remaining.current)
    return () => {
      window.clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt))
    }
  }, [notice, phase, open, obscured, hovered, focused, clearNotice])

  useEffect(() => {
    if (notice) return
    // Read the CSS clock so cleanup and the exit transition cannot drift apart.
    const duration = reducedMotion ? 0 : parseFloat(
      getComputedStyle(layerRef.current!).getPropertyValue('--order-island-close'),
    )
    const timer = window.setTimeout(() => setContent(null), duration)
    return () => window.clearTimeout(timer)
  }, [notice, reducedMotion])

  const pending = content?.type === 'info'
  const detailsVisible = open && phase === 'details'

  return (
    <div
      ref={layerRef}
      className="order-island-layer"
      data-open={open}
      data-phase={phase}
      aria-hidden={!open}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') setHovered(true) }}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && detailsVisible && content) clearNotice(content.id)
      }}
    >
      <span className="sr-only" role="status" aria-atomic="true">
        {open ? phase === 'details' ? `${content?.title}，${content?.subtitle ?? ''}`
          : phase === 'confirmed' ? (content?.payload?.renewal ? '续费订单已创建' : '下单成功') : (content?.payload?.renewal ? '正在提交续费' : '正在确认支付') : ''}
      </span>
      {content && (
        <>
          <div className="order-island-payment" aria-hidden="true">
            <span className="order-island-payment-halo" />
            <span className="order-island-payment-mark">
              <svg className="order-island-payment-symbol" viewBox="0 0 64 64" fill="none">
                <circle className="order-island-ring-track" cx="32" cy="32" r="24" />
                <g className="order-island-spinner" onAnimationIteration={() => {
                  // Finish the current revolution only after the server accepts the order.
                  if (notice?.kind === 'order_success' && open && !obscured) setPhase('confirmed')
                }}>
                  <circle className="order-island-ring" cx="32" cy="32" r="24" pathLength="1" />
                </g>
                <path className="order-island-payment-check" d="m21 32 8 8 15-16" pathLength="1" />
              </svg>
            </span>
            <HeartBurst distance={40} delay={160} color="currentColor" />
          </div>
          <div className="order-island-panel" ref={panelRef} aria-hidden={!detailsVisible}>
            <div className="order-island-header">
              <span className="order-island-icon" data-pending={pending} data-animate={detailsVisible} aria-hidden="true" key={content.id}>
                <span className="order-island-icon-halo" />
                <span className="order-island-icon-face">
                  {pending ? <Clock size={19} /> : (
                    <svg className="order-island-check" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m20 6-11 11-5-5" pathLength="1" />
                    </svg>
                  )}
                </span>
                {pending ? (
                  <span className="order-island-orbit">
                    <svg viewBox="0 0 44 44" fill="none">
                      <circle cx="22" cy="22" r="20" pathLength="1" />
                    </svg>
                  </span>
                ) : <HeartBurst distance={29} delay={340} color="currentColor" />}
              </span>
              <span className="order-island-copy">
                <strong>{content.title || '兑换成功'}</strong>
                <span title={content.subtitle}>{content.subtitle}</span>
              </span>
              <button
                type="button"
                className="order-island-dismiss"
                aria-label={content.payload?.renewal ? '收起续费提示' : '收起兑换提示'}
                tabIndex={detailsVisible ? 0 : -1}
                disabled={!detailsVisible}
                onClick={() => clearNotice(content.id)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="order-island-footer">
              <span>{pending ? '可在订单中查看进度' : '内容已保存至订单'}</span>
              <button
                type="button"
                className="order-island-action"
                data-testid="order-success-island"
                tabIndex={detailsVisible ? 0 : -1}
                disabled={!detailsVisible}
                onClick={() => {
                  if (useAppStore.getState().islandNotice?.id !== content.id) return
                  clearNotice(content.id)
                  content.onAction?.()
                }}
              >
                {content.actionLabel || '查看订单'}<ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
