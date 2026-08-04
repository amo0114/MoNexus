import { Coins, Crown } from 'lucide-react'
import type { LeaderboardEntry } from '../../api/leaderboard'
import { fmtPoints } from './format'
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
      {/* 颁奖台不在列表结构里：视觉名次徽标 aria-hidden，名次上下文由这里补齐 */}
      <span className="sr-only">第 {medal} 名</span>
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
        <span className="podium-rank-badge" style={BADGE_STYLE[medal]} aria-hidden="true">
          {medal}
        </span>
      </div>

      <div
        className="mt-4 w-full truncate text-center text-xs sm:text-sm lg:text-base font-bold text-[var(--color-text)]"
        title={entry.displayName}
      >
        {entry.displayName}
      </div>
      <div className="mt-1 flex items-center gap-1 text-[var(--color-points)]">
        <Coins className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="font-mono text-sm lg:text-base font-bold tabular-nums">{fmtPoints(entry.points)}</span>
      </div>
      {entry.isMe && (
        <span className="mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-primary-tint-strong)] text-[var(--color-primary)]">
          我
        </span>
      )}
    </div>
  )
}

/**
 * 缺席名次仍保留在颁奖台中：2 名用户时必须是完整的 2-1-3，而不是
 * 只有 2-1 两列。这样既不会误导名次，也给新用户一个明确的上榜激励。
 */
function PodiumVacancy({ medal }: { medal: Medal }) {
  const first = medal === 1

  return (
    <div
      data-testid={`leaderboard-podium-${medal}`}
      data-vacant="true"
      aria-label={`第 ${medal} 名虚位以待`}
      className={`flex flex-col items-center min-w-0 ${
        first ? 'w-[6.5rem] sm:w-32 lg:w-36 mb-6' : 'w-[5.5rem] sm:w-28 lg:w-32'
      }`}
    >
      <div className={`relative ${first ? 'podium-float' : ''}`} aria-hidden="true">
        <div
          className={`flex items-center justify-center rounded-full border-2 border-dashed border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text-muted)] ${
            first ? 'w-20 h-20 lg:w-[88px] lg:h-[88px]' : 'w-16 h-16 lg:w-[72px] lg:h-[72px]'
          }`}
        >
          <span className={`font-heading font-bold ${first ? 'text-xl lg:text-2xl' : 'text-lg lg:text-xl'}`}>{medal}</span>
        </div>
      </div>
      <div className="mt-4 w-full text-center text-xs sm:text-sm font-bold text-[var(--color-text-muted)]">虚位以待</div>
      <div className="mt-1 text-center text-[10px] sm:text-xs text-[var(--color-text-muted)]">等你上榜</div>
    </div>
  )
}

/** 2-1-3 颁奖台。不足三人时为缺席名次保留「虚位以待」席位。 */
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
      className="card flex items-end justify-center gap-2 sm:gap-5 lg:gap-6 px-4 pt-9 pb-6 sm:px-6 lg:h-full lg:pt-12 lg:pb-8"
    >
      {second ? <PodiumSpot entry={second} medal={2} meRef={meRef} /> : <PodiumVacancy medal={2} />}
      {first ? <PodiumSpot entry={first} medal={1} meRef={meRef} /> : <PodiumVacancy medal={1} />}
      {third ? <PodiumSpot entry={third} medal={3} meRef={meRef} /> : <PodiumVacancy medal={3} />}
    </div>
  )
}
