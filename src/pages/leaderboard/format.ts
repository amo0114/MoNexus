import type { LeaderboardResponse } from '../../api/leaderboard'

/** 积分展示统一千分位（12,450），font-mono + tabular-nums 下仍逐列对齐。 */
export const fmtPoints = (n: number) => n.toLocaleString('zh-CN')

/**
 * 「距上一名 / 距上榜线」推导：StatsPanel（桌面战况卡）与 MyRankBar
 * （移动端吸底条）共用，口径只此一处。
 * - 我在 Top 内：取上一名的分差；
 * - 我在 Top 外（未上榜但有名次）：取末名入榜线的分差；
 * - 我是榜首或没有名次：null（调用方各自决定替代文案）。
 */
export function meGap(data: LeaderboardResponse): { label: string; points: number } | null {
  const { top, me } = data
  if (!me || me.rank <= 1) return null
  const prev = top.find((row) => row.rank === me.rank - 1)
  if (prev) return { label: '距上一名', points: prev.points - me.points }
  const last = top[top.length - 1]
  if (last && me.rank > last.rank && last.points > me.points) {
    return { label: '距上榜线', points: last.points - me.points }
  }
  return null
}
