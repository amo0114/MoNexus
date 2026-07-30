import api from './client'

/** P5.5 T2：管理端 SKU 报表（净成交口径，已排除退款订单）。 */

export type ReportRange = '7d' | '30d' | '90d'

export interface AdminOfferReportItem {
  offerId: number | null
  offerName: string
  productId: number
  productName: string
  merchantId: number | null
  merchantName: string | null
  soldCount: number
  pointsRevenue: number
}

export async function fetchAdminOfferReport(range: ReportRange): Promise<{ items: AdminOfferReportItem[] }> {
  const { data } = await api.get<{ items: AdminOfferReportItem[] }>('/admin/reports/offers', { params: { range } })
  return data
}
