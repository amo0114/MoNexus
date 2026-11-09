import { useState } from 'react'
import { CalendarCheck, Check, Flame, Gift } from 'lucide-react'
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
      className={`max-md:min-h-10 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl font-semibold text-sm transition-all ${
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
            className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:bg-[var(--color-primary-hover)] active:scale-95 disabled:opacity-60 cursor-pointer"
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

function MonthCalendar({ status, onMakeup }: { status: CheckinStatus; onMakeup: (date: string) => void }) {
  const { key, daysInMonth, checked } = status.month
  const checkedByDate = new Map(checked.map(c => [c.date, c.makeup]))
  const eligible = new Set(status.makeup.eligibleDates)
  // 该月 1 号是周几（周一 = 0）；用 UTC 计算，与宿主时区无关。
  const firstWeekday = (new Date(`${key}-01T00:00:00Z`).getUTCDay() + 6) % 7

  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5 text-center text-xs text-[var(--color-text-muted)] mb-1.5">
        {WEEKDAYS.map(d => <span key={d}>{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1.5" data-testid="checkin-calendar">
        {Array.from({ length: firstWeekday }, (_, i) => <span key={`pad-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1
          const date = `${key}-${String(day).padStart(2, '0')}`
          const isChecked = checkedByDate.has(date)
          const isMakeup = checkedByDate.get(date) === true
          const isToday = date === status.today
          const canMakeup = eligible.has(date)
          const base = 'aspect-square rounded-lg text-xs sm:text-sm flex flex-col items-center justify-center relative'
          if (canMakeup) {
            return (
              <button
                key={date}
                type="button"
                onClick={() => onMakeup(date)}
                data-testid={`checkin-makeup-${date}`}
                title={`补签 ${date}`}
                className={`${base} border border-dashed border-[var(--color-primary-border-subtle)] text-[var(--color-text-muted)] hover:bg-[var(--color-primary-tint)] hover:text-[var(--color-primary)] cursor-pointer transition-colors`}
              >
                {day}
                <span className="text-[10px] leading-none text-[var(--color-primary)]">补</span>
              </button>
            )
          }
          return (
            <span
              key={date}
              data-checked={isChecked || undefined}
              className={`${base} ${
                isChecked
                  ? 'bg-[var(--color-primary-tint-strong)] text-[var(--color-primary)] font-semibold'
                  : date > status.today
                    ? 'text-[var(--color-text-muted)] opacity-50'
                    : 'text-[var(--color-text-muted)]'
              } ${isToday ? 'ring-2 ring-[var(--color-primary)]' : ''}`}
            >
              {day}
              {isChecked && (isMakeup
                ? <span className="text-[10px] leading-none">补</span>
                : <Check className="w-3 h-3" />)}
            </span>
          )
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

/** Profile 页完整签到卡：月历 + 阶梯 + 待领取 + 补签。签到按钮在 Profile 顶部卡片里，这里不重复。 */
export default function CheckinCard({ state }: { state: CheckinState }) {
  const [makeupDate, setMakeupDate] = useState<string | null>(null)
  const status = state.status
  if (!status) {
    return state.loadFailed ? null : <div className="card h-40 animate-pulse" aria-hidden />
  }
  if (!hasStreakDetails(status)) return null
  const { makeup } = status
  const makeupLeft = Math.max(0, makeup.monthlyLimit - makeup.usedThisMonth)

  return (
    <section id="checkin" className="card space-y-4 scroll-mt-24" data-testid="checkin-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-heading font-bold text-base sm:text-lg text-[var(--color-text)] flex items-center gap-2">
            <Flame className="w-5 h-5 text-[var(--color-warning)]" />
            {streakHint(status)}
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            QQ 签到也计入连签；连签与全勤奖励需在网站领取，逾期失效。
          </p>
        </div>
      </div>

      <MilestoneLadder status={status} />
      <ClaimList state={state} />
      <MonthCalendar status={status} onMakeup={setMakeupDate} />

      {makeup.monthlyLimit > 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          补签卡：{makeup.price} 积分 / 次，可补最近 {makeup.windowDays} 天，本月剩余 {makeupLeft} 次。补签恢复连签，不发当日签到奖励。
        </p>
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
