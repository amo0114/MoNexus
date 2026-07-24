import { useEffect, useState } from 'react'
import { Search, ShoppingCart } from 'lucide-react'
import { getAdminOrders, resolveAdminOrder, AdminOrderItem } from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import RegistryPill from '../ui/RegistryPill'
import AdminPagination from './AdminPagination'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'

const PAGE_SIZE = 20

/** 订单记录 Tab：状态下拉筛选 + 搜索（邮箱模糊 / 纯数字订单号精确）+ 分页 */
export default function AdminOrderTable() {
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)

  const [orders, setOrders] = useState<AdminOrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')
  const [resolveTarget, setResolveTarget] = useState<AdminOrderItem | null>(null)
  const [resolveResult, setResolveResult] = useState<'refund' | 'close'>('refund')
  const [resolveNote, setResolveNote] = useState('')
  const [resolving, setResolving] = useState(false)
  const [loading, setLoading] = useState(true)

  // 搜索 300ms 防抖，筛选变化时重置页码到 1
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounced(search.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    fetchOrders()
  }, [page, statusFilter, searchDebounced])

  async function fetchOrders() {
    setLoading(true)
    try {
      const data = await getAdminOrders({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter || undefined,
        q: searchDebounced || undefined,
      })
      setOrders(data.items)
      setTotal(data.total)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载订单列表失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const statusOptions = registry?.orderStatuses ?? []

  async function handleResolveSubmit() {
    if (!resolveTarget) return
    setResolving(true)
    try {
      await resolveAdminOrder(resolveTarget.id, {
        result: resolveResult,
        note: resolveNote.trim() || undefined,
      })
      showToast(resolveResult === 'refund' ? '已仲裁退款' : '已仲裁关闭')
      setResolveTarget(null)
      setResolveNote('')
      fetchOrders()
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '仲裁失败'), 'error')
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">订单记录</h2>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索买家邮箱 / 订单号"
            data-testid="admin-order-search"
            className="input py-1.5 pl-8 w-64"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value)
            setPage(1)
          }}
          data-testid="admin-order-status-filter"
          className="input py-1.5 w-36"
        >
          <option value="">全部状态</option>
          {statusOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        {loading && orders.length === 0 ? (
          <TableSkeleton />
        ) : (
        <table className="admin-table table-cards">
          <thead>
            <tr>
              <th>订单号 / 时间</th>
              <th>买家</th>
              <th>商品信息</th>
              <th>扣除积分</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td data-label="订单号 / 时间">
                  <div className="font-mono text-xs text-[var(--color-text-muted)]">ORD-{o.id}</div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-1">{new Date(o.createdAt).toLocaleString()}</div>
                </td>
                <td className="text-sm" data-label="买家">
                  <div className="font-bold text-[var(--color-text)]">U{o.user?.id}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{o.user?.email}</div>
                </td>
                <td className="text-[var(--color-text-muted)] text-sm" data-label="商品信息">{o.product?.name}</td>
                <td className="text-[var(--color-cta)] font-bold" data-label="扣除积分">{o.price}</td>
                <td data-label="状态">
                  <RegistryPill value={o.status} category="orderStatuses" />
                </td>
                <td data-label="操作">
                  {o.status === 'disputed' && (
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      data-testid={`admin-resolve-order-${o.id}`}
                      onClick={() => {
                        setResolveTarget(o)
                        setResolveResult('refund')
                        setResolveNote('')
                      }}
                    >
                      仲裁
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && orders.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState compact icon={ShoppingCart} title="暂无订单" description="调整筛选或搜索条件试试" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      <Dialog open={resolveTarget !== null} onOpenChange={(open) => { if (!open && !resolving) setResolveTarget(null) }}>
        <DialogContent className="!z-[120]" data-testid="admin-resolve-dialog">
          <DialogTitle>仲裁争议订单</DialogTitle>
          <DialogDescription>
            订单 ORD-{resolveTarget?.id}（{resolveTarget?.product?.name}）。选择支持用户退款或支持商家关闭订单。
          </DialogDescription>
          <div className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="resolve-result"
                checked={resolveResult === 'refund'}
                onChange={() => setResolveResult('refund')}
                data-testid="admin-resolve-refund"
              />
              支持用户（退款 refunded，结算作废）
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="resolve-result"
                checked={resolveResult === 'close'}
                onChange={() => setResolveResult('close')}
                data-testid="admin-resolve-close"
              />
              支持商家（关闭 closed，进入可结算）
            </label>
            <div>
              <label className="block text-xs font-medium mb-1">备注（可选）</label>
              <textarea
                className="input min-h-[72px] resize-y"
                value={resolveNote}
                onChange={(e) => setResolveNote(e.target.value)}
                maxLength={1000}
                data-testid="admin-resolve-note"
              />
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <button type="button" className="btn-secondary px-4 py-2 text-sm" disabled={resolving} onClick={() => setResolveTarget(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary px-4 py-2 text-sm"
              disabled={resolving}
              onClick={handleResolveSubmit}
              data-testid="admin-resolve-confirm"
            >
              {resolving ? '提交中…' : '确认仲裁'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} testId="admin-order-pagination" />
    </div>
  )
}
