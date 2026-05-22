import React from 'react'
import { DashboardSummary } from '../../../api/merchant/dashboard'

export default function SummaryCards({ data, loading }: { data?: DashboardSummary, loading: boolean }) {
  const renderCard = (label: string, value: string | number | undefined, tone?: 'cta' | 'warning') => {
    const valueColor = tone === 'cta' ? 'text-[var(--color-cta)]' : tone === 'warning' ? 'text-orange-500' : 'text-[var(--color-text)]'
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4">
        <div className="text-[var(--color-text-muted)] text-sm mb-1">{label}</div>
        {loading ? (
          <div className="animate-pulse bg-[var(--color-border)] rounded-md h-8 w-24"></div>
        ) : (
          <div className={`font-heading text-2xl font-bold ${valueColor}`}>{value ?? '--'}</div>
        )}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {renderCard('本月订单数', data?.monthOrderCount)}
      {renderCard('本月积分流水', data?.monthPointsRevenue, 'cta')}
      {renderCard('在售商品', data?.onSaleProductCount)}
      {renderCard('待结算', data?.pendingSettlementPoints, 'warning')}
    </div>
  )
}
