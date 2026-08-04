import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useAppStore, type Toast as ToastItem } from '../stores/appStore'

/**
 * Toast 2.2 — iOS 横幅感分级通知（移动端顶部下挂 / 桌面右下）。
 *
 * 移动端为什么搬到顶部：底部是 chrome 密集区（Tab Bar、吸底排名条、
 * 购买条），toast 混在其中容易被忽略；顶部下挂是 iOS 横幅 / 微信小程序
 * 的共同惯例，落在视线焦点区，也不再需要避让底部导航的公式。
 *
 * iOS 通知感三要素：22px 大圆角 + 磨砂玻璃（84% surface + backdrop-blur
 * saturate）+ 弹簧进场（overshoot 曲线）；支持上滑甩走关闭（桌面端为下拽）。
 *
 * 移动端宽度内容自适应（w-fit 紧凑胶囊）：短消息「兑换成功」不再撑一条
 * 343px 长条留大片空白；长消息 max-w 封顶后 line-clamp-2 两行 + title 兜底。
 * 桌面端维持 22rem 统一宽度（右下叠放右缘对齐）。
 *
 * 重要性分级（不同类型的弹窗不同的效果）：
 * - assertive（error/warning）：卡片染色调 tint 底 + 色调描边，一眼可辨；
 *   error 用 role="alert"（assertive live region，打断式播报）并配更弹的
 *   进场曲线 + 更长停留（4.5s）。不弹窗、不遮罩——注意到，但不打断操作。
 * - quiet（success/info）：中性磨砂卡，role="status"（polite）。
 *
 * 通用：同文同型去重、最多 3 条（appStore.showToast）；hover 暂停倒计时。
 */

type Tone = ToastItem['type']

/**
 * A card-level pointer capture is needed for the swipe-to-dismiss gesture,
 * but it must never capture a press that started on an interactive child.
 * Capturing a close-button press retargets its subsequent pointer/click events
 * to the card, so the button's onClick would not fire.
 */
function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element
    && target.closest('button, a, input, textarea, select, [role="button"]') !== null
}

const TONE: Record<Tone, { token: string; label: string; icon: typeof CheckCircle2 }> = {
  success: { token: 'var(--color-toast-success)', label: '成功', icon: CheckCircle2 },
  error: { token: 'var(--color-toast-error)', label: '错误', icon: XCircle },
  info: { token: 'var(--color-toast-info)', label: '提示', icon: Info },
  warning: { token: 'var(--color-toast-warning)', label: '注意', icon: AlertTriangle },
}

const DURATION: Record<Tone, number> = {
  error: 4500, // 错误带失败细节，多停留一拍
  success: 3000,
  info: 3000,
  warning: 4000,
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const removeToast = useAppStore((s) => s.removeToast)
  const [leaving, setLeaving] = useState(false)
  // 进场动画 fill:forwards 会压过 inline transform——播完即卸掉动画类，
  // 上滑关闭手势才能直接改写 style.transform。
  const [entered, setEntered] = useState(false)
  const progressRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; dy: number; dismissDir: 1 | -1 } | null>(null)

  const duration = DURATION[toast.type]
  const assertive = toast.type === 'error' || toast.type === 'warning'

  // Auto-dismiss；hover 时暂停计时（错误详情可能被抄写）。
  useEffect(() => {
    let remaining = duration
    let startedAt = Date.now()
    let timer = setTimeout(() => setLeaving(true), remaining)

    const card = progressRef.current?.closest('[data-toast-card]')
    const pause = () => {
      clearTimeout(timer)
      remaining -= Date.now() - startedAt
      progressRef.current?.style.setProperty('animation-play-state', 'paused')
    }
    const resume = () => {
      startedAt = Date.now()
      timer = setTimeout(() => setLeaving(true), remaining)
      progressRef.current?.style.setProperty('animation-play-state', 'running')
    }
    card?.addEventListener('pointerenter', pause)
    card?.addEventListener('pointerleave', resume)
    return () => {
      clearTimeout(timer)
      card?.removeEventListener('pointerenter', pause)
      card?.removeEventListener('pointerleave', resume)
    }
  }, [toast.id, duration])

  // 先播退出动画再移出 store。
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => removeToast(toast.id), 180)
    return () => clearTimeout(timer)
  }, [leaving, toast.id, removeToast])

  // 滑走关闭（iOS 横幅手势）：移动端向上甩、桌面端向下拽；
  // 跟随手指，过 48px 阈值或快速甩动即解散，否则回弹。
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || isInteractiveTarget(e.target)) return
    const dismissDir = window.matchMedia('(min-width: 768px)').matches ? 1 : -1
    drag.current = { startY: e.clientY, dy: 0, dismissDir }
    cardRef.current?.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !cardRef.current) return
    const raw = e.clientY - d.startY
    // 只跟随关闭方向的位移，反方向给 1/4 阻尼
    const dy = raw * d.dismissDir > 0 ? raw : raw * 0.25
    d.dy = dy
    cardRef.current.style.transition = 'none'
    cardRef.current.style.transform = `translateY(${dy}px)`
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || !cardRef.current) return
    const dismissDistance = d.dy * d.dismissDir
    if (dismissDistance > 48) {
      setLeaving(true)
      return
    }
    cardRef.current.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
    cardRef.current.style.transform = ''
  }

  const { token, label, icon: Icon } = TONE[toast.type]

  return (
    <div
      ref={cardRef}
      data-toast-card
      role={toast.type === 'error' ? 'alert' : 'status'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onAnimationEnd={(e) => {
        if (e.target === cardRef.current && e.animationName.startsWith('toastIn')) setEntered(true)
      }}
      className={`${leaving ? 'toast-exit' : entered ? '' : assertive ? 'toast-enter-assertive' : 'toast-enter'}
        pointer-events-auto relative overflow-hidden touch-pan-x
        w-fit max-w-full md:w-full rounded-[22px] border shadow-[var(--shadow-xl)]
        backdrop-blur-md backdrop-saturate-150`}
      style={
        assertive
          ? {
              background: `color-mix(in srgb, ${token} 10%, color-mix(in srgb, var(--color-surface) 84%, transparent))`,
              borderColor: `color-mix(in srgb, ${token} 38%, var(--color-border))`,
            }
          : {
              background: 'color-mix(in srgb, var(--color-surface) 84%, transparent)',
              borderColor: 'var(--color-border)',
            }
      }
    >
      <div className="flex items-center gap-2.5 pl-3 pr-2 py-2">
        <span
          aria-hidden="true"
          className="inline-flex w-7 h-7 shrink-0 items-center justify-center rounded-full"
          style={{ color: token, background: `color-mix(in srgb, ${token} 12%, transparent)` }}
        >
          <Icon className="w-4 h-4" />
        </span>
        {/* role=status/alert 播报的是内容文本：类型前缀走 sr-only，不能
            aria-label 覆盖容器（否则只读出"成功"而丢了正文）。 */}
        <span
          title={toast.message}
          className="min-w-0 text-sm font-medium leading-snug text-[var(--color-text)] line-clamp-2 break-words"
        >
          <span className="sr-only">{label}：</span>
          {toast.message}
        </span>
        <button
          type="button"
          // Keep the parent swipe handler from capturing this button's pointer.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setLeaving(true)}
          aria-label="关闭提示"
          className="icon-btn -my-1 -mr-0.5 ml-0.5 p-1 rounded-full shrink-0 text-[var(--color-text-muted)]
            hover:text-[var(--color-text)] hover:bg-[var(--color-primary-tint)] transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* 倒计时进度条：传达自动消失时机；纯装饰，不动态播报 */}
      <span
        ref={progressRef}
        aria-hidden="true"
        className="toast-progress absolute bottom-0 left-0 h-[2px] w-full origin-left"
        style={{ background: token, animationDuration: `${duration}ms` }}
      />
    </div>
  )
}

export default function Toast() {
  const toasts = useAppStore((s) => s.toasts)

  return (
    // <md：紧贴 Layout 测得的实时 navbar 下缘；compact / notice / search
    // 状态都共享同一条基线，而不是把旧的 77px header 高度硬编码进 Toast。
    // ≥md：右下角，最新贴屏幕底缘。
    <div
      className="fixed z-[80] flex pointer-events-none
        top-[calc(var(--navbar-current-h)+0.5rem)] left-1/2 -translate-x-1/2
        w-[calc(100vw-2rem)] max-w-[26rem] flex-col-reverse items-center gap-2
        md:top-auto md:bottom-6 md:right-6 md:left-auto md:translate-x-0
        md:w-[22rem] md:max-w-none md:flex-col md:items-end"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}
