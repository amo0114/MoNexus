import { Crown, Flag, TrendingUp, Trophy } from 'lucide-react'
import type { LeaderboardResponse } from '../../api/leaderboard'
import { fmtPoints, meGap } from './format'
import { RankDelta } from './RankRow'

/**
 * 桌面端「本期战况」统计卡：hero 行右侧，与颁奖台等高（grid items-stretch）。
 *
 * 全部指标由榜单响应就地推导，零额外请求；Apple 式呈现——小标签 + 大数值
 * （tabular-nums）+ hairline 分隔，不堆图标色块。
 * 注意：这里不得出现裸的 periodLabel 文本（头部期间徽标已展示同字串，
 * e2e 以 exact 匹配它，重复会撞严格模式）。
 */

type Stat = { icon: typeof Crown; label: string; value: string }

function deriveStats(data: LeaderboardResponse): Stat[] {
  const { top } = data
  const champion = top[0]
  const runnerUp = top[1]
  const last = top[top.length - 1]
  const stats: Stat[] = []

  const gap = meGap(data)
  if (gap) {
    stats.push(
      gap.kind === 'tied'
        ? { icon: TrendingUp, label: '与上一名', value: '同分' }
        : { icon: TrendingUp, label: gap.label, value: `${fmtPoints(gap.points)} 分` },
    )
  }
  if (champion && runnerUp) {
    stats.push({ icon: Crown, label: '榜首领先', value: `${fmtPoints(champion.points - runnerUp.points)} 分` })
  }
  if (last && last.rank > 3) {
    stats.push({ icon: Flag, label: `上榜线（第 ${last.rank} 名）`, value: `${fmtPoints(last.points)} 分` })
  }
  return stats
}

export default function StatsPanel({ data }: { data: LeaderboardResponse }) {
  const stats = deriveStats(data)
  const me = data.me

  return (
    <div className="hidden lg:flex card h-full flex-col justify-between gap-5">
      {/* 我的排名：桌面端主位（<lg 由吸底浮条 MyRankBar 承载） */}
      <div className="flex items-center gap-3" data-testid="leaderboard-me-card">
        <span className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-full bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <Trophy className="w-5 h-5" aria-hidden="true" />
        </span>
        {me ? (
          <div className="min-w-0">
            <div className="text-xs text-[var(--color-text-muted)]">我的排名</div>
            <div className="font-mono text-2xl font-bold tracking-tight text-[var(--color-text)] tabular-nums">
              第 {fmtPoints(me.rank)} 名 <RankDelta rank={me.rank} prevRank={me.prevRank} /> ·{' '}
              {fmtPoints(me.points)} 分
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="text-xs text-[var(--color-text-muted)]">我的排名</div>
            <div className="text-base font-bold text-[var(--color-text)]">
              本期暂未上榜，去签到赚积分
            </div>
          </div>
        )}
      </div>

      {stats.length > 0 && (
        <div className="divide-y divide-[var(--color-border)]">
          {stats.map((stat) => (
            <div key={stat.label} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <span className="flex items-center gap-2.5 text-sm text-[var(--color-text-muted)]">
                <stat.icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                {stat.label}
              </span>
              <span className="font-mono text-xl font-bold text-[var(--color-text)] tabular-nums">
                {stat.value}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        仅计「获得」积分，与会员等级同口径；消费不扣减名次。每日刷新，展示前 100 名。
      </p>
    </div>
  )
}
