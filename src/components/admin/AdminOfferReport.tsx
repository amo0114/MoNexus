import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { fetchAdminOfferReport, AdminOfferReportItem, ReportRange } from '../../api/adminReports'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'

const RANGE_OPTIONS: { label: string; value: ReportRange }[] = [
  { label: '7天', value: '7d' },
  { label: '30天', value: '30d' },
  { label: '90天', value: '90d' },
]

/** P5.5 T2：管理端「热销规格」报表（数据仪表盘内嵌区块，自行拉取数据）。 */
export default function AdminOfferReport() {
  const showToast = useAppStore((s) => s.showToast)
  const [range, setRange] = useState<ReportRange>('30d')
  const [items, setItems] = useState<AdminOfferReportItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let mounted = true
    setLoading(true)
    fetchAdminOfferReport(range)
      .then((data) => { if (mounted) setItems(data.items) })
      .catch((err) => showToast(getApiErrorMessage(err, '加载热销规格失败'), 'error'))
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  return (
    <section className="pt-6 border-t border-[var(--color-border)]">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-1">
        <h3 className="font-heading text-lg font-bold text-[var(--color-text)]">热销规格</h3>
        <div className="flex gap-2">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRange(opt.value)}
              className={`px-3 py-1.5 btn-sm rounded text-sm font-medium border transition-colors cursor-pointer ${
                range === opt.value
                  ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                  : 'text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text)]'
              }`}
              data-testid={`admin-offer-report-range-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-4">净成交口径（已排除退款订单）</p>
      <div className="overflow-x-auto">
        {loading && items.length === 0 ? (
          <TableSkeleton />
        ) : (
        <table className="admin-table table-cards">
          <thead>
            <tr>
              <th>规格</th>
              <th>商品</th>
              <th>商家</th>
              <th className="text-right">销量</th>
              <th className="text-right">积分收入</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.offerId ?? 'none'}-${item.productId}`}>
                <td className="font-bold text-[var(--color-text)] text-sm" data-label="规格">{item.offerName}</td>
                <td className="text-sm text-[var(--color-text)]" data-label="商品">{item.productName}</td>
                <td className="text-sm text-[var(--color-text-muted)]" data-label="商家">{item.merchantName ?? '平台自营'}</td>
                <td className="text-right text-sm text-[var(--color-text)]" data-label="销量">{item.soldCount}</td>
                <td className="text-right font-bold text-[var(--color-cta)]" data-label="积分收入">{item.pointsRevenue}</td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState compact icon={BarChart3} title="暂无成交数据" description="产生销量后将展示热销规格榜单" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>
    </section>
  )
}
