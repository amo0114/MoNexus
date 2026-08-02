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
  /** '全部' | '2026年8月' | 'MM-DD ~ MM-DD' */
  periodLabel: string
  /** 快照 cutoff 的前一日；首轮刷新前为 null。 */
  dataThrough: string | null
  /** null 表示该 scope 还没有任何快照（部署后首刷空窗）。 */
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
