export type LeaderboardScope = 'total' | 'month' | 'week'

/**
 * 一期榜单的身份与时间跨度。日历日一律 YYYY-MM-DD（业务时区），物理时刻
 * 换算留到查询前一刻（businessDayStartUtc），期本身不携带 Date。
 */
export interface LeaderboardPeriod {
  scope: LeaderboardScope
  /** 'ALL' | 'M<YYYY-MM>' | 'W<周一日历日>' */
  periodKey: string
  /** 期首日历日；总榜无左边界，为 null。 */
  startDay: string | null
  /** 期末次日（右开区间上界）；总榜为 null。 */
  endDay: string | null
}

/** LB-07：公开身份只含展示名和头像，绝不含 userId / email / 余额。 */
export interface LeaderboardTopRow {
  rank: number
  displayName: string
  avatarUrl: string
  points: number
  isMe: boolean
  /** 同一周期截至今日零点的名次；今日首次得分为 null。 */
  prevRank: number | null
}

export interface LeaderboardMe {
  rank: number
  points: number
  /** 同 LeaderboardTopRow.prevRank。 */
  prevRank: number | null
}

export interface LeaderboardResponse {
  scope: LeaderboardScope
  periodKey: string
  /** 总榜「全部」/ 月榜「2026年8月」/ 周榜「2026-07-27 ~ 2026-08-02」。 */
  periodLabel: string
  /** 本次查询覆盖到的北京时间日期，包含今天。 */
  dataThrough: string
  /** 本次统计截止时刻（ISO）。 */
  updatedAt: string
  top: LeaderboardTopRow[]
  me: LeaderboardMe | null
}

export interface LeaderboardRefreshOutcome {
  scope: LeaderboardScope
  periodKey: string
  entryCount: number
}
