export type Range = '7d' | '30d' | '90d'

export interface DashboardSummary {
  monthOrderCount: number
  monthPointsRevenue: number
  onSaleProductCount: number
  pendingSettlementPoints: number
}

export interface DashboardSeriesPoint {
  date: string
  orderCount: number
  pointsRevenue: number
}

export interface DashboardTopProduct {
  productId: number
  name: string
  soldCount: number
  pointsRevenue: number
}

export interface DashboardStatusBreakdown {
  paid: number
  fulfilled: number
  refunded: number
}

export interface DashboardTimeseries {
  range: Range
  points: DashboardSeriesPoint[]
  top10: DashboardTopProduct[]
  statusBreakdown: DashboardStatusBreakdown
}
