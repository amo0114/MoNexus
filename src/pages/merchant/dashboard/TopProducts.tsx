import React from 'react'
import { DashboardTopProduct } from '../../../api/merchant/dashboard'

export default function TopProducts({ data, loading }: { data: DashboardTopProduct[], loading: boolean }) {
  return (
    <div className="card rounded-lg border border-[var(--color-border)]">
      <h3 className="font-heading text-lg font-bold text-[var(--color-text)] mb-4">销量 TOP10</h3>
      <div className="overflow-x-auto">
        <table className="table-cards w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-3 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">排名</th>
              <th className="py-3 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">商品名</th>
              <th className="py-3 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider text-right">售出件数</th>
              <th className="py-3 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider text-right">积分收入</th>
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
                <td colSpan={4} className="py-8 text-center text-[var(--color-text-muted)] text-sm">暂无数据</td>
              </tr>
            ) : (
              data.map((item, i) => (
                <tr key={item.productId} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                  <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]" data-label="排名">{i + 1}</td>
                  <td className="py-3 px-2 text-sm font-medium text-[var(--color-text)] truncate max-w-[150px]" title={item.name} data-label="商品名">{item.name}</td>
                  <td className="py-3 px-2 text-sm text-[var(--color-text)] text-right" data-label="售出件数">{item.soldCount}</td>
                  <td className="py-3 px-2 text-sm text-[var(--color-cta)] text-right font-bold" data-label="积分收入">{item.pointsRevenue}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
