import React from 'react'
import { BarChart3 } from 'lucide-react'
import { DashboardTopOffer } from '../../../api/merchant/dashboard'
import EmptyState from '../../../components/ui/EmptyState'

export default function TopOffers({ data, loading }: { data: DashboardTopOffer[], loading: boolean }) {
  return (
    <div className="card rounded-lg border border-[var(--color-border)]" data-testid="dashboard-top-offers">
      <h3 className="font-heading text-lg font-bold text-[var(--color-text)] mb-1">热销规格</h3>
      <p className="text-xs text-[var(--color-text-muted)] mb-4">净成交口径（已排除退款订单）</p>
      <div className="overflow-x-auto">
        <table className="table-cards w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-3 px-2 font-semibold text-[var(--color-text-muted)] text-xs tracking-wider whitespace-nowrap">排名</th>
              <th className="py-3 px-2 font-semibold text-[var(--color-text-muted)] text-xs tracking-wider whitespace-nowrap">规格</th>
              <th className="py-3 px-2 font-semibold text-[var(--color-text-muted)] text-xs tracking-wider text-right whitespace-nowrap">销量</th>
              <th className="py-3 px-2 font-semibold text-[var(--color-text-muted)] text-xs tracking-wider text-right whitespace-nowrap">积分收入</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--color-border)]">
                  <td colSpan={4} className="py-3 px-2"><div className="animate-pulse bg-[var(--color-border)] h-4 rounded w-full"></div></td>
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <EmptyState compact icon={BarChart3} title="暂无数据" description="产生销量后将展示热销规格榜单" />
                </td>
              </tr>
            ) : (
              data.map((item, i) => (
                <tr key={`${item.offerId ?? 'none'}-${item.productId}`} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                  <td className="py-3 px-2 text-sm text-[var(--color-text-muted)] tabular-nums whitespace-nowrap" data-label="排名">{i + 1}</td>
                  <td className="py-3 px-2 text-sm" data-label="规格">
                    <div className="min-w-0 max-md:text-right">
                      <div className="font-medium text-[var(--color-text)] truncate max-w-[180px]" title={item.offerName}>{item.offerName}</div>
                      <div className="text-xs text-[var(--color-text-muted)] truncate max-w-[180px]" title={item.productName}>{item.productName}</div>
                    </div>
                  </td>
                  <td className="py-3 px-2 text-sm text-[var(--color-text)] text-right tabular-nums whitespace-nowrap" data-label="销量">{item.soldCount}</td>
                  <td className="py-3 px-2 text-sm text-[var(--color-cta)] text-right font-bold tabular-nums whitespace-nowrap" data-label="积分收入">{item.pointsRevenue}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
