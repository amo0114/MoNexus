import { Coins, MoveDown, MoveUp, Sparkles } from 'lucide-react'
import type { LeaderboardEntry } from '../../api/leaderboard'
import { fmtPoints } from './format'
import LetterAvatar from './LetterAvatar'

/**
 * 名次变化（P3-1）：delta = prevRank - rank。
 * 上升绿 / 下降红 / 持平 – / 新入榜「新」。徽标叠在名次数字下方（两行
 * 总高仍低于 40px 头像），不抢占行内横向空间。
 */
export function RankDelta({ rank, prevRank }: { rank: number; prevRank?: number | null }) {
  if (prevRank === undefined || prevRank === null) {
    return (
      <span
        data-testid="rank-delta"
        data-delta="new"
        className="inline-flex items-center gap-0.5 text-[10px] font-bold leading-tight text-[var(--color-primary)]"
      >
        <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />新
      </span>
    )
  }
  const delta = prevRank - rank
  if (delta === 0) {
    return (
      <span data-testid="rank-delta" data-delta="0" className="text-[10px] font-bold leading-tight text-[var(--color-text-muted)]">
        –
      </span>
    )
  }
  const up = delta > 0
  const Icon = up ? MoveUp : MoveDown
  return (
    <span
      data-testid="rank-delta"
      data-delta={up ? `+${delta}` : `${delta}`}
      className={`inline-flex items-center gap-0.5 text-[10px] font-bold leading-tight ${
        up ? 'text-[var(--color-points)]' : 'text-[var(--color-danger)]'
      }`}
    >
      <Icon className="w-2.5 h-2.5" aria-hidden="true" />
      {Math.abs(delta)}
    </span>
  )
}

/**
 * 第 4 名起的行式列表；isMe 行以主题色 tint + 左侧色条高亮。
 * sm+ 时行内加「距榜首」比例条（points / 榜首 points），把宽屏行的
 * 横向空间转成信息量而不是留白。
 */
export default function RankRow({
  entry,
  meRef,
  maxPoints = 0,
}: {
  entry: LeaderboardEntry
  meRef?: (el: HTMLElement | null) => void
  maxPoints?: number
}) {
  const pct = maxPoints > 0 ? Math.max(3, Math.round((entry.points / maxPoints) * 100)) : 0

  return (
    <li
      ref={entry.isMe ? meRef : undefined}
      data-testid="leaderboard-row"
      data-me={entry.isMe || undefined}
      className={`flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-b-[var(--color-border)] last:border-b-0 border-l-[3px] transition-colors ${
        entry.isMe
          ? 'border-l-[var(--color-primary)] bg-[var(--color-primary-tint)] hover:bg-[var(--color-primary-tint-strong)]'
          : 'border-l-transparent hover:bg-[var(--color-primary-tint)]'
      }`}
    >
      <span className="w-8 shrink-0 flex flex-col items-center justify-center gap-0.5">
        <span className="font-mono text-sm font-bold leading-tight text-[var(--color-text-muted)] tabular-nums">
          {entry.rank}
        </span>
        <RankDelta rank={entry.rank} prevRank={entry.prevRank} />
      </span>
      <LetterAvatar name={entry.displayName} className="w-10 h-10 shrink-0 text-base" />
      <span
        className={`min-w-0 truncate text-sm flex-1 sm:flex-none sm:w-36 lg:w-48 ${
          entry.isMe ? 'font-bold text-[var(--color-primary)]' : 'font-medium text-[var(--color-text)]'
        }`}
        title={entry.displayName}
      >
        {entry.displayName}
      </span>
      {pct > 0 && (
        <span className="hidden sm:flex flex-1 items-center" aria-hidden="true">
          {/* isMe 行底色 = primary-tint，轨道需深一档才不会融进去 */}
          <span
            className={`h-1.5 w-full rounded-full overflow-hidden ${
              entry.isMe ? 'bg-[var(--color-primary-tint-strong)]' : 'bg-[var(--color-primary-tint)]'
            }`}
          >
            <span
              className="block h-full rounded-full"
              style={{
                width: `${pct}%`,
                background: 'linear-gradient(90deg, var(--color-primary), var(--color-primary-hover))',
              }}
            />
          </span>
        </span>
      )}
      {entry.isMe && (
        <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-primary-tint-strong)] text-[var(--color-primary)]">
          我
        </span>
      )}
      <span className="shrink-0 flex items-center gap-1 text-[var(--color-points)]">
        <Coins className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="font-mono text-sm font-bold tabular-nums">{fmtPoints(entry.points)}</span>
      </span>
    </li>
  )
}
