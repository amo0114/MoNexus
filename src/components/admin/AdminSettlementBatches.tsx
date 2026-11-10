import { useEffect, useState } from 'react'
import { getSettlementBatch, getSettlementBatches } from '../../api/adminMerchant'
import { getApiErrorMessage } from '../../api/error'
import type { BatchSettleResponse, SettlementBatchSummary } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import AdminPagination from './AdminPagination'

/** Executed settlement batches with per-item wallet vouchers (read-only). */
export default function AdminSettlementBatches({ active = true, version = 0 }: { active?: boolean; version?: number }) {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<SettlementBatchSummary[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [detail, setDetail] = useState<BatchSettleResponse | null>(null)

  async function load(nextPage: number) {
    try {
      const data = await getSettlementBatches({ page: nextPage, pageSize: 10 })
      setItems(data.items)
      setTotal(data.total)
      setPage(data.page)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载结算批次失败'), 'error')
    }
  }

  useEffect(() => {
    if (active) void load(1)
  }, [active, version])

  async function toggle(id: number) {
    if (detail?.batchId === id) { setDetail(null); return }
    try {
      setDetail(await getSettlementBatch(id))
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载批次明细失败'), 'error')
    }
  }

  if (items.length === 0) return null
  return (
    <section className="space-y-2" data-testid="admin-settlement-batches">
      <h3 className="font-bold text-sm">结算批次</h3>
      <div className="overflow-x-auto">
        <table className="admin-table table-cards">
          <thead>
            <tr><th>批次</th><th>笔数</th><th>入账合计</th><th>执行时间</th><th /></tr>
          </thead>
          <tbody>
            {items.map((batch) => (
              <tr key={batch.id}>
                <td data-label="批次" className="font-mono text-xs">#{batch.id}</td>
                <td data-label="笔数">{batch.itemCount}</td>
                <td data-label="入账合计">{batch.totalPoints.toLocaleString()} 积分</td>
                <td data-label="执行时间" className="text-xs">{new Date(batch.createdAt).toLocaleString()}</td>
                <td>
                  <button type="button" className="text-xs text-[var(--color-primary)] hover:underline" onClick={() => void toggle(batch.id)}>
                    {detail?.batchId === batch.id ? '收起' : '明细'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail && (
        <div className="text-xs border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)]" data-testid="admin-settlement-batch-detail">
          {(detail.items ?? []).map((item) => (
            <div key={item.settlementId} className="p-2 flex justify-between gap-2">
              <span className="font-mono">ORD-{item.orderId} · 结算单 #{item.settlementId}</span>
              <span>{item.amount.toLocaleString()} 积分 → 商家积分账户{item.walletOperationId ? `（凭证 #${item.walletOperationId}）` : ''}</span>
            </div>
          ))}
        </div>
      )}
      <AdminPagination page={page} total={total} pageSize={10} onPageChange={(p) => void load(p)} hideOnSinglePage />
    </section>
  )
}
