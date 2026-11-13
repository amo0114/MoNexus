import { useRef, useState } from 'react'
import { CalendarCheck, Check, ChevronDown, Flame, Gift } from 'lucide-react'
import { hasStreakDetails, type CheckinStatus } from '../../api/checkin'
import ConfirmDialog from '../ui/ConfirmDialog'
import PointCoin from '../ui/PointCoin'
import type { useCheckin } from '../../hooks/useCheckin'

type CheckinState = ReturnType<typeof useCheckin>

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function streakHint(status: CheckinStatus) {
  if (status.streakState === 'pending') return `已连签 ${status.streak} 天，今天签到不断签`
  if (status.streakState === 'broken') return '今天开始新的连签'
  return `已连续签到 ${status.streak} 天`
}

function nextMilestoneHint(status: CheckinStatus) {
  const next = status.nextMilestone
  if (!next) return null
  const remaining = next.days - status.streak
  return `再签 ${remaining} 天，连签 ${next.days} 天可领 ${next.reward} 积分`
}

function rewardLabel(kind: string, milestone: number) {
  return kind === 'monthly' ? '月度全勤奖励' : `连签 ${milestone} 天奖励`
}

function CheckinButton({ state }: { state: CheckinState }) {
  const done = state.status?.hasCheckedIn ?? false
  return (
    <button
      type="button"
      onClick={() => void state.checkin()}
      disabled={!state.status || done || state.busy === 'checkin'}
      data-testid="checkin-button"
      className={`max-md:min-h-10 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl font-semibold text-sm transition ${
        done
          ? 'bg-[var(--color-background)] text-[var(--color-text-muted)] border border-[var(--color-border)] cursor-not-allowed'
          : 'bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:bg-[var(--color-primary-hover)] active:scale-95 cursor-pointer disabled:opacity-60'
      }`}
    >
      <CalendarCheck className="w-4 h-4" />
      {done ? '今日已签到' : state.busy === 'checkin' ? '签到中…' : '签到'}
    </button>
  )
}

function ClaimList({ state }: { state: CheckinState }) {
  const claimable = hasStreakDetails(state.status) ? state.status.claimable : []
  if (claimable.length === 0) return null
  return (
    <ul className="space-y-2" data-testid="checkin-claimable">
      {claimable.map(reward => (
        <li
          key={reward.id}
          className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-primary-border-subtle)] bg-[var(--color-primary-tint)] px-3 py-2"
        >
          <span className="flex items-center gap-2 text-sm min-w-0">
            <Gift className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
            <span className="truncate">{rewardLabel(reward.kind, reward.milestone)}</span>
            <span className="inline-flex items-center gap-0.5 font-semibold text-[var(--color-points)]">
              <PointCoin className="w-3.5 h-3.5" />+{reward.amount}
            </span>
          </span>
          <button
            type="button"
            onClick={() => void state.claim(reward.id)}
            disabled={state.busy !== null}
            data-testid={`checkin-claim-${reward.id}`}
            className="shrink-0 min-h-10 px-3 rounded-lg text-xs font-semibold bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:bg-[var(--color-primary-hover)] active:scale-95 disabled:opacity-60 cursor-pointer"
          >
            {state.busy === `claim:${reward.id}` ? '领取中…' : '领取'}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** HM-02：首页今日面板里的紧凑签到卡。 */
export function CheckinCompact({ state }: { state: CheckinState }) {
  const status = state.status
  if (!status) return null
  if (!hasStreakDetails(status)) {
    return <div className="flex justify-end" data-testid="checkin-compact"><CheckinButton state={state} /></div>
  }
  const hint = nextMilestoneHint(status)
  return (
    <div className="space-y-3" data-testid="checkin-compact">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--color-text)]">
            <Flame className="w-4 h-4 text-[var(--color-warning)] shrink-0" />
            <span className="truncate">{streakHint(status)}</span>
          </div>
          {hint && <p className="text-xs text-[var(--color-text-muted)] mt-0.5 truncate">{hint}</p>}
        </div>
        <CheckinButton state={state} />
      </div>
      <ClaimList state={state} />
    </div>
  )
}

// 纯日期字符串按 UTC 运算，与宿主时区无关。
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 周一 = 0 */
function weekdayIndex(date: string) {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
}

type DayState = 'checked' | 'makeup' | 'eligible' | 'today' | 'missed' | 'future'

function dayStateResolver(status: CheckinStatus) {
  const checked = new Map([...status.month.checked, ...(status.recent ?? [])].map(c => [c.date, c.makeup]))
  const eligible = new Set(status.makeup.eligibleDates)
  return (date: string): DayState => {
    if (checked.has(date)) return checked.get(date) ? 'makeup' : 'checked'
    if (eligible.has(date)) return 'eligible'
    if (date === status.today) return 'today'
    return date > status.today ? 'future' : 'missed'
  }
}

const DAY_TONE: Record<DayState, string> = {
  checked: 'bg-[var(--color-primary-tint-strong)] text-[var(--color-primary)] font-semibold',
  makeup: 'bg-[var(--color-primary-tint)] text-[var(--color-primary)] font-semibold',
  eligible: 'border border-dashed border-[var(--color-primary-border-subtle)] text-[var(--color-text)] hover:bg-[var(--color-primary-tint)] active:scale-95 cursor-pointer transition',
  today: 'text-[var(--color-text)] font-semibold',
  missed: 'text-[var(--color-text-muted)]',
  future: 'text-[var(--color-text-muted)] opacity-50',
}

/** 正常签到实心勾，补签空心勾。 */
function CheckMark({ makeup, small, pop }: { makeup: boolean; small?: boolean; pop?: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full ${small ? 'w-4 h-4' : 'w-5 h-5'} ${
        makeup
          ? 'border-[1.5px] border-[var(--color-primary)] text-[var(--color-primary)]'
          : 'bg-[var(--color-primary)] text-[var(--color-on-primary)]'
      } ${pop ? 'animate-[numberPopIn_0.35s_cubic-bezier(0.22,1,0.36,1)]' : ''}`}
    >
      <Check className={small ? 'w-2.5 h-2.5' : 'w-3 h-3'} strokeWidth={3} />
    </span>
  )
}

function DayCell({ date, state, isToday, compact, pop, onMakeup }: {
  date: string
  state: DayState
  isToday: boolean
  /** 月历格只放日期数字；近几天条额外带星期。 */
  compact?: boolean
  pop?: boolean
  onMakeup: (date: string) => void
}) {
  const isChecked = state === 'checked' || state === 'makeup'
  const [, month, day] = date.split('-').map(Number)
  const className = `relative rounded-lg flex flex-col items-center justify-center gap-0.5 ${
    compact ? 'h-11 sm:h-12 text-xs sm:text-sm' : 'h-[4.5rem] text-sm'
  } ${DAY_TONE[state]} ${isToday ? 'ring-2 ring-inset ring-[var(--color-primary)]' : ''}`
  const body = (
    <>
      {!compact && (
        <span className="text-[11px] leading-none font-normal opacity-80">
          {isToday ? '今天' : `周${WEEKDAYS[weekdayIndex(date)]}`}
        </span>
      )}
      <span className="leading-tight tabular-nums">{compact ? day : `${month}/${day}`}</span>
      {isChecked ? (
        <CheckMark makeup={state === 'makeup'} small={compact} pop={pop} />
      ) : state === 'eligible' ? (
        <span className="text-[11px] leading-none text-[var(--color-primary)] font-medium">补签</span>
      ) : !compact && (
        <span className="h-5 flex items-center text-[11px] leading-none font-normal opacity-70">
          {state === 'today' ? '待签' : ''}
        </span>
      )}
      {state === 'makeup' && (
        // 窄屏月历格只有 30px 宽，角标会压住日期；空心勾已足够区分。
        <span className={`absolute top-0.5 right-1 text-[10px] leading-none font-normal opacity-80 ${compact ? 'max-sm:hidden' : ''}`}>补</span>
      )}
    </>
  )
  if (state === 'eligible') {
    return (
      <button
        type="button"
        onClick={() => onMakeup(date)}
        aria-label={`补签 ${date}`}
        data-testid={`${compact ? 'checkin-month-makeup' : 'checkin-makeup'}-${date}`}
        className={className}
      >
        {body}
      </button>
    )
  }
  return <span data-checked={isChecked || undefined} className={className}>{body}</span>
}

/** 补签窗口 + 今天。可补日期全部落在这一条里，跨月也能补。 */
function RecentStrip({ status, pop, onMakeup }: { status: CheckinStatus; pop: boolean; onMakeup: (date: string) => void }) {
  const stateOf = dayStateResolver(status)
  const days = status.makeup.windowDays
  return (
    // 手机上 8 格折成两行，保证每格 ≥40px 触控尺寸。
    <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5" data-testid="checkin-recent">
      {Array.from({ length: days + 1 }, (_, i) => {
        const date = addDays(status.today, i - days)
        const isToday = date === status.today
        return <DayCell key={date} date={date} state={stateOf(date)} isToday={isToday} pop={pop && isToday} onMakeup={onMakeup} />
      })}
    </div>
  )
}

function MonthCalendar({ status, onMakeup }: { status: CheckinStatus; onMakeup: (date: string) => void }) {
  const { key, daysInMonth } = status.month
  const stateOf = dayStateResolver(status)
  const firstWeekday = weekdayIndex(`${key}-01`)

  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5 text-center text-xs text-[var(--color-text-muted)] mb-1.5">
        {WEEKDAYS.map(d => <span key={d}>{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1.5" data-testid="checkin-calendar">
        {Array.from({ length: firstWeekday }, (_, i) => <span key={`pad-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const date = `${key}-${String(i + 1).padStart(2, '0')}`
          return <DayCell key={date} date={date} state={stateOf(date)} isToday={date === status.today} compact onMakeup={onMakeup} />
        })}
      </div>
    </div>
  )
}

function MilestoneLadder({ status }: { status: CheckinStatus }) {
  if (status.milestones.length === 0 && status.monthlyReward === 0) return null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" data-testid="checkin-milestones">
        {status.milestones.map(m => (
          <span
            key={m.days}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium border ${
              m.reached
                ? 'bg-[var(--color-primary-tint-strong)] border-[var(--color-primary-border-subtle)] text-[var(--color-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
            }`}
          >
            {m.reached && <Check className="w-3 h-3" />}
            {m.days} 天 +{m.reward}
          </span>
        ))}
        {status.monthlyReward > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)]">
            当月全勤 +{status.monthlyReward}
          </span>
        )}
      </div>
      {nextMilestoneHint(status) && (
        <p className="text-xs text-[var(--color-text-muted)]">{nextMilestoneHint(status)}</p>
      )}
    </div>
  )
}

/** Profile 页完整签到卡：近几天签到条（可展开整月）+ 阶梯 + 待领取 + 补签。签到按钮在 Profile 顶部卡片里，这里不重复。 */
export default function CheckinCard({ state }: { state: CheckinState }) {
  const [makeupDate, setMakeupDate] = useState<string | null>(null)
  const [monthOpen, setMonthOpen] = useState(false)
  // 只有在本次会话里亲眼见过「未签」再变成「已签」，才给今天的勾播放弹出动效。
  const sawUnchecked = useRef(false)
  const status = state.status
  if (status?.hasCheckedIn === false) sawUnchecked.current = true
  if (!status) {
    return state.loadFailed ? null : <div className="card h-40 animate-pulse" aria-hidden />
  }
  if (!hasStreakDetails(status)) return null
  const { makeup } = status
  const makeupLeft = Math.max(0, makeup.monthlyLimit - makeup.usedThisMonth)
  const [year, month] = status.month.key.split('-').map(Number)

  return (
    <section id="checkin" className="card space-y-4 scroll-mt-24" data-testid="checkin-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-heading font-bold text-base sm:text-lg text-[var(--color-text)] flex items-center gap-2">
            <Flame className="w-5 h-5 text-[var(--color-warning)] shrink-0" />
            {streakHint(status)}
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            QQ 签到也计入连签；连签与全勤奖励需在网站领取，逾期失效。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMonthOpen(open => !open)}
          aria-expanded={monthOpen}
          data-testid="checkin-month-toggle"
          className="shrink-0 min-h-10 inline-flex items-center gap-1 px-3 rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-background)] cursor-pointer transition-colors"
        >
          {monthOpen ? '收起' : '本月'}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${monthOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <MilestoneLadder status={status} />
      <ClaimList state={state} />
      <RecentStrip status={status} pop={sawUnchecked.current} onMakeup={setMakeupDate} />

      {makeup.monthlyLimit > 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          点虚线日期可补签：{makeup.price} 积分 / 次，本月剩余 {makeupLeft} 次；补签恢复连签，不发当日签到奖励。
        </p>
      )}

      {monthOpen && (
        <div className="space-y-2 border-t border-[var(--color-border)] pt-4">
          <p className="text-sm font-semibold text-[var(--color-text)]">{year} 年 {month} 月</p>
          <MonthCalendar status={status} onMakeup={setMakeupDate} />
        </div>
      )}

      <ConfirmDialog
        open={makeupDate !== null}
        onOpenChange={open => { if (!open) setMakeupDate(null) }}
        title="使用补签卡"
        description={makeupDate ? `补签 ${makeupDate}，消耗 ${makeup.price} 积分。补签不发当日签到奖励。` : undefined}
        confirmLabel={`消耗 ${makeup.price} 积分补签`}
        tone="primary"
        loading={makeupDate !== null && state.busy === `makeup:${makeupDate}`}
        onConfirm={async () => {
          if (!makeupDate) return
          await state.makeup(makeupDate)
          setMakeupDate(null)
        }}
        confirmTestId="checkin-makeup-confirm"
      />
    </section>
  )
}
