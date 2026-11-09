import api from './client'

export interface CheckinReward {
  id: number
  kind: 'streak' | 'monthly'
  milestone: number
  amount: number
  expiresAt: string
}

export interface CheckinStatus {
  hasCheckedIn: boolean
  today: string
  streak: number
  /** done = 今日已签；pending = 昨日已签、今天还没签；broken = 已断签 */
  streakState: 'done' | 'pending' | 'broken'
  month: { key: string; daysInMonth: number; checked: Array<{ date: string; makeup: boolean }> }
  milestones: Array<{ days: number; reward: number; reached: boolean }>
  repeatEveryDays: number
  nextMilestone: { days: number; reward: number } | null
  monthlyReward: number
  claimable: CheckinReward[]
  makeup: { price: number; monthlyLimit: number; usedThisMonth: number; windowDays: number; eligibleDates: string[] }
}

export interface CheckinResult {
  baseReward: number
  bonusReward: number
  totalReward: number
  balanceAfter: number
  streak: number
  newRewards: CheckinReward[]
}

/**
 * 旧版后端只返回 `{ hasCheckedIn }`（前后端滚动发布窗口期）。连签相关 UI
 * 只在完整响应下渲染，签到按钮仍可用。
 */
export function hasStreakDetails(status: CheckinStatus | null): status is CheckinStatus {
  return Array.isArray(status?.month?.checked) && Array.isArray(status?.claimable)
}

export async function getCheckinStatus(): Promise<CheckinStatus> {
  const res = await api.get<CheckinStatus>('/points/checkin/status')
  return res.data
}

export async function postCheckin(): Promise<CheckinResult> {
  const res = await api.post<CheckinResult>('/points/checkin')
  return res.data
}

export async function postMakeup(date: string, expectedPrice: number) {
  const res = await api.post<{ date: string; streak: number; balanceAfter: number; newRewards: CheckinReward[] }>(
    '/points/checkin/makeup',
    { date, expectedPrice },
  )
  return res.data
}

export async function claimCheckinReward(id: number) {
  const res = await api.post<{ id: number; amount: number; balanceAfter: number; alreadyClaimed: boolean }>(
    `/points/checkin/rewards/${id}/claim`,
  )
  return res.data
}
