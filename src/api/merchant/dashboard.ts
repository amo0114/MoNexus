import client from '../client'

export type Range = '7d' | '30d' | '90d'

export interface DashboardSummary {
  monthOrderCount: number
  monthPointsRevenue: number
  onSaleProductCount: number
  pendingSettlementPoints: number
}

export interface DashboardSeriesPoint { date: string; orderCount: number; pointsRevenue: number }
export interface DashboardTopProduct { productId: number; name: string; soldCount: number; pointsRevenue: number }
export interface DashboardStatusBreakdown { paid: number; fulfilled: number; refunded: number }
export interface DashboardTimeseries {
  range: Range
  points: DashboardSeriesPoint[]
  top10: DashboardTopProduct[]
  statusBreakdown: DashboardStatusBreakdown
}

export async function fetchSummary(): Promise<DashboardSummary> {
  const { data } = await client.get('/merchant/dashboard/summary')
  return data
}

export async function fetchTimeseries(range: Range): Promise<DashboardTimeseries> {
  const { data } = await client.get('/merchant/dashboard/timeseries', { params: { range } })
  return data
}

/** P5.5 T2：按规格聚合的热销榜（净成交口径，已排除退款订单）。offerId 为 null 表示历史未指定规格订单。 */
export interface DashboardTopOffer {
  offerId: number | null
  offerName: string
  productId: number
  productName: string
  soldCount: number
  pointsRevenue: number
}

export async function fetchTopOffers(range: Range): Promise<{ items: DashboardTopOffer[] }> {
  const { data } = await client.get('/merchant/dashboard/offers', { params: { range } })
  return data
}
