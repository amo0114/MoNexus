import React from 'react'
import { DashboardStatusBreakdown } from '../../../api/merchant/dashboard'

export default function StatusBreakdown({ data, loading }: { data?: DashboardStatusBreakdown, loading: boolean }) {
  if (loading) {
    return (
      <div className="card p-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
        <h3 className="font-heading text-lg font-bold text-[var(--color-text)] mb-4">订单状态分布</h3>
        <div className="animate-pulse space-y-4">
          <div className="h-10 bg-[var(--color-border)] rounded"></div>
          <div className="h-10 bg-[var(--color-border)] rounded"></div>
          <div className="h-10 bg-[var(--color-border)] rounded"></div>
        </div>
      </div>
    )
  }

  const items = [
    { label: '已支付', value: data?.paid || 0, color: 'var(--color-primary)' },
    { label: '已履约', value: data?.fulfilled || 0, color: 'var(--color-cta)' },
    { label: '已退款', value: data?.refunded || 0, color: 'var(--color-danger)' },
  ]

  const total = Math.max(items.reduce((sum, item) => sum + item.value, 0), 1)

  return (
    <div className="card p-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
      <h3 className="font-heading text-lg font-bold text-[var(--color-text)] mb-4">订单状态分布</h3>
      <div className="flex flex-col gap-4">
        {items.map((item) => (
          <div key={item.label}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-[var(--color-text-muted)]">{item.label}</span>
              <span className="font-bold text-[var(--color-text)]">{item.value}</span>
            </div>
            <div className="w-full bg-[var(--color-surface)] rounded-full h-2.5 border border-[var(--color-border)]">
              <div
                className="h-2.5 rounded-full"
                style={{ width: `${(item.value / total) * 100}%`, backgroundColor: item.color }}
              ></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
