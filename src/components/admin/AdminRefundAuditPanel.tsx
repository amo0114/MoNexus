import { useEffect, useRef, useState } from 'react'
import { RotateCcw, RefreshCw, Search, ShieldAlert, Copy, Check } from 'lucide-react'
import {
  listAdminRechargeRefunds,
  type AdminRechargeRefundItem,
} from '../../api/adminRecharge'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import AdminPagination from './AdminPagination'
import AdminPanelHeader from './AdminPanelHeader'
import EmptyState from '../ui/EmptyState'
import ErrorState from '../ui/ErrorState'
import { TableSkeleton } from '../ui/Skeleton'
import { formatCurrencyAmount, formatPoints } from '../../pages/recharge/money'
import { providerLabel, orderStatusLabel } from '../../pages/recharge/status'

const PAGE_SIZE = 20

export const REFUND_STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'requested', label: '已申请 (requested)' },
  { value: 'points_held', label: '积分已冻结 (points_held)' },
  { value: 'processing', label: '处理中 (processing)' },
  { value: 'succeeded', label: '已退款 (succeeded)' },
  { value: 'failed', label: '退款失败 (failed)' },
  { value: 'cancelled', label: '已取消 (cancelled)' },
  { value: 'manual_review', label: '待人工审核 (manual_review)' },
]

export function renderRefundStatusBadge(status: string) {
  const s = status.toLowerCase()
  if (s === 'succeeded') {
    return (
      <span
        data-testid="refund-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
      >
        已退款
      </span>
    )
  }
  if (s === 'failed') {
    return (
      <span
        data-testid="refund-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"
      >
        退款失败
      </span>
    )
  }
  if (s === 'processing') {
    return (
      <span
        data-testid="refund-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
      >
        处理中
      </span>
    )
  }
  if (s === 'points_held') {
    return (
      <span
        data-testid="refund-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20"
      >
        积分已冻结
      </span>
    )
  }
  if (s === 'manual_review') {
    return (
      <span
        data-testid="refund-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
      >
        待人工审核
      </span>
    )
  }
  if (s === 'cancelled') {
    return (
      <span
        data-testid="refund-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/10 text-gray-600 dark:text-gray-400 border border-gray-500/20"
      >
        已取消
      </span>
    )
  }
  if (s === 'requested') {
    return (
      <span
        data-testid="refund-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
      >
        已申请
      </span>
    )
  }
  return (
    <span
      data-testid="refund-status-badge"
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/10 text-gray-600 dark:text-gray-400 border border-gray-500/20"
    >
      {status}
    </span>
  )
}

export function renderReversalStatusBadge(status: string | null) {
  if (status === 'completed') {
    return (
      <span
        data-testid="reversal-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
      >
        已冲正
      </span>
    )
  }
  if (status === 'pending') {
    return (
      <span
        data-testid="reversal-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
      >
        冲正中
      </span>
    )
  }
  if (status === 'not_required') {
    return (
      <span
        data-testid="reversal-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/10 text-gray-600 dark:text-gray-400 border border-gray-500/20"
      >
        无需冲正
      </span>
    )
  }
  if (status === 'terminated') {
    return (
      <span
        data-testid="reversal-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/10 text-gray-500 dark:text-gray-400 border border-gray-500/20"
      >
        未冲正/已终止
      </span>
    )
  }
  if (status === 'anomaly') {
    return (
      <span
        data-testid="reversal-status-badge"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 font-semibold"
      >
        异常待核查
      </span>
    )
  }
  return <span data-testid="reversal-status-badge" className="text-xs text-[var(--color-text-muted)]">—</span>
}

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

interface RefundFilterSnapshot {
  status?: string
  userId?: string
  orderId?: string
}

export interface AdminRefundAuditPanelProps {
  active?: boolean
}

export default function AdminRefundAuditPanel({ active = true }: AdminRefundAuditPanelProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminRechargeRefundItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Input states in UI
  const [inputStatus, setInputStatus] = useState('')
  const [inputUserId, setInputUserId] = useState('')
  const [inputOrderId, setInputOrderId] = useState('')
  const [orderIdError, setOrderIdError] = useState<string | null>(null)
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null)

  // Active filters applied to query
  const appliedFiltersRef = useRef<RefundFilterSnapshot>({})
  const reqSeqRef = useRef(0)

  const handleCopyOrderId = async (orderId: string) => {
    try {
      await navigator.clipboard.writeText(orderId)
      setCopiedOrderId(orderId)
      showToast('订单号已复制')
      setTimeout(() => setCopiedOrderId(null), 2000)
    } catch {
      showToast('复制失败，请手动选择复制', 'error')
    }
  }

  async function fetchRefunds(opts?: { page?: number; filters?: RefundFilterSnapshot }) {
    const seq = ++reqSeqRef.current
    const targetPage = opts?.page ?? page
    const filters = opts && 'filters' in opts ? (opts.filters ?? {}) : appliedFiltersRef.current

    setLoading(true)
    setLoadError(null)

    try {
      const queryParams: Parameters<typeof listAdminRechargeRefunds>[0] = {
        page: targetPage,
        pageSize: PAGE_SIZE,
      }
      if (filters.status) queryParams.status = filters.status
      if (filters.userId && !Number.isNaN(Number(filters.userId))) {
        queryParams.userId = Number(filters.userId)
      }
      if (filters.orderId) queryParams.orderId = filters.orderId.trim()

      const data = await listAdminRechargeRefunds(queryParams)
      if (seq !== reqSeqRef.current) return

      setItems(data.items)
      setTotal(data.total)
      setPage(targetPage)
    } catch (err: any) {
      if (seq !== reqSeqRef.current) return
      const message = getApiErrorMessage(err, '加载退款记录失败')
      setLoadError(message)
      showToast(message, 'error')
    } finally {
      if (seq === reqSeqRef.current) {
        setLoading(false)
      }
    }
  }

  function handleSearch(e?: React.FormEvent) {
    if (e) e.preventDefault()
    const trimmedOrderId = inputOrderId.trim()
    if (trimmedOrderId && !UUID_REGEX.test(trimmedOrderId)) {
      setOrderIdError('订单号必须是 36 位规范完整 UUID (例如 c0a80101-0000-4000-8000-000000000001)')
      return
    }
    setOrderIdError(null)

    const newFilters: RefundFilterSnapshot = {
      status: inputStatus,
      userId: inputUserId.trim(),
      orderId: trimmedOrderId,
    }
    appliedFiltersRef.current = newFilters
    void fetchRefunds({ page: 1, filters: newFilters })
  }

  function handleReset() {
    setInputStatus('')
    setInputUserId('')
    setInputOrderId('')
    setOrderIdError(null)
    appliedFiltersRef.current = {}
    void fetchRefunds({ page: 1, filters: {} })
  }

  useEffect(() => {
    if (!active) {
      reqSeqRef.current++
      return
    }
    void fetchRefunds({ page: 1, filters: appliedFiltersRef.current })
    return () => {
      reqSeqRef.current++
    }
  }, [active])

  return (
    <div className="space-y-4" data-testid="admin-refund-audit-panel">
      <AdminPanelHeader
        title="退款审核与流水"
        description="独立退款流水与资金审批审计，支持按退款状态、用户ID与订单号定向对账"
        actions={
          <button
            type="button"
            onClick={() => fetchRefunds()}
            className="btn-secondary btn-sm text-xs flex items-center gap-1.5 cursor-pointer"
            data-testid="admin-refund-refresh-button"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        }
      />

      {/* Filter Bar */}
      <form
        onSubmit={handleSearch}
        noValidate
        className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]"
        data-testid="admin-refund-filter-form"
      >
        <div className="flex items-center gap-2">
          <label htmlFor="admin-refund-status-select" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            状态:
          </label>
          <select
            id="admin-refund-status-select"
            value={inputStatus}
            onChange={(e) => setInputStatus(e.target.value)}
            className="input py-1.5 text-xs w-36"
            data-testid="admin-refund-status-filter"
          >
            {REFUND_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="admin-refund-user-id-input" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            用户ID:
          </label>
          <input
            id="admin-refund-user-id-input"
            type="number"
            placeholder="输入用户ID"
            value={inputUserId}
            onChange={(e) => setInputUserId(e.target.value)}
            className="input py-1.5 text-xs w-28"
            data-testid="admin-refund-user-id-filter"
          />
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <label htmlFor="admin-refund-order-id-input" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
              订单号:
            </label>
            <input
              id="admin-refund-order-id-input"
              type="text"
              placeholder="输入完整订单号 (UUID)"
              value={inputOrderId}
              maxLength={36}
              pattern="^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
              aria-invalid={Boolean(orderIdError)}
              aria-describedby={orderIdError ? 'admin-refund-order-id-error' : undefined}
              onChange={(e) => {
                setInputOrderId(e.target.value)
                if (orderIdError) setOrderIdError(null)
              }}
              className={`input py-1.5 text-xs w-64 font-mono ${orderIdError ? '!border-red-500 focus:!border-red-500' : ''}`}
              data-testid="admin-refund-order-id-filter"
            />
          </div>
          {orderIdError && (
            <span
              id="admin-refund-order-id-error"
              className="text-[11px] text-red-500 pl-12"
              data-testid="admin-refund-order-id-error"
            >
              {orderIdError}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="submit"
            className="btn-primary btn-sm text-xs flex items-center gap-1 cursor-pointer"
            data-testid="admin-refund-search-button"
          >
            <Search className="w-3.5 h-3.5" />
            <span>查询</span>
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="btn-secondary btn-sm text-xs cursor-pointer"
            data-testid="admin-refund-reset-button"
          >
            重置
          </button>
        </div>
      </form>

      {/* Main Content: Skeleton / Error / Empty / Table */}
      {loading ? (
        <TableSkeleton />
      ) : loadError ? (
        <ErrorState
          title="加载退款记录失败"
          description={loadError}
          onRetry={() => fetchRefunds()}
          testId="admin-refund-error-state"
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={RotateCcw}
          title="暂无退款记录"
          description="未匹配到任何符合条件的退款记录或申请"
          action={
            (appliedFiltersRef.current.status || appliedFiltersRef.current.userId || appliedFiltersRef.current.orderId) ? (
              <button
                type="button"
                onClick={handleReset}
                className="btn-secondary btn-sm text-xs cursor-pointer"
              >
                清空筛选条件
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="admin-table table-cards" data-testid="admin-refund-table">
            <thead>
              <tr>
                <th>退款编号 / 订单</th>
                <th>用户</th>
                <th>退款金额 / 冲正积分</th>
                <th>支付渠道 / 方式</th>
                <th>退款状态</th>
                <th>冲正状态</th>
                <th>失败原因 / 备注</th>
                <th>申请时间 / 申请人</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.refundId} data-testid={`admin-refund-row-${item.refundId}`}>
                  <td data-label="退款编号 / 订单" data-testid={`admin-refund-row-${item.orderId}`}>
                    <div className="font-mono text-xs font-semibold text-[var(--color-text)]" title={item.refundId}>
                      {item.refundId.slice(0, 8)}…
                    </div>
                    <div className="font-mono text-[11px] text-[var(--color-text-muted)] flex items-center gap-1.5">
                      <span title={item.orderId} data-testid={`admin-refund-order-id-text-${item.refundId}`}>
                        订单: {item.orderId.slice(0, 8)}…
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyOrderId(item.orderId)}
                        title={`复制完整订单号: ${item.orderId}`}
                        aria-label={`复制完整订单号 ${item.orderId}`}
                        className="p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors cursor-pointer rounded"
                        data-testid={`admin-refund-copy-order-btn-${item.orderId}`}
                      >
                        {copiedOrderId === item.orderId ? (
                          <Check className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                    {item.rechargeOrder?.status && (
                      <div className="text-[11px] text-[var(--color-text-muted)] font-medium">
                        {orderStatusLabel(item.rechargeOrder.status)}
                      </div>
                    )}
                  </td>
                  <td data-label="用户">
                    <span className="font-mono text-xs">#{item.rechargeOrder?.userId ?? '—'}</span>
                  </td>
                  <td data-label="退款金额 / 冲正积分">
                    <div className="whitespace-nowrap font-medium text-xs">
                      {formatCurrencyAmount(item.amountMinor, item.rechargeOrder?.currency ?? 'CNY')}
                    </div>
                    <div className="text-xs text-[var(--color-cta)]">
                      -{formatPoints(item.pointsToReverse)} RP
                    </div>
                  </td>
                  <td data-label="支付渠道 / 方式">
                    <div className="text-xs font-medium">
                      {providerLabel(item.rechargeOrder?.provider ?? 'simulator')}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {item.rechargeOrder?.paymentMethod ?? '—'}
                    </div>
                  </td>
                  <td data-label="退款状态">
                    {renderRefundStatusBadge(item.refundStatus)}
                  </td>
                  <td data-label="冲正状态">
                    {renderReversalStatusBadge(item.reversalStatus)}
                  </td>
                  <td data-label="失败原因 / 备注">
                    {item.failureReason ? (
                      <span className="text-xs text-red-600 dark:text-red-400 font-medium inline-flex items-center gap-1">
                        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                        {item.failureReason}
                      </span>
                    ) : item.reasonCode ? (
                      <span className="text-xs text-[var(--color-text-muted)]">{item.reasonCode}</span>
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)]">—</span>
                    )}
                  </td>
                  <td data-label="申请时间 / 申请人">
                    <div className="text-xs whitespace-nowrap">
                      {new Date(item.createdAt).toLocaleString('zh-CN')}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      申请人: #{item.requesterUserId ?? item.createdByUserId}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {!loading && !loadError && total > 0 && (
        <AdminPagination
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={(nextPage) => fetchRefunds({ page: nextPage })}
          testId="admin-pagination"
        />
      )}
    </div>
  )
}
