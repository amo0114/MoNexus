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

// P5.5 T2：SKU 报表行。offerId 为 null 表示「未指定规格」桶（迁移前
// 历史单，或规格被删后 FK SET NULL 的存量单）。
export interface DashboardTopOffer {
  offerId: number | null
  offerName: string
  productId: number
  productName: string
  soldCount: number
  pointsRevenue: number
}

export interface DashboardTopOffers {
  items: DashboardTopOffer[]
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
