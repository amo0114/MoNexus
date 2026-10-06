import api from './client'

export type LeaderboardScope = 'total' | 'month' | 'week'

/**
 * One public row. The server never sends other users' ids or emails
 * (spec LB-07); `isMe` is computed server-side so the client can
 * highlight the requester without knowing who anyone else is.
 */
export interface LeaderboardEntry {
  rank: number
  displayName: string
  avatarUrl: string
  points: number
  isMe: boolean
  /** 同一周期截至今日零点的名次；今日首次得分为 null。 */
  prevRank?: number | null
}

export interface LeaderboardMe {
  rank: number
  points: number
  /** 同 LeaderboardEntry.prevRank。 */
  prevRank?: number | null
}

export interface LeaderboardResponse {
  scope: LeaderboardScope
  periodKey: string
  /** '全部' | '2026年8月' | 'YYYY-MM-DD ~ YYYY-MM-DD' */
  periodLabel: string
  /** 本次查询覆盖的北京时间日期，包含今天。 */
  dataThrough: string | null
  /** 本次统计截止时刻（ISO）；兼容旧接口的 null。 */
  updatedAt: string | null
  /** Top 100，已按 rank 升序。 */
  top: LeaderboardEntry[]
  /** 请求者不合格或本期无得分时为 null。 */
  me: LeaderboardMe | null
}

export async function getLeaderboard(scope: LeaderboardScope): Promise<LeaderboardResponse> {
  const res = await api.get<LeaderboardResponse>('/leaderboard', { params: { scope } })
  return res.data
}
