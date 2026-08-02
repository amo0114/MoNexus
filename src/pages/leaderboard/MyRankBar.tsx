import { Trophy } from 'lucide-react'
import type { LeaderboardMe } from '../../api/leaderboard'

/**
 * 「我的排名」吸底条。
 *
 * 始终挂在 DOM 上（自己已在可视区时只做视觉隐藏），这样 leaderboard-me
 * 契约稳定、可断言；隐藏态以 data-hidden 暴露，形制同 BottomTabBar。
 * 移动端避让 Tab Bar 高度 + safe-area（同 Toast 的预留公式）。
 *
 * 注意：本条为 position: fixed，调用方不得把它放进带 transform 的祖先
 * （如 .fade-in），否则包含块被改写、吸底失效（见 ProductDetailPage 注释）。
 */
export default function MyRankBar({ me, hidden }: { me: LeaderboardMe | null; hidden: boolean }) {
  return (
    <div
      data-testid="leaderboard-me"
      data-hidden={hidden || undefined}
      aria-hidden={hidden || undefined}
      className={`fixed inset-x-0 z-30 px-4 pointer-events-none transition-all duration-300
        bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+0.75rem)] md:bottom-6 ${
          hidden ? 'opacity-0 translate-y-3' : 'opacity-100 translate-y-0'
        }`}
      style={{ transitionTimingFunction: 'var(--ease-standard)' }}
    >
      <div className="max-w-3xl mx-auto flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-lg">
        <span className="w-9 h-9 shrink-0 inline-flex items-center justify-center rounded-full bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <Trophy className="w-4 h-4" aria-hidden="true" />
        </span>
        {me ? (
          <div className="min-w-0 flex-1">
            <div className="text-xs text-[var(--color-text-muted)]">我的排名</div>
            <div className="text-sm font-bold text-[var(--color-text)]">
              第 {me.rank} 名 · {me.points} 分
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1 text-sm font-medium text-[var(--color-text)]">
            本期暂未上榜，去签到赚积分
          </div>
        )}
      </div>
    </div>
  )
}
