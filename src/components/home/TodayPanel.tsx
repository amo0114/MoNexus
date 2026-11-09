import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useCheckin } from '../../hooks/useCheckin'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { CheckinCompact } from '../checkin/CheckinCard'
import PointCoin from '../ui/PointCoin'

/**
 * SPEC-ENGAGE-001 HM-01..HM-04：登录用户首页顶部的「今日」面板，替换游客 Hero。
 * 公告已由 Layout 的 AnnouncementBanner 全站展示，这里不重复。
 */
export default function TodayPanel() {
  const navigate = useNavigate()
  const points = useAuthStore(s => s.user?.points)
  const checkinState = useCheckin()

  return (
    <section
      className="card grid gap-4 md:grid-cols-[1fr_auto] md:items-center max-w-3xl mx-auto w-full"
      data-testid="today-panel"
    >
      <div className="min-w-0">
        {checkinState.status
          ? <CheckinCompact state={checkinState} />
          : !checkinState.loadFailed && <div className="h-10 rounded-lg bg-[var(--color-background)] animate-pulse" aria-hidden />}
      </div>
      <button
        type="button"
        onClick={() => {
          navigate('/profile')
          useAppStore.getState().setPointsHistoryOpen(true)
        }}
        className="flex items-center justify-between md:justify-end gap-2 md:border-l md:border-[var(--color-border)] md:pl-5 text-left cursor-pointer group"
      >
        <span>
          <span className="block text-xs text-[var(--color-text-muted)]">可用积分</span>
          <span className="flex items-center gap-1.5 font-heading text-xl font-bold text-[var(--color-text)]">
            <PointCoin className="w-5 h-5" />
            {points?.toLocaleString() ?? '--'}
          </span>
        </span>
        <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors" />
      </button>
    </section>
  )
}
