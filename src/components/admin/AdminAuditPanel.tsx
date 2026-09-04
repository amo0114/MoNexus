import { useEffect, useRef, useState } from 'react'
import { ClipboardList, Search, RotateCcw } from 'lucide-react'
import { listAdminAudit, type AdminAuditItem, type AdminLogQuery } from '../../api/adminAudit'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import ErrorState from '../ui/ErrorState'
import AdminPagination from './AdminPagination'
import AdminPanelHeader from './AdminPanelHeader'
import {
  ADMIN_AUDIT_ACTION_GROUPS,
  ADMIN_AUDIT_TARGET_OPTIONS,
  adminAuditActionVisual,
  adminAuditTargetLabel,
  auditToneBadgeClass,
} from '../../utils/adminAuditDisplay'

interface AuditFetchFilters {
  adminId?: string
  action?: string
  targetType?: string
  fromDate?: string
  toDate?: string
}

interface AuditFetchSnapshot {
  page?: number
  filters?: AuditFetchFilters
}

export interface AdminAuditPanelProps {
  active?: boolean
}

export default function AdminAuditPanel({ active = true }: AdminAuditPanelProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [auditLogs, setAuditLogs] = useState<AdminAuditItem[]>([])
  const [auditTotal, setAuditTotal] = useState(0)
  const [auditPage, setAuditPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Draft filter inputs
  const [auditFilterAdminId, setAuditFilterAdminId] = useState('')
  const [auditFilterAction, setAuditFilterAction] = useState('')
  const [auditFilterTargetType, setAuditFilterTargetType] = useState('')
  const [auditFilterFrom, setAuditFilterFrom] = useState('')
  const [auditFilterTo, setAuditFilterTo] = useState('')

  // Inline validation errors
  const [adminIdError, setAdminIdError] = useState<string | null>(null)
  const [dateError, setDateError] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const auditReqSeqRef = useRef(0)
  const activeRef = useRef(active)
  const activeAuditFiltersRef = useRef<AuditFetchFilters>({})
  const auditLogsRef = useRef<AdminAuditItem[]>(auditLogs)

  activeRef.current = active
  auditLogsRef.current = auditLogs

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function fetchAudit(snapshot?: AuditFetchSnapshot) {
    const seq = ++auditReqSeqRef.current
    const targetPage = snapshot?.page ?? auditPage
    const filters = snapshot && 'filters' in snapshot ? snapshot.filters : activeAuditFiltersRef.current

    setLoading(true)
    setLoadError(null)

    try {
      const query: AdminLogQuery = { page: targetPage, pageSize: 20 }
      if (filters?.adminId) query.adminId = Number(filters.adminId)
      if (filters?.action) query.action = filters.action
      if (filters?.targetType) query.targetType = filters.targetType
      if (filters?.fromDate) query.fromDate = filters.fromDate
      if (filters?.toDate) query.toDate = filters.toDate

      const data = await listAdminAudit(query)
      if (!mountedRef.current || !activeRef.current || seq !== auditReqSeqRef.current) return

      setAuditLogs(data.items)
      setAuditTotal(data.total)
      setAuditPage(targetPage)
    } catch (err: unknown) {
      if (!mountedRef.current || !activeRef.current || seq !== auditReqSeqRef.current) return
      const message =
        err instanceof Error && err.message && !('response' in (err as unknown as Record<string, unknown>))
          ? err.message
          : getApiErrorMessage(err, '加载审计日志失败')
      if (auditLogsRef.current.length === 0) {
        setLoadError(message)
      } else {
        showToast(message, 'error')
      }
    } finally {
      if (mountedRef.current && activeRef.current && seq === auditReqSeqRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    activeRef.current = active
    if (!active) {
      auditReqSeqRef.current++
      return
    }
    void fetchAudit({ page: auditPage, filters: activeAuditFiltersRef.current })
    return () => {
      auditReqSeqRef.current++
    }
  }, [active])

  function handleAuditSearch(e?: React.FormEvent) {
    if (e) e.preventDefault()
    let hasError = false

    // Validate Admin ID
    const trimmedAdminId = auditFilterAdminId.trim()
    if (trimmedAdminId) {
      if (
        !/^[1-9]\d*$/.test(trimmedAdminId) ||
        Number(trimmedAdminId) > Number.MAX_SAFE_INTEGER
      ) {
        setAdminIdError('管理员 ID 必须为有效的正整数')
        hasError = true
      } else {
        setAdminIdError(null)
      }
    } else {
      setAdminIdError(null)
    }

    // Validate Date range
    if (auditFilterFrom && auditFilterTo && auditFilterFrom > auditFilterTo) {
      setDateError('开始日期不能晚于结束日期')
      hasError = true
    } else {
      setDateError(null)
    }

    if (hasError) return

    const filters: AuditFetchFilters = {
      adminId: trimmedAdminId || undefined,
      action: auditFilterAction || undefined,
      targetType: auditFilterTargetType || undefined,
      fromDate: auditFilterFrom || undefined,
      toDate: auditFilterTo || undefined,
    }

    activeAuditFiltersRef.current = filters
    setAuditPage(1)
    void fetchAudit({ page: 1, filters })
  }

  function handleAuditReset() {
    setAuditFilterAdminId('')
    setAuditFilterAction('')
    setAuditFilterTargetType('')
    setAuditFilterFrom('')
    setAuditFilterTo('')
    setAdminIdError(null)
    setDateError(null)
    activeAuditFiltersRef.current = {}
    setAuditPage(1)
    void fetchAudit({ page: 1, filters: {} })
  }

  function handleAuditPageChange(nextPage: number) {
    setAuditPage(nextPage)
    void fetchAudit({ page: nextPage, filters: activeAuditFiltersRef.current })
  }

  return (
    <div className="space-y-4">
      <AdminPanelHeader
        title="操作审计"
        description="追溯与审计管理人员在系统中的关键敏感操作"
      />

      {/* Filter Toolbar */}
      <form onSubmit={handleAuditSearch} className="space-y-2 mb-4">
        <div className="flex flex-wrap items-start gap-3">
          {/* Admin ID */}
          <div className="flex flex-col">
            <input
              type="text"
              placeholder="管理员ID"
              aria-label="管理员ID"
              data-testid="admin-audit-filter-admin-id"
              value={auditFilterAdminId}
              onChange={(e) => {
                setAuditFilterAdminId(e.target.value)
                if (adminIdError) setAdminIdError(null)
              }}
              aria-invalid={adminIdError ? 'true' : 'false'}
              aria-describedby={adminIdError ? 'admin-audit-id-error' : undefined}
              className={`input py-1.5 w-32 ${adminIdError ? 'border-red-500' : ''}`}
            />
            {adminIdError && (
              <span
                id="admin-audit-id-error"
                className="text-xs text-red-500 mt-1"
                data-testid="admin-audit-id-error"
              >
                {adminIdError}
              </span>
            )}
          </div>

          {/* Action Select */}
          <div className="flex flex-col">
            <select
              aria-label="操作动作"
              data-testid="admin-audit-filter-action"
              value={auditFilterAction}
              onChange={(e) => setAuditFilterAction(e.target.value)}
              className="input py-1.5 w-44"
            >
              <option value="">全部操作</option>
              {ADMIN_AUDIT_ACTION_GROUPS.map((grp) => (
                <optgroup key={grp.group} label={grp.group}>
                  {grp.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Target Type Select */}
          <div className="flex flex-col">
            <select
              aria-label="目标对象"
              data-testid="admin-audit-filter-target"
              value={auditFilterTargetType}
              onChange={(e) => setAuditFilterTargetType(e.target.value)}
              className="input py-1.5 w-40"
            >
              <option value="">全部目标</option>
              {ADMIN_AUDIT_TARGET_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Date range */}
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                aria-label="开始日期"
                data-testid="admin-audit-filter-from"
                value={auditFilterFrom}
                onChange={(e) => {
                  setAuditFilterFrom(e.target.value)
                  if (dateError) setDateError(null)
                }}
                aria-invalid={dateError ? 'true' : 'false'}
                aria-describedby={dateError ? 'admin-audit-date-error' : undefined}
                className={`input py-1.5 w-36 ${dateError ? 'border-red-500' : ''}`}
              />
              <span className="text-[var(--color-text-muted)] text-sm">至</span>
              <input
                type="date"
                aria-label="结束日期"
                data-testid="admin-audit-filter-to"
                value={auditFilterTo}
                onChange={(e) => {
                  setAuditFilterTo(e.target.value)
                  if (dateError) setDateError(null)
                }}
                aria-invalid={dateError ? 'true' : 'false'}
                aria-describedby={dateError ? 'admin-audit-date-error' : undefined}
                className={`input py-1.5 w-36 ${dateError ? 'border-red-500' : ''}`}
              />
            </div>
            {dateError && (
              <span
                id="admin-audit-date-error"
                className="text-xs text-red-500 mt-1"
                data-testid="admin-audit-date-error"
              >
                {dateError}
              </span>
            )}
          </div>

          {/* Search and Reset buttons */}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="btn-primary py-1.5 text-sm cursor-pointer flex items-center gap-1"
              data-testid="admin-audit-search-btn"
            >
              <Search className="w-3.5 h-3.5" />
              <span>查询</span>
            </button>
            <button
              type="button"
              onClick={handleAuditReset}
              className="btn-secondary py-1.5 text-sm cursor-pointer flex items-center gap-1"
              data-testid="admin-audit-reset-btn"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>重置</span>
            </button>
          </div>
        </div>
      </form>

      {/* Main Content Area */}
      {loadError && auditLogs.length === 0 ? (
        <ErrorState
          description={loadError}
          onRetry={() => void fetchAudit({ page: auditPage, filters: activeAuditFiltersRef.current })}
        />
      ) : loading && auditLogs.length === 0 ? (
        <TableSkeleton />
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="admin-table table-cards" data-testid="admin-audit-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作员</th>
                  <th>操作</th>
                  <th>目标</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((l) => {
                  const visual = adminAuditActionVisual(l.action)
                  const targetLabel = adminAuditTargetLabel(l.targetType)
                  const badgeClass = auditToneBadgeClass(visual.tone)
                  return (
                    <tr key={l.id} data-testid="admin-audit-row">
                      <td
                        className="text-[var(--color-text-muted)] text-xs whitespace-nowrap"
                        data-label="时间"
                      >
                        {new Date(l.createdAt).toLocaleString()}
                      </td>
                      <td
                        className="font-bold text-[var(--color-text)] text-sm"
                        data-label="操作员"
                      >
                        U{l.adminId}{' '}
                        <span className="text-xs font-normal text-[var(--color-text-muted)]">
                          ({l.adminEmail})
                        </span>
                      </td>
                      <td data-label="操作">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${badgeClass}`}
                          data-testid="admin-audit-action-badge"
                        >
                          {visual.label}
                        </span>
                      </td>
                      <td className="text-sm text-[var(--color-text)]" data-label="目标">
                        <span>{targetLabel}</span>
                        {l.targetId != null ? (
                          <span className="ml-1 font-mono text-xs text-[var(--color-text-muted)]">
                            #{l.targetId}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
                {!loading && auditLogs.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <EmptyState
                        compact
                        icon={ClipboardList}
                        title="暂无审计记录"
                        description="调整筛选条件或等待新的管理操作"
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <AdminPagination
            page={auditPage}
            total={auditTotal}
            pageSize={20}
            onPageChange={handleAuditPageChange}
            testId="admin-audit-pagination"
          />
        </div>
      )}
    </div>
  )
}
