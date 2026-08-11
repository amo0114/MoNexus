import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronLeft, ChevronRight, Loader2, History } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import EmptyState from '../ui/EmptyState'
import { useAppStore } from '../../stores/appStore'
import { getMerchantInventoryLogs, InventoryLog } from '../../api/merchant'
import type { MerchantProduct } from '../../types/merchant'
import { createLatestRequestGuard } from '../../utils/latestRequest'

const PAGE_SIZE = 10

interface Props {
  isOpen: boolean
  onClose: () => void
  product: MerchantProduct | null
}

export default function MerchantInventoryLogModal({ isOpen, onClose, product }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [logs, setLogs] = useState<InventoryLog[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const loadRequestGuard = useRef(createLatestRequestGuard()).current

  const productId = product?.id
  const offerNames = new Map((product?.offers ?? []).map((offer) => [offer.id, offer.name]))
  const resourceLabel = '可售资源'

  const loadLogs = useCallback(async (targetPage: number) => {
    if (!productId) return
    const canCommit = loadRequestGuard.begin()
    setLoading(true)
    try {
      const data = await getMerchantInventoryLogs(productId, { page: targetPage, pageSize: PAGE_SIZE })
      if (!canCommit()) return
      setLogs(data.items)
      setTotal(data.total)
    } catch (e: any) {
      if (!canCommit()) return
      showToast(e.response?.data?.error?.message || `${resourceLabel}记录加载失败`, 'error')
    } finally {
      if (canCommit()) setLoading(false)
    }
  }, [loadRequestGuard, productId, showToast])

  useEffect(() => {
    if (isOpen && productId) {
      setPage(1)
      loadLogs(1)
    } else {
      loadRequestGuard.invalidate()
      setLoading(false)
    }
    return () => loadRequestGuard.invalidate()
  }, [isOpen, productId, loadLogs, loadRequestGuard])

  function changePage(next: number) {
    setPage(next)
    loadLogs(next)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85dvh] overflow-y-auto" data-testid="inventory-log-modal">
        <DialogTitle>{resourceLabel}记录</DialogTitle>
        <DialogDescription>
          商品：{product?.name ?? ''}（仅保留数量、订单与操作原因，不展示交付内容）
        </DialogDescription>

        {/* 流水列表 */}
        <div className="mt-4 overflow-x-auto">
          <table className="table-cards w-full text-left border-collapse" data-testid="inventory-log-table">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">时间</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">动作</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">目标规格</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider text-right">数量</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">操作人</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">备注</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--color-text-muted)] text-sm">
                    <Loader2 className="w-5 h-5 animate-spin inline" />
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState compact icon={History} title="暂无流水记录" />
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="border-b border-[var(--color-border)]">
                    <td className="py-2.5 px-2 text-xs text-[var(--color-text-muted)] whitespace-nowrap" data-label="时间">
                      {new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td className="py-2.5 px-2 text-sm" data-label="动作">
                      {log.action === 'import' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25">
                          导入
                        </span>
                      ) : log.action === 'sale' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border bg-blue-500/10 text-blue-600 border-blue-500/25">
                          售出
                        </span>
                      ) : log.action === 'capacity_adjust' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border bg-amber-500/10 text-amber-700 border-amber-500/25">
                          名额调整
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/25">
                          作废
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-2 text-xs text-[var(--color-text-muted)]" data-label="目标规格">
                      {log.offerId == null ? '历史默认规格' : (offerNames.get(log.offerId) ?? `#${log.offerId}`)}
                    </td>
                    <td className={`py-2.5 px-2 text-sm text-right font-mono font-bold ${log.delta >= 0 ? 'text-[var(--color-cta)]' : 'text-[var(--color-danger)]'}`} data-label="数量">
                      {log.delta >= 0 ? `+${log.delta}` : log.delta}
                    </td>
                    <td className="py-2.5 px-2 text-sm text-[var(--color-text-muted)]" data-label="操作人">#{log.actorUserId}</td>
                    <td className="py-2.5 px-2 text-xs text-[var(--color-text-muted)] max-w-[180px] truncate" title={log.reason || (log.orderId ? `订单 #${log.orderId}` : '')} data-label="备注">
                      {log.reason || (log.orderId ? `订单 #${log.orderId}` : log.batchId ? `导入批次 ${log.batchId.slice(0, 8)}` : '-')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 流水分页 */}
        <div className="flex items-center justify-between mt-3" data-testid="inventory-log-pagination">
          <div className="text-xs text-[var(--color-text-muted)]">
            共 {total} 条，第 {page} / {totalPages} 页
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => changePage(Math.max(1, page - 1))}
              disabled={page <= 1 || loading}
              className="btn-secondary btn-sm disabled:opacity-50 flex items-center cursor-pointer"
              aria-label="上一页"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => changePage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages || loading}
              className="btn-secondary btn-sm disabled:opacity-50 flex items-center cursor-pointer"
              aria-label="下一页"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

      </DialogContent>
    </Dialog>
  )
}
