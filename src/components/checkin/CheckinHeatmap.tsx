import { useEffect, useMemo, useRef, useState } from 'react'
import { getCheckinHeatmap, type CheckinHeatmap, type CheckinHeatmapDay } from '../../api/checkin'
import { useAuthStore } from '../../stores/authStore'

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const ROW_LABELS = ['一', '', '三', '', '五', '', '']

const LEVEL_CLASS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'bg-[color-mix(in_srgb,var(--color-border)_42%,var(--color-background))]',
  1: 'bg-[color-mix(in_srgb,var(--color-primary)_22%,var(--color-background))]',
  2: 'bg-[color-mix(in_srgb,var(--color-primary)_44%,var(--color-background))] ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-primary)_32%,transparent)]',
  3: 'bg-[color-mix(in_srgb,var(--color-primary)_74%,var(--color-background))]',
  4: 'bg-[var(--color-primary)]',
}

const LEVEL_LEGEND: Array<{ level: 0 | 1 | 2 | 3 | 4; label: string }> = [
  { level: 0, label: '未签到' },
  { level: 1, label: '当日活跃' },
  { level: 2, label: '补签日' },
  { level: 3, label: '正常签到' },
  { level: 4, label: '连签里程碑 / ≥7天连签' },
]

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function weekdayIdx(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
}

interface GridCell {
  date: string
  future: boolean
  level: 0 | 1 | 2 | 3 | 4
  info: CheckinHeatmapDay | null
}

function describeCell(cell: GridCell, today: string): string {
  const weekday = WEEKDAY_NAMES[weekdayIdx(cell.date)]
  const prefix = cell.date === today ? `${cell.date}（今天 · ${weekday}）` : `${cell.date}（${weekday}）`
  if (!cell.info) return `${prefix} · 未签到`
  if (cell.info.checkedIn) {
    const kind = cell.info.makeup ? '补签' : '正常签到'
    const streak = cell.info.streak > 0 ? ` · 连签 ${cell.info.streak} 天` : ''
    const highlight = !cell.info.makeup && cell.level === 4 ? ' · 高光日' : ''
    return `${prefix} · ${kind}${streak}${highlight}`
  }
  return `${prefix} · 当日登录活跃`
}

/**
 * 个人中心 GitHub 风格签到与活跃贡献墙（默认近 24 周 / 半年）。
 * 桌面端自适应铺展填满卡片宽度，移动端支持横向流畅滑动并默认滚到右侧「今天」；
 * 悬浮、键盘聚焦或点按任意方块均在统一状态行展示当日详情。
 */
export default function CheckinHeatmapWall({
  weeks = 24,
  refreshKey,
}: {
  weeks?: number
  /** 随签到/补签状态变化递增或变化，自动刷新贡献墙。 */
  refreshKey?: string
}) {
  const authEpoch = useAuthStore((s) => s.authEpoch)
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const [data, setData] = useState<CheckinHeatmap | null>(null)
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    setUnavailable(false)
    getCheckinHeatmap(weeks)
      .then((res) => {
        if (!active) return
        setData(res)
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setLoading(false)
        setUnavailable(true)
      })
    return () => {
      active = false
    }
  }, [weeks, refreshKey, authEpoch, userId])

  const { columns, monthLabels, cellMap } = useMemo(() => {
    if (!data) {
      return {
        columns: [] as GridCell[][],
        monthLabels: [] as Array<string | null>,
        cellMap: new Map<string, GridCell>(),
      }
    }
    const infoByDate = new Map(data.days.map((d) => [d.date, d]))
    const cols: GridCell[][] = []
    const labels: Array<string | null> = []
    const map = new Map<string, GridCell>()

    for (let w = 0; w < data.weeks; w++) {
      const col: GridCell[] = []
      let label: string | null = null
      for (let r = 0; r < 7; r++) {
        const date = addDays(data.startDate, w * 7 + r)
        const future = date > data.today
        const info = future ? null : (infoByDate.get(date) ?? null)
        const cell: GridCell = {
          date,
          future,
          level: info ? info.level : 0,
          info,
        }
        col.push(cell)
        if (!future) map.set(date, cell)
        const [, m, day] = date.split('-').map(Number)
        if (day === 1) {
          label = `${m}月`
        }
      }
      cols.push(col)
      labels.push(label)
    }

    // 首列若本身不含 1 号且第 2 列也没有月份标，补一个首月标以便阅读
    if (cols.length > 0 && !labels[0] && !labels[1]) {
      const [, firstMonth] = cols[0][0].date.split('-').map(Number)
      labels[0] = `${firstMonth}月`
    }

    return { columns: cols, monthLabels: labels, cellMap: map }
  }, [data])

  // 移动端横向容器默认滚到最右侧，优先展示最近几周与今天
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !data) return
    el.scrollLeft = el.scrollWidth
  }, [data?.today, data?.weeks])

  if (unavailable && !data) return null

  if (loading && !data) {
    return (
      <div
        className="rounded-xl border border-[color-mix(in_srgb,var(--color-border)_75%,transparent)] bg-[var(--color-background)] p-3.5 space-y-3"
        aria-hidden="true"
      >
        <div className="flex items-center justify-between">
          <div className="h-3.5 w-28 rounded bg-[var(--color-border)] animate-pulse" />
          <div className="h-3.5 w-36 rounded bg-[var(--color-border)] animate-pulse" />
        </div>
        <div className="h-24 w-full rounded-lg bg-[color-mix(in_srgb,var(--color-border)_45%,transparent)] animate-pulse" />
      </div>
    )
  }

  if (!data) return null

  const activeCell = (selectedDate ? cellMap.get(selectedDate) : null) ?? cellMap.get(data.today) ?? null

  return (
    <div
      className="rounded-xl border border-[color-mix(in_srgb,var(--color-border)_75%,transparent)] bg-[var(--color-background)] p-3.5 sm:p-4 space-y-3"
      data-testid="checkin-heatmap"
    >
      {/* Header & Summary */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-xs font-semibold text-[var(--color-text)]">
          近 {data.weeks} 周签到与活跃足迹
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-text-muted)] tabular-nums" data-testid="checkin-heatmap-summary">
          <span>
            签到 <strong className="font-semibold text-[var(--color-text)]">{data.summary.checkinDays}</strong> 天
          </span>
          <span>
            活跃 <strong className="font-semibold text-[var(--color-text)]">{data.summary.activeDays}</strong> 天
          </span>
          <span>
            最长连签 <strong className="font-semibold text-[var(--color-primary)]">{data.summary.longestStreak}</strong> 天
          </span>
        </div>
      </div>

      {/* Scrollable Heatmap Grid (mobile horizontal scroll; md+ stretches cleanly across card) */}
      <div
        ref={scrollRef}
        className="overflow-x-auto pb-1 hide-scrollbar"
        data-testid="checkin-heatmap-scroll"
      >
        <div className="min-w-[460px] md:min-w-0 w-full">
          {/* Month axis */}
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="w-4 shrink-0" aria-hidden="true" />
            <div
              className="grid flex-1 gap-[3px] sm:gap-1"
              style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
            >
              {monthLabels.map((label, idx) => (
                <span
                  key={idx}
                  className="text-[10px] leading-none text-[var(--color-text-muted)] whitespace-nowrap overflow-visible"
                >
                  {label ?? ''}
                </span>
              ))}
            </div>
          </div>

          {/* Weekday axis + 7 rows × N week columns */}
          <div className="flex items-stretch gap-1.5">
            <div className="grid grid-rows-7 gap-[3px] sm:gap-1 w-4 shrink-0 text-[10px] leading-none text-[var(--color-text-muted)]">
              {ROW_LABELS.map((label, idx) => (
                <span key={idx} className="flex items-center justify-end pr-0.5">
                  {label}
                </span>
              ))}
            </div>

            <div
              className="grid flex-1 gap-[3px] sm:gap-1"
              style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
              role="grid"
              aria-label={`近 ${data.weeks} 周签到与活跃贡献墙`}
            >
              {columns.map((col, colIdx) => (
                <div key={colIdx} className="grid grid-rows-7 gap-[3px] sm:gap-1">
                  {col.map((cell) => {
                    if (cell.future) {
                      return <span key={cell.date} className="aspect-square w-full max-w-[20px] mx-auto" aria-hidden="true" />
                    }
                    const isToday = cell.date === data.today
                    const isSelected = cell.date === selectedDate
                    const desc = describeCell(cell, data.today)
                    return (
                      <button
                        key={cell.date}
                        type="button"
                        aria-label={desc}
                        title={desc}
                        data-testid={`heatmap-cell-${cell.date}`}
                        data-level={cell.level}
                        onMouseEnter={() => setSelectedDate(cell.date)}
                        onFocus={() => setSelectedDate(cell.date)}
                        onClick={() => setSelectedDate(cell.date)}
                        className={`aspect-square w-full max-w-[20px] mx-auto rounded-[3px] sm:rounded-[4px] transition-transform cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
                          LEVEL_CLASS[cell.level]
                        } ${
                          isToday
                            ? 'ring-1 ring-offset-1 ring-offset-[var(--color-background)] ring-[var(--color-primary)]'
                            : isSelected
                              ? 'scale-110 ring-1 ring-[var(--color-text)]'
                              : 'hover:scale-110'
                        }`}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Active Cell Detail + GitHub-style Legend */}
      <div className="flex flex-col gap-2 border-t border-[color-mix(in_srgb,var(--color-border)_65%,transparent)] pt-2.5 sm:flex-row sm:items-center sm:justify-between">
        <p
          className="text-[11px] text-[var(--color-text-muted)] truncate"
          data-testid="checkin-heatmap-detail"
          aria-live="polite"
        >
          {activeCell ? describeCell(activeCell, data.today) : '悬停或点击方格查看当日记录'}
        </p>
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] shrink-0">
          <span>少</span>
          {LEVEL_LEGEND.map((item) => (
            <span
              key={item.level}
              title={item.label}
              aria-label={item.label}
              className={`inline-block h-3 w-3 rounded-[3px] ${LEVEL_CLASS[item.level]}`}
            />
          ))}
          <span>多</span>
        </div>
      </div>
    </div>
  )
}
