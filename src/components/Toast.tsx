import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useAppStore, type Toast as ToastItem } from '../stores/appStore'

/**
 * Toast 2.0 — 轻巧 surface 卡片取代实心彩条：
 * - 色调由 icon chip（12% tint 底 + 深色阶图标）与 2px 倒计时进度条承载，
 *   正文落在 --color-text / --color-surface 上，对比度天然 ≥12:1；
 *   图标色阶三主题实测 ≥4.5:1（旧实心彩条的白字方案是为兜底 token 对比度，
 *   新结构把「色调」与「可读性」解耦后不再需要）。
 * - 宽度 w-fit + 22rem 上限：短消息紧凑，长消息两行封顶（line-clamp-2），
 *   全文经 title 兜底；图标 items-start 顶对齐，多行不再吊在中央。
 * - 位置：<md 底部居中（避让 Tab Bar，同旧公式）；≥md 右下角，不挡内容中轴。
 * - 同文同型去重、最多 3 条（见 appStore.showToast）。
 */

type Tone = ToastItem['type']

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
  warning: 3000,
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const removeToast = useAppStore((s) => s.removeToast)
  const [leaving, setLeaving] = useState(false)
  const progressRef = useRef<HTMLSpanElement>(null)

  const duration = DURATION[toast.type]

  // Auto-dismiss；hover 时暂停计时（错误详情可能被抄写）。
  useEffect(() => {
    let remaining = duration
    let startedAt = Date.now()
    let timer = setTimeout(function tick() {
      setLeaving(true)
    }, remaining)

    const card = progressRef.current?.closest('[role="status"]')
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

  const { token, label, icon: Icon } = TONE[toast.type]

  return (
    <div
      role="status"
      className={`${leaving ? 'toast-exit' : 'toast-enter'} pointer-events-auto relative overflow-hidden
        w-full rounded-2xl border border-[var(--color-border)]
        bg-[var(--color-surface)] shadow-[var(--shadow-xl)]`}
    >
      <div className="flex items-start gap-2.5 pl-3 pr-2 py-2.5">
        <span
          aria-hidden="true"
          className="mt-px inline-flex w-7 h-7 shrink-0 items-center justify-center rounded-full"
          style={{ color: token, background: `color-mix(in srgb, ${token} 12%, transparent)` }}
        >
          <Icon className="w-4 h-4" />
        </span>
        {/* role=status 播报的是内容文本：类型前缀走 sr-only，不能 aria-label
            覆盖容器（否则只读出"成功"而丢了正文）。 */}
        <span
          title={toast.message}
          className="min-w-0 pt-1 text-sm font-medium leading-snug text-[var(--color-text)] line-clamp-2 break-words"
        >
          <span className="sr-only">{label}：</span>
          {toast.message}
        </span>
        <button
          type="button"
          onClick={() => setLeaving(true)}
          aria-label="关闭提示"
          className="icon-btn ml-0.5 -mr-0.5 -mt-1 p-1 rounded-lg shrink-0 text-[var(--color-text-muted)]
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
    // 统一宽度（sonner 式）：叠放多条时左缘整齐，长消息吃满允许宽度、
    // 两行内展示更多字符。<md: 底部居中，sit above the BottomTabBar
    // (56px + safe-area + gap) so toasts never cover or get covered by
    // primary navigation；≥md: 右下角 22rem 固定宽。
    <div
      className="fixed z-[80] flex flex-col gap-2 pointer-events-none
        bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+0.75rem)] left-1/2 -translate-x-1/2
        w-[calc(100vw-2rem)] max-w-[24rem]
        md:bottom-6 md:right-6 md:left-auto md:translate-x-0 md:w-[22rem] md:max-w-none"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}
