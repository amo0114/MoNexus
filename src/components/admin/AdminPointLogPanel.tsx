import { useEffect, useRef, useState } from 'react'
import { Activity, RefreshCw, RotateCcw, Search } from 'lucide-react'
import {
  listAdminPointLogs,
  type AdminPointLogItem,
  type ListAdminPointLogsParams,
} from '../../api/adminPointLogs'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import AdminPagination from './AdminPagination'
import AdminPanelHeader from './AdminPanelHeader'
import EmptyState from '../ui/EmptyState'
import ErrorState from '../ui/ErrorState'
import { TableSkeleton } from '../ui/Skeleton'
import { pointLogVisual, formatPointLogAmount } from '../../utils/pointLogDisplay'

const PAGE_SIZE = 20

export const POINT_LOG_TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'in', label: '入账' },
  { value: 'out', label: '已支付' },
  { value: 'hold', label: '待支付' },
  { value: 'release', label: '已返还' },
  { value: 'refund', label: '退款' },
  { value: 'sandbox_in', label: '沙箱入账' },
]

interface PointLogFilterSnapshot {
  userId?: string
  email?: string
  type?: string
  from?: string
  to?: string
}

export interface AdminPointLogPanelProps {
  active?: boolean
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function AdminPointLogPanel({ active = true }: AdminPointLogPanelProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminPointLogItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Input states in filter form
  const [inputUserId, setInputUserId] = useState('')
  const [inputEmail, setInputEmail] = useState('')
  const [inputType, setInputType] = useState('')
  const [inputFrom, setInputFrom] = useState('')
  const [inputTo, setInputTo] = useState('')

  // Validation error states
  const [userIdError, setUserIdError] = useState<string | null>(null)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [dateError, setDateError] = useState<string | null>(null)

  // Active filter snapshot & race condition sequence ref
  const appliedFiltersRef = useRef<PointLogFilterSnapshot>({})
  const reqSeqRef = useRef(0)

  async function fetchLogs(opts?: { page?: number; filters?: PointLogFilterSnapshot }) {
    const seq = ++reqSeqRef.current
    const targetPage = opts?.page ?? page
    const filters = opts && 'filters' in opts ? (opts.filters ?? {}) : appliedFiltersRef.current

    setLoading(true)
    setLoadError(null)

    try {
      const queryParams: ListAdminPointLogsParams = {
        page: targetPage,
        pageSize: PAGE_SIZE,
      }

      if (
        filters.userId &&
        /^[1-9]\d*$/.test(filters.userId) &&
        Number(filters.userId) <= Number.MAX_SAFE_INTEGER
      ) {
        queryParams.userId = Number(filters.userId)
      }
      if (filters.email) {
        queryParams.email = filters.email.trim().toLowerCase()
      }
      if (filters.type) {
        queryParams.type = filters.type
      }
      if (filters.from) {
        queryParams.from = filters.from
      }
      if (filters.to) {
        queryParams.to = filters.to
      }

      const data = await listAdminPointLogs(queryParams)
      if (seq !== reqSeqRef.current) return

      setItems(data.items)
      setTotal(data.total)
      setPage(targetPage)
    } catch (err) {
      if (seq !== reqSeqRef.current) return
      const message =
        err instanceof Error && err.message && !('response' in (err as unknown as Record<string, unknown>))
          ? err.message
          : getApiErrorMessage(err, '加载积分流水失败')
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

    let hasError = false

    // Validate User ID: must be a positive safe integer (> 0)
    const trimmedUserId = inputUserId.trim()
    if (trimmedUserId) {
      if (
        !/^[1-9]\d*$/.test(trimmedUserId) ||
        Number(trimmedUserId) > Number.MAX_SAFE_INTEGER
      ) {
        setUserIdError('用户 ID 必须为有效的正整数')
        hasError = true
      } else {
        setUserIdError(null)
      }
    } else {
      setUserIdError(null)
    }

    // Validate Email
    const trimmedEmail = inputEmail.trim()
    if (trimmedEmail && !EMAIL_REGEX.test(trimmedEmail)) {
      setEmailError('请输入有效的邮箱地址')
      hasError = true
    } else {
      setEmailError(null)
    }

    // Validate Date range
    if (inputFrom && inputTo && inputFrom > inputTo) {
      setDateError('开始日期不能晚于结束日期')
      hasError = true
    } else {
      setDateError(null)
    }

    if (hasError) return

    const newFilters: PointLogFilterSnapshot = {
      userId: trimmedUserId || undefined,
      email: trimmedEmail || undefined,
      type: inputType || undefined,
      from: inputFrom || undefined,
      to: inputTo || undefined,
    }

    appliedFiltersRef.current = newFilters
    void fetchLogs({ page: 1, filters: newFilters })
  }

  function handleReset() {
    setInputUserId('')
    setInputEmail('')
    setInputType('')
    setInputFrom('')
    setInputTo('')
    setUserIdError(null)
    setEmailError(null)
    setDateError(null)
    appliedFiltersRef.current = {}
    void fetchLogs({ page: 1, filters: {} })
  }

  useEffect(() => {
    if (!active) {
      reqSeqRef.current++
      return
    }

    void fetchLogs({ page: 1, filters: appliedFiltersRef.current })

    return () => {
      reqSeqRef.current++
    }
  }, [active])

  const hasActiveFilters = Object.values(appliedFiltersRef.current).some(Boolean)

  return (
    <div className="space-y-4" data-testid="admin-point-log-panel">
      <AdminPanelHeader
        title="积分流水"
        description="全平台用户积分收支流水记录与实时余额跟踪"
        actions={
          <button
            type="button"
            onClick={() => fetchLogs()}
            className="btn-secondary btn-sm text-xs flex items-center gap-1.5 cursor-pointer"
            data-testid="admin-point-logs-refresh-button"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        }
      />

      {/* Filter Toolbar */}
      <form
        onSubmit={handleSearch}
        noValidate
        className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]"
        data-testid="admin-point-logs-filter-form"
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <label htmlFor="admin-point-log-user-id" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
              用户 ID:
            </label>
            <input
              id="admin-point-log-user-id"
              type="text"
              placeholder="用户 ID"
              value={inputUserId}
              aria-invalid={Boolean(userIdError)}
              aria-describedby={userIdError ? 'admin-point-log-user-id-error' : undefined}
              onChange={(e) => {
                setInputUserId(e.target.value)
                if (userIdError) setUserIdError(null)
              }}
              className={`input py-1.5 text-xs w-24 ${userIdError ? '!border-red-500 focus:!border-red-500' : ''}`}
              data-testid="admin-point-logs-user-id-filter"
            />
          </div>
          {userIdError && (
            <span
              id="admin-point-log-user-id-error"
              className="text-[11px] text-red-500 pl-14"
              data-testid="admin-point-logs-user-id-error"
            >
              {userIdError}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <label htmlFor="admin-point-log-email" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
              邮箱:
            </label>
            <input
              id="admin-point-log-email"
              type="text"
              placeholder="精确用户邮箱"
              value={inputEmail}
              aria-invalid={Boolean(emailError)}
              aria-describedby={emailError ? 'admin-point-log-email-error' : undefined}
              onChange={(e) => {
                setInputEmail(e.target.value)
                if (emailError) setEmailError(null)
              }}
              className={`input py-1.5 text-xs w-44 ${emailError ? '!border-red-500 focus:!border-red-500' : ''}`}
              data-testid="admin-point-logs-email-filter"
            />
          </div>
          {emailError && (
            <span
              id="admin-point-log-email-error"
              className="text-[11px] text-red-500 pl-10"
              data-testid="admin-point-logs-email-error"
            >
              {emailError}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="admin-point-log-type" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            类型:
          </label>
          <select
            id="admin-point-log-type"
            value={inputType}
            onChange={(e) => setInputType(e.target.value)}
            className="input py-1.5 text-xs w-36"
            data-testid="admin-point-logs-type-filter"
          >
            {POINT_LOG_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <label htmlFor="admin-point-log-from" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
              开始日期:
            </label>
            <input
              id="admin-point-log-from"
              type="date"
              value={inputFrom}
              aria-invalid={Boolean(dateError)}
              aria-describedby={dateError ? 'admin-point-log-date-error' : undefined}
              onChange={(e) => {
                setInputFrom(e.target.value)
                if (dateError) setDateError(null)
              }}
              className={`input py-1.5 text-xs w-36 ${dateError ? '!border-red-500 focus:!border-red-500' : ''}`}
              data-testid="admin-point-logs-from-filter"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <label htmlFor="admin-point-log-to" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
              结束日期:
            </label>
            <input
              id="admin-point-log-to"
              type="date"
              value={inputTo}
              aria-invalid={Boolean(dateError)}
              aria-describedby={dateError ? 'admin-point-log-date-error' : undefined}
              onChange={(e) => {
                setInputTo(e.target.value)
                if (dateError) setDateError(null)
              }}
              className={`input py-1.5 text-xs w-36 ${dateError ? '!border-red-500 focus:!border-red-500' : ''}`}
              data-testid="admin-point-logs-to-filter"
            />
          </div>
        </div>

        {dateError && (
          <div className="w-full">
            <span
              id="admin-point-log-date-error"
              className="text-[11px] text-red-500"
              data-testid="admin-point-logs-date-error"
            >
              {dateError}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="submit"
            className="btn-primary btn-sm text-xs flex items-center gap-1 cursor-pointer"
            data-testid="admin-point-logs-search-button"
          >
            <Search className="w-3.5 h-3.5" />
            <span>查询</span>
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="btn-secondary btn-sm text-xs flex items-center gap-1 cursor-pointer"
            data-testid="admin-point-logs-reset-button"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>重置</span>
          </button>
        </div>
      </form>

      {/* Main Content Area */}
      {loadError ? (
        <ErrorState description={loadError} onRetry={() => fetchLogs()} />
      ) : loading && items.length === 0 ? (
        <TableSkeleton />
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="admin-table table-cards" data-testid="admin-point-logs-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>关联用户</th>
                  <th>类型</th>
                  <th>事件描述</th>
                  <th className="text-right">积分变动</th>
                  <th className="text-right">变动后余额</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => {
                  const visual = pointLogVisual(l.type)
                  const formattedAmount = formatPointLogAmount(l.type, l.amount)
                  return (
                    <tr key={l.id} data-testid="admin-point-log-row">
                      <td className="text-[var(--color-text-muted)] text-xs" data-label="时间">
                        {new Date(l.createdAt).toLocaleString()}
                      </td>
                      <td className="text-sm" data-label="关联用户">
                        <div className="font-bold text-[var(--color-text)]">
                          U{l.user?.id ?? l.userId}
                        </div>
                        {l.user?.email && (
                          <div className="text-xs text-[var(--color-text-muted)] truncate max-w-[160px]">
                            {l.user.email}
                          </div>
                        )}
                      </td>
                      <td data-label="类型">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${visual.iconWrapClass}`}
                          data-testid="point-log-type-badge"
                        >
                          {visual.typeLabel}
                        </span>
                      </td>
                      <td className="text-sm text-[var(--color-text-muted)]" data-label="事件描述">
                        <div>{l.reason || '—'}</div>
                        {l.orderId && (
                          <div className="text-[11px] text-[var(--color-primary)] font-mono mt-0.5">
                            关联订单 #{l.orderId}
                          </div>
                        )}
                        {visual.hint && (
                          <div className="text-[11px] text-[var(--color-text-muted)]/80 mt-0.5">
                            {visual.hint}
                          </div>
                        )}
                      </td>
                      <td
                        className={`text-right font-bold text-base ${visual.amountClass}`}
                        data-label="积分变动"
                        data-testid="point-log-amount"
                      >
                        {formattedAmount}
                      </td>
                      <td
                        className="text-right font-bold text-sm text-[var(--color-text)]"
                        data-label="变动后余额"
                        data-testid="point-log-balance"
                      >
                        {l.balanceAfter != null ? l.balanceAfter.toLocaleString('en-US') : '—'}
                      </td>
                    </tr>
                  )
                })}
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState
                        compact
                        icon={Activity}
                        title="暂无积分流水"
                        description={hasActiveFilters ? '未找到符合筛选条件的流水记录' : undefined}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <AdminPagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={(p) => fetchLogs({ page: p })}
          />
        </div>
      )}
    </div>
  )
}
