import { Coins } from 'lucide-react'
import type { LeaderboardEntry } from '../../api/leaderboard'
import LetterAvatar from './LetterAvatar'

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
      className={`flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-b-[var(--color-border)] last:border-b-0 border-l-[3px] ${
        entry.isMe
          ? 'border-l-[var(--color-primary)] bg-[var(--color-primary-tint)]'
          : 'border-l-transparent'
      }`}
    >
      <span className="w-8 shrink-0 text-center font-mono text-sm font-bold text-[var(--color-text-muted)] tabular-nums">
        {entry.rank}
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
          <span className="h-1.5 w-full rounded-full bg-[var(--color-primary-tint)] overflow-hidden">
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
      <span className="shrink-0 flex items-center gap-1 text-[var(--color-cta)]">
        <Coins className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="font-mono text-sm font-bold tabular-nums">{entry.points}</span>
      </span>
    </li>
  )
}
