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

/** LB-07：他人行只含这四个字段，绝不含 userId / email / 余额。 */
export interface LeaderboardTopRow {
  rank: number
  displayName: string
  points: number
  isMe: boolean
}

export interface LeaderboardMe {
  rank: number
  points: number
}

export interface LeaderboardResponse {
  scope: LeaderboardScope
  periodKey: string
  /** 总榜「全部」/ 月榜「2026年8月」/ 周榜「07-27 ~ 08-02」。 */
  periodLabel: string
  /** 快照覆盖到的最后一个日历日；尚无快照为 null。 */
  dataThrough: string | null
  /** 快照批次时刻（ISO）；尚无快照为 null。 */
  updatedAt: string | null
  top: LeaderboardTopRow[]
  me: LeaderboardMe | null
}

export interface LeaderboardRefreshOutcome {
  scope: LeaderboardScope
  periodKey: string
  entryCount: number
}
