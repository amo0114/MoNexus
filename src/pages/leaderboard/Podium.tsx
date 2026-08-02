import { Coins, Crown } from 'lucide-react'
import type { LeaderboardEntry } from '../../api/leaderboard'
import { initialOf } from './LetterAvatar'

type Medal = 1 | 2 | 3

const RING_CLASS: Record<Medal, string> = {
  1: 'podium-gold',
  2: 'podium-silver',
  3: 'podium-bronze',
}

/** 徽标为固定金属色板 + 深色字：对比度不依赖主题（spec §5.3）。 */
const BADGE_STYLE: Record<Medal, React.CSSProperties> = {
  1: { background: 'linear-gradient(135deg, #FDE68A 0%, #F59E0B 100%)', color: '#4A2B00' },
  2: { background: 'linear-gradient(135deg, #F8FAFC 0%, #B6BECB 100%)', color: '#33383F' },
  3: { background: 'linear-gradient(135deg, #EBC49A 0%, #C87F45 100%)', color: '#3D2210' },
}

function PodiumSpot({
  entry,
  medal,
  meRef,
}: {
  entry: LeaderboardEntry
  medal: Medal
  meRef?: (el: HTMLElement | null) => void
}) {
  const first = medal === 1

  return (
    <div
      ref={entry.isMe ? meRef : undefined}
      data-testid={`leaderboard-podium-${medal}`}
      data-me={entry.isMe || undefined}
      className={`flex flex-col items-center min-w-0 ${
        // 第一名整列垫高（约 20%），与 items-end 一起构成 2-1-3 颁奖台
        first ? 'w-[6.5rem] sm:w-32 lg:w-36 mb-6' : 'w-[5.5rem] sm:w-28 lg:w-32'
      }`}
    >
      <div className={`relative ${first ? 'podium-float' : ''}`}>
        {first && (
          <Crown
            aria-hidden="true"
            className="absolute -top-5 lg:-top-6 left-1/2 -translate-x-1/2 w-6 h-6 lg:w-7 lg:h-7"
            style={{ color: '#B45309', fill: '#FDE68A' }}
          />
        )}
        <div
          className={`podium-ring ${RING_CLASS[medal]} ${
            first ? 'w-20 h-20 lg:w-[88px] lg:h-[88px]' : 'w-16 h-16 lg:w-[72px] lg:h-[72px]'
          }`}
        >
          <span className="podium-ring-metal" aria-hidden="true" />
          <span
            className={`podium-ring-face ${first ? 'text-[26px] lg:text-[30px]' : 'text-[21px] lg:text-2xl'}`}
            aria-hidden="true"
          >
            {initialOf(entry.displayName)}
          </span>
        </div>
        <span className="podium-rank-badge" style={BADGE_STYLE[medal]}>
          {medal}
        </span>
      </div>

      <div
        className="mt-4 w-full truncate text-center text-xs sm:text-sm lg:text-base font-bold text-[var(--color-text)]"
        title={entry.displayName}
      >
        {entry.displayName}
      </div>
      <div className="mt-1 flex items-center gap-1 text-[var(--color-cta)]">
        <Coins className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="font-mono text-sm lg:text-base font-bold">{entry.points}</span>
      </div>
      {entry.isMe && (
        <span className="mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-primary-tint-strong)] text-[var(--color-primary)]">
          我
        </span>
      )}
    </div>
  )
}

/** 2-1-3 颁奖台。不足 3 人时只渲染已有名次，布局仍居中。 */
export default function Podium({
  top,
  meRef,
}: {
  top: LeaderboardEntry[]
  meRef?: (el: HTMLElement | null) => void
}) {
  const [first, second, third] = top

  return (
    <div
      data-testid="leaderboard-podium"
      className="card flex items-end justify-center gap-2 sm:gap-5 lg:gap-6 px-4 pt-9 pb-6 sm:px-6 lg:pt-12 lg:pb-8"
    >
      {second && <PodiumSpot entry={second} medal={2} meRef={meRef} />}
      {first && <PodiumSpot entry={first} medal={1} meRef={meRef} />}
      {third && <PodiumSpot entry={third} medal={3} meRef={meRef} />}
    </div>
  )
}
