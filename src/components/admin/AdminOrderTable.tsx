import { useEffect, useRef, useState } from 'react'
import { Search, ShoppingCart, Calendar } from 'lucide-react'
import {
  getAdminOrders,
  getAdminOrderDetail,
  resolveAdminOrder,
  type AdminOrderItem,
  type AdminOrderDetail,
} from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { formatBookingDay, formatLocalDate } from '../../utils/formatLocalDate'
import RegistryPill from '../ui/RegistryPill'
import ProvisionBadge from '../ProvisionBadge'
import AdminPagination from './AdminPagination'
import AdminPanelHeader from './AdminPanelHeader'
import AdminOrderDetailDialog from './AdminOrderDetailDialog'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'

const PAGE_SIZE = 20

interface Props {
  active?: boolean
}

interface AppliedFilters {
  q: string
  status: string
  fromDate: string
  toDate: string
}

/** 订单记录 Tab：支持状态下拉、买家/订单号搜索、UTC 日期范围筛选、分页与订单履约详情 */
export default function AdminOrderTable({ active = true }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)

  const [orders, setOrders] = useState<AdminOrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Draft filters
  const [draftSearch, setDraftSearch] = useState('')
  const [draftStatus, setDraftStatus] = useState('')
  const [draftFromDate, setDraftFromDate] = useState('')
  const [draftToDate, setDraftToDate] = useState('')

  // Applied filters reference
  const appliedFiltersRef = useRef<AppliedFilters>({
    q: '',
    status: '',
    fromDate: '',
    toDate: '',
  })

  // In-flight request guards
  const reqSeqRef = useRef(0)
  const detailSeqRef = useRef(0)

  // Detail dialog state
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<AdminOrderDetail | null>(null)
  const [detailDialogOpen, setDetailDialogOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  // Dispute arbitration state
  const [resolveTarget, setResolveTarget] = useState<AdminOrderItem | null>(null)
  const [resolveResult, setResolveResult] = useState<'refund' | 'close'>('refund')
  const [resolveNote, setResolveNote] = useState('')
  const [resolving, setResolving] = useState(false)

  async function fetchOrders(pageArg = page, filtersArg = appliedFiltersRef.current) {
    const seq = ++reqSeqRef.current
    setLoading(true)
    try {
      const data = await getAdminOrders({
        page: pageArg,
        pageSize: PAGE_SIZE,
        status: filtersArg.status || undefined,
        q: filtersArg.q.trim() || undefined,
        fromDate: filtersArg.fromDate || undefined,
        toDate: filtersArg.toDate || undefined,
      })
      if (seq !== reqSeqRef.current) return
      setOrders(data.items)
      setTotal(data.total)
      setPage(data.page ?? pageArg)
    } catch (err: any) {
      if (seq !== reqSeqRef.current) return
      showToast(getApiErrorMessage(err, '加载订单列表失败'), 'error')
    } finally {
      if (seq === reqSeqRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!active) {
      reqSeqRef.current++
      detailSeqRef.current++
      return
    }
    void fetchOrders(page, appliedFiltersRef.current)
    return () => {
      reqSeqRef.current++
      detailSeqRef.current++
    }
  }, [active])

  function handleSearchSubmit() {
    if (draftFromDate && draftToDate && draftFromDate > draftToDate) {
      showToast('起始日期不能晚于结束日期', 'error')
      return
    }
    appliedFiltersRef.current = {
      q: draftSearch,
      status: draftStatus,
      fromDate: draftFromDate,
      toDate: draftToDate,
    }
    setPage(1)
    void fetchOrders(1, appliedFiltersRef.current)
  }

  function handleReset() {
    setDraftSearch('')
    setDraftStatus('')
    setDraftFromDate('')
    setDraftToDate('')
    appliedFiltersRef.current = {
      q: '',
      status: '',
      fromDate: '',
      toDate: '',
    }
    setPage(1)
    void fetchOrders(1, appliedFiltersRef.current)
  }

  function handlePageChange(nextPage: number) {
    void fetchOrders(nextPage, appliedFiltersRef.current)
  }

  async function handleOpenDetail(orderId: number) {
    const seq = ++detailSeqRef.current
    setSelectedOrderId(orderId)
    setDetailDialogOpen(true)
    setDetailLoading(true)
    setDetailError(null)
    setSelectedOrder(null)

    try {
      const detail = await getAdminOrderDetail(orderId)
      if (seq !== detailSeqRef.current) return
      setSelectedOrder(detail)
      setDetailError(null)
    } catch (err: any) {
      if (seq !== detailSeqRef.current) return
      const errMsg = getApiErrorMessage(err, '加载订单详情失败')
      setDetailError(errMsg)
      showToast(errMsg, 'error')
    } finally {
      if (seq === detailSeqRef.current) {
        setDetailLoading(false)
      }
    }
  }

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
      void fetchOrders(page, appliedFiltersRef.current)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '仲裁失败'), 'error')
    } finally {
      setResolving(false)
    }
  }

  const statusOptions = registry?.orderStatuses ?? []

  return (
    <div className="space-y-4">
      <AdminPanelHeader
        title="订单记录"
        description="全平台订单交易明细、状态跟踪与争议仲裁"
        actions={
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                type="text"
                value={draftSearch}
                onChange={(e) => setDraftSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearchSubmit()}
                placeholder="搜索买家邮箱 / 订单号"
                aria-label="搜索买家邮箱或订单号"
                data-testid="admin-order-search"
                className="input py-1.5 pl-8 w-44 text-xs"
              />
            </div>
            <select
              value={draftStatus}
              onChange={(e) => setDraftStatus(e.target.value)}
              aria-label="筛选订单状态"
              data-testid="admin-order-status-filter"
              className="input py-1.5 w-32 text-xs"
            >
              <option value="">全部状态</option>
              {statusOptions.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={draftFromDate}
                onChange={(e) => setDraftFromDate(e.target.value)}
                data-testid="admin-order-from-date"
                aria-label="起始日期"
                className="input py-1.5 w-32 text-xs"
              />
              <span className="text-xs text-[var(--color-text-muted)]">-</span>
              <input
                type="date"
                value={draftToDate}
                onChange={(e) => setDraftToDate(e.target.value)}
                data-testid="admin-order-to-date"
                aria-label="结束日期"
                className="input py-1.5 w-32 text-xs"
              />
            </div>
            <button
              type="button"
              onClick={handleSearchSubmit}
              className="btn-primary py-1.5 px-3 text-xs cursor-pointer"
              data-testid="admin-order-search-btn"
            >
              查询
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="btn-secondary py-1.5 px-3 text-xs cursor-pointer"
              data-testid="admin-order-reset-btn"
            >
              重置
            </button>
          </div>
        }
      />

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
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td data-label="订单号 / 时间">
                    <div className="font-mono text-xs text-[var(--color-text-muted)]">ORD-{o.id}</div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-1">
                      {new Date(o.createdAt).toLocaleString()}
                    </div>
                  </td>
                  <td className="text-sm" data-label="买家">
                    <div className="font-bold text-[var(--color-text)]">U{o.user?.id}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">{o.user?.email}</div>
                  </td>
                  <td className="text-[var(--color-text-muted)] text-sm" data-label="商品信息">
                    <div>{o.product?.name}</div>
                    {(o.bookingDate ||
                      o.delivery?.expiresAt ||
                      o.renewalOfOrderId != null ||
                      o.provisionTask) && (
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {o.bookingDate && (
                          <span
                            className="text-xs font-bold text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded border border-[var(--color-primary)]/20"
                            data-testid={`admin-order-booking-${o.id}`}
                          >
                            预约 {formatBookingDay(o.bookingDate)}
                          </span>
                        )}
                        {o.delivery?.expiresAt && (
                          <span
                            className={
                              o.delivery.expired
                                ? 'text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-1.5 py-0.5 rounded border border-[var(--color-danger)]/30'
                                : 'text-xs font-medium text-[var(--color-text-muted)] bg-[var(--color-background)] px-1.5 py-0.5 rounded border border-[var(--color-border)]'
                            }
                            data-testid={`admin-order-expiry-${o.id}`}
                          >
                            订阅至 {formatLocalDate(o.delivery.expiresAt)}
                            {o.delivery.expired ? ' 已过期' : ''}
                          </span>
                        )}
                        {o.renewalOfOrderId != null && (
                          <span
                            className="text-xs font-medium text-[var(--color-text-muted)] bg-[var(--color-background)] px-1.5 py-0.5 rounded border border-[var(--color-border)]"
                            data-testid={`admin-order-renewal-${o.id}`}
                          >
                            续费自 #{o.renewalOfOrderId}
                          </span>
                        )}
                        {o.provisionTask && (
                          <span data-testid={`admin-order-provision-${o.id}`}>
                            <ProvisionBadge task={o.provisionTask} idSuffix={o.id} />
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="text-[var(--color-cta)] font-bold" data-label="扣除积分">
                    {o.price}
                  </td>
                  <td data-label="状态">
                    <RegistryPill value={o.status} category="orderStatuses" />
                  </td>
                  <td className="text-right space-x-2 whitespace-nowrap" data-label="操作">
                    <button
                      type="button"
                      className="btn-secondary btn-sm text-xs px-2.5 py-1 cursor-pointer"
                      data-testid={`admin-order-detail-${o.id}`}
                      onClick={() => handleOpenDetail(o.id)}
                    >
                      详情
                    </button>
                    {o.status === 'disputed' && (
                      <button
                        type="button"
                        className="btn-primary btn-sm text-xs px-2.5 py-1 cursor-pointer"
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
                    <EmptyState
                      compact
                      icon={ShoppingCart}
                      title="暂无订单"
                      description="调整筛选或搜索条件试试"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <AdminPagination
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        onPageChange={handlePageChange}
        testId="admin-order-pagination"
      />

      {/* Order Arbitration Dialog */}
      <Dialog
        open={resolveTarget !== null}
        onOpenChange={(open) => {
          if (!open && !resolving) setResolveTarget(null)
        }}
      >
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
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-sm"
              disabled={resolving}
              onClick={() => setResolveTarget(null)}
            >
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

      {/* Order Detail Dialog with Sensitive Compliance Boundary */}
      <AdminOrderDetailDialog
        order={selectedOrder}
        open={detailDialogOpen}
        loading={detailLoading}
        error={detailError}
        onRetry={selectedOrderId != null ? () => handleOpenDetail(selectedOrderId) : undefined}
        onOpenChange={(open) => {
          setDetailDialogOpen(open)
          if (!open) {
            detailSeqRef.current++
            setDetailError(null)
          }
        }}
      />
    </div>
  )
}
