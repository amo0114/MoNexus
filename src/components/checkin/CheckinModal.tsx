import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ChevronRight, Flame, X } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { hasStreakDetails } from '../../api/checkin'
import type { useCheckin } from '../../hooks/useCheckin'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { DialogOverlay } from '../ui/Dialog'
import PointCoin from '../ui/PointCoin'
import CheckinCard, { CheckinButton, streakHint } from './CheckinCard'

type CheckinState = ReturnType<typeof useCheckin>

/**
 * 全局轻量签到弹窗：桌面端居中卡片，移动端（<sm）采用底部抽屉（Bottom Sheet）并适配安全区，
 * 顶部融合连签状态、可用积分与一键签到按钮，避免重复标题与多余说明文字。
 */
export default function CheckinModal({
  open,
  onOpenChange,
  state,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: CheckinState
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const points = useAuthStore((s) => s.user?.points)
  const setPointsHistoryOpen = useAppStore((s) => s.setPointsHistoryOpen)
  const inProfile = location.pathname.startsWith('/profile')
  const hasDetails = hasStreakDetails(state.status)
  const titleText = hasDetails && state.status ? streakHint(state.status) : '每日签到'

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-testid="checkin-modal"
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] w-full flex-col rounded-t-2xl border-t border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl focus-visible:outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[min(85dvh,760px)] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
        >
          {/* Mobile bottom-sheet grabber */}
          <div className="flex justify-center pt-2.5 pb-1 sm:hidden shrink-0" aria-hidden="true">
            <span className="h-1 w-10 rounded-full bg-[var(--color-border)]" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-5 sm:py-3.5 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[var(--color-warning)]">
                <Flame className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <DialogPrimitive.Title className="font-heading text-base font-bold text-[var(--color-text)] truncate">
                  {titleText}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="sr-only">
                  每日签到领积分、查看连签里程碑与补签记录
                </DialogPrimitive.Description>
              </div>
            </div>
            <DialogPrimitive.Close
              aria-label="关闭签到窗口"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-background)] hover:text-[var(--color-text)] cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
            >
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>

          {/* Scrollable Body */}
          <div className="flex-1 overflow-y-auto overscroll-y-contain px-4 py-4 sm:px-5 space-y-4">
            {/* Balance + primary check-in CTA */}
            <div className="flex flex-col gap-3 rounded-xl border border-[color-mix(in_srgb,var(--color-border)_80%,transparent)] bg-[var(--color-background)] p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false)
                  navigate('/profile')
                  setPointsHistoryOpen(true)
                }}
                className="flex items-center justify-between gap-2 text-left cursor-pointer group sm:justify-start"
              >
                <div>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">可用积分</span>
                  <span className="mt-0.5 flex items-center gap-1.5 font-heading text-lg font-bold text-[var(--color-text)]">
                    <PointCoin className="h-4 w-4 shrink-0" />
                    <span className="tabular-nums">{points != null ? points.toLocaleString('zh-CN') : '--'}</span>
                  </span>
                </div>
                <ChevronRight className="h-4 w-4 text-[var(--color-text-muted)] transition-colors group-hover:text-[var(--color-primary)]" />
              </button>

              <CheckinButton state={state} className="w-full sm:w-auto sm:min-w-[128px]" />
            </div>

            {state.loadFailed && !state.status ? (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4 text-center space-y-3">
                <p className="text-sm text-[var(--color-text-muted)]">签到状态加载失败，请稍后重试</p>
                <button
                  type="button"
                  onClick={() => void state.refresh()}
                  className="btn-secondary min-h-11 px-4 text-xs"
                >
                  重新加载
                </button>
              </div>
            ) : hasDetails ? (
              <CheckinCard state={state} embedded />
            ) : !state.status ? (
              <div className="h-36 rounded-xl bg-[var(--color-background)] animate-pulse" aria-hidden="true" />
            ) : null}
          </div>

          {/* Footer */}
          <div className="shrink-0 border-t border-[var(--color-border)] px-4 py-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-2.5">
            {!inProfile ? (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false)
                  navigate('/profile#checkin')
                }}
                className="flex min-h-11 w-full items-center justify-center gap-1 rounded-xl text-xs font-semibold text-[var(--color-primary)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] cursor-pointer"
              >
                前往个人中心查看签到与积分明细
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <DialogPrimitive.Close className="btn-secondary min-h-11 w-full text-xs">
                完成
              </DialogPrimitive.Close>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
