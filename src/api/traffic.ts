import api from './client'

export type TrafficRange = '7d' | '30d' | '90d'
export type TrafficAudience = 'merchant' | 'platform'
export interface TrafficCounts { pv: number; uv: number }
export interface TrafficReport {
  range: TrafficRange
  scope: TrafficAudience
  timeZone: 'Asia/Shanghai'
  startDate: string
  endDate: string
  startedAt: string | null
  updatedAt: string | null
  pendingEvents: number
  totals: TrafficCounts
  points: Array<TrafficCounts & { date: string }>
  topProducts: Array<TrafficCounts & { productId: number; name: string }>
  topMerchants: Array<TrafficCounts & { merchantId: number | null; name: string }>
}

export async function fetchTrafficReport(audience: TrafficAudience, range: TrafficRange) {
  const path = audience === 'platform' ? '/admin/reports/traffic' : '/merchant/dashboard/traffic'
  const { data } = await api.get<TrafficReport>(path, { params: { range } })
  return data
}
