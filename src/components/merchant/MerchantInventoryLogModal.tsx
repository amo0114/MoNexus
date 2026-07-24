import { useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { useAppStore } from '../../stores/appStore'
import { getMerchantInventoryLogs, voidMerchantInventory, InventoryLog } from '../../api/merchant'

const PAGE_SIZE = 10

interface Props {
  isOpen: boolean
  onClose: () => void
  product: { id: number; name: string; deliveryMode?: 'instant_inventory' | 'instant_fixed' | 'manual_service' } | null
  /** 作废成功后通知父级刷新商品列表（库存数变化）。名额记录页不显示作废操作。 */
  onVoided: () => void
}

export default function MerchantInventoryLogModal({ isOpen, onClose, product, onVoided }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [logs, setLogs] = useState<InventoryLog[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  const [voidCount, setVoidCount] = useState('')
  const [voidReason, setVoidReason] = useState('')
  const [voiding, setVoiding] = useState(false)

  const productId = product?.id
  const inventoryManaged = (product?.deliveryMode ?? 'instant_inventory') === 'instant_inventory'
  const resourceLabel = inventoryManaged ? '交付库存' : product?.deliveryMode === 'manual_service' ? '服务名额' : '可售名额'

  const loadLogs = useCallback(async (targetPage: number) => {
    if (!productId) return
    setLoading(true)
    try {
      const data = await getMerchantInventoryLogs(productId, { page: targetPage, pageSize: PAGE_SIZE })
      setLogs(data.items)
      setTotal(data.total)
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || `${resourceLabel}记录加载失败`, 'error')
    } finally {
      setLoading(false)
    }
  }, [productId, showToast])

  useEffect(() => {
    if (isOpen && productId) {
      setPage(1)
      setVoidCount('')
      setVoidReason('')
      loadLogs(1)
    }
  }, [isOpen, productId, loadLogs])

  function changePage(next: number) {
    setPage(next)
    loadLogs(next)
  }

  async function handleVoidSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!productId) return
    const count = Number(voidCount)
    if (!Number.isInteger(count) || count <= 0) {
      showToast('作废数量必须是大于 0 的整数', 'error')
      return
    }
    setVoiding(true)
    try {
      const result = await voidMerchantInventory(productId, {
        count,
        reason: voidReason.trim() || undefined,
      })
      showToast(`已作废 ${result.voided} 个交付单元，剩余 ${result.stock} 个`)
      setVoidCount('')
      setVoidReason('')
      setPage(1)
      await loadLogs(1)
      onVoided()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '作废失败', 'error')
    } finally {
      setVoiding(false)
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="inventory-log-modal">
        <DialogTitle>{resourceLabel}记录</DialogTitle>
        <DialogDescription>
          商品：{product?.name ?? ''}（仅保留数量、订单与操作原因，不展示交付内容）
        </DialogDescription>

        {/* 流水列表 */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left border-collapse" data-testid="inventory-log-table">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">时间</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">动作</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider text-right">数量</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">操作人</th>
                <th className="py-2 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider">备注</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[var(--color-text-muted)] text-sm">
                    <Loader2 className="w-5 h-5 animate-spin inline" />
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[var(--color-text-muted)] text-sm">
                    暂无流水记录
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="border-b border-[var(--color-border)]">
                    <td className="py-2.5 px-2 text-xs text-[var(--color-text-muted)] whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td className="py-2.5 px-2 text-sm">
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
                    <td className={`py-2.5 px-2 text-sm text-right font-mono font-bold ${log.delta >= 0 ? 'text-[var(--color-cta)]' : 'text-[var(--color-danger)]'}`}>
                      {log.delta >= 0 ? `+${log.delta}` : log.delta}
                    </td>
                    <td className="py-2.5 px-2 text-sm text-[var(--color-text-muted)]">#{log.actorUserId}</td>
                    <td className="py-2.5 px-2 text-xs text-[var(--color-text-muted)] max-w-[180px] truncate" title={log.reason || (log.orderId ? `订单 #${log.orderId}` : '')}>
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
              className="btn-secondary px-2 py-1 text-xs disabled:opacity-50 flex items-center cursor-pointer"
              aria-label="上一页"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => changePage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages || loading}
              className="btn-secondary px-2 py-1 text-xs disabled:opacity-50 flex items-center cursor-pointer"
              aria-label="下一页"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 作废库存表单 */}
        {inventoryManaged && <form
          onSubmit={handleVoidSubmit}
          className="mt-5 pt-4 border-t border-[var(--color-border)] space-y-3"
          data-testid="inventory-void-form"
        >
          <h4 className="text-sm font-bold text-[var(--color-text)]">作废交付单元</h4>
          <p className="text-xs text-[var(--color-text-muted)]">
            按导入时间从早到晚作废可用交付单元，作废后不可恢复。
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="sm:w-40">
              <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
                数量 <span className="text-red-500 normal-case">*</span>
              </label>
              <input
                type="number"
                min="1"
                step="1"
                required
                placeholder="0"
                className="input font-mono"
                value={voidCount}
                onChange={(e) => setVoidCount(e.target.value)}
                data-testid="inventory-void-count"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
                原因 - 可选
              </label>
              <input
                type="text"
                maxLength={500}
                placeholder="例如：交付内容失效、上游撤回"
                className="input"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                data-testid="inventory-void-reason"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={voiding}
              className="btn-primary px-5 py-2 text-sm min-w-[120px]"
              data-testid="inventory-void-submit"
            >
              {voiding ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '确认作废'}
            </button>
          </div>
        </form>}
      </DialogContent>
    </Dialog>
  )
}
