import { useEffect, useRef, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { listAdminAudit, type AdminLogEntry } from '../../api/adminAudit'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import AdminPagination from './AdminPagination'
import AdminPanelHeader from './AdminPanelHeader'

interface AuditFetchSnapshot {
  page?: number
  filters?: {
    adminId?: string
    action?: string
    fromDate?: string
    toDate?: string
  }
}

interface Props {
  active?: boolean
}

export default function AdminAuditPanel({ active = true }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [auditLogs, setAuditLogs] = useState<AdminLogEntry[]>([])
  const [auditTotal, setAuditTotal] = useState(0)
  const [auditPage, setAuditPage] = useState(1)
  const [loading, setLoading] = useState(true)

  const [auditFilterAdminId, setAuditFilterAdminId] = useState('')
  const [auditFilterAction, setAuditFilterAction] = useState('')
  const [auditFilterFrom, setAuditFilterFrom] = useState('')
  const [auditFilterTo, setAuditFilterTo] = useState('')

  const auditReqSeqRef = useRef(0)
  const activeAuditFiltersRef = useRef<{
    adminId?: string
    action?: string
    fromDate?: string
    toDate?: string
  }>({})

  async function fetchAudit(snapshot?: AuditFetchSnapshot) {
    const seq = ++auditReqSeqRef.current
    const targetPage = snapshot?.page ?? auditPage
    const filters = snapshot && 'filters' in snapshot ? snapshot.filters : activeAuditFiltersRef.current

    setLoading(true)
    try {
      const query: Parameters<typeof listAdminAudit>[0] = { page: targetPage, pageSize: 20 }
      if (filters?.adminId) query.adminId = Number(filters.adminId)
      if (filters?.action) query.action = filters.action
      if (filters?.fromDate) query.fromDate = filters.fromDate
      if (filters?.toDate) query.toDate = filters.toDate

      const data = await listAdminAudit(query)
      if (seq !== auditReqSeqRef.current) return
      setAuditLogs(data.items)
      setAuditTotal(data.total)
      setAuditPage(targetPage)
    } catch (err: any) {
      if (seq !== auditReqSeqRef.current) return
      showToast(getApiErrorMessage(err, '加载审计日志失败'), 'error')
    } finally {
      if (seq === auditReqSeqRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!active) {
      auditReqSeqRef.current++
      return
    }
    void fetchAudit({ page: auditPage, filters: activeAuditFiltersRef.current })
    return () => {
      auditReqSeqRef.current++
    }
  }, [active])

  function handleAuditSearch() {
    const filters = {
      adminId: auditFilterAdminId.trim() || undefined,
      action: auditFilterAction || undefined,
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
    setAuditFilterFrom('')
    setAuditFilterTo('')
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
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          placeholder="管理员ID"
          value={auditFilterAdminId}
          onChange={(e) => setAuditFilterAdminId(e.target.value)}
          className="input py-1.5 w-32"
        />
        <input
          type="text"
          placeholder="操作动作 (如: ban)"
          value={auditFilterAction}
          onChange={(e) => setAuditFilterAction(e.target.value)}
          className="input py-1.5 w-40"
        />
        <input
          type="date"
          value={auditFilterFrom}
          onChange={(e) => setAuditFilterFrom(e.target.value)}
          className="input py-1.5 w-36"
        />
        <input
          type="date"
          value={auditFilterTo}
          onChange={(e) => setAuditFilterTo(e.target.value)}
          className="input py-1.5 w-36"
        />
        <button onClick={handleAuditSearch} className="btn-primary py-1.5 text-sm cursor-pointer">查询</button>
        <button onClick={handleAuditReset} className="btn-secondary py-1.5 text-sm cursor-pointer">重置</button>
      </div>
      <div className="overflow-x-auto">
        {loading && auditLogs.length === 0 ? (
          <TableSkeleton />
        ) : (
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作员</th>
                <th>动作</th>
                <th>目标</th>
                <th>元数据</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.map((l) => (
                <tr key={l.id}>
                  <td className="text-[var(--color-text-muted)] text-xs whitespace-nowrap" data-label="时间">
                    {new Date(l.createdAt).toLocaleString()}
                  </td>
                  <td className="font-bold text-[var(--color-text)] text-sm" data-label="操作员">
                    U{l.adminId} <span className="text-xs font-normal text-[var(--color-text-muted)]">({l.adminEmail})</span>
                  </td>
                  <td className="text-sm font-mono text-[var(--color-primary)]" data-label="动作">
                    {l.action}
                  </td>
                  <td className="text-sm text-[var(--color-text)]" data-label="目标">
                    {l.targetType} {l.targetId ? `#${l.targetId}` : ''}
                  </td>
                  <td className="text-xs text-[var(--color-text-muted)]" data-label="元数据">
                    {l.metadata ? (
                      <pre className="max-w-[200px] overflow-hidden text-ellipsis m-0">
                        {JSON.stringify(l.metadata)}
                      </pre>
                    ) : '-'}
                  </td>
                </tr>
              ))}
              {!loading && auditLogs.length === 0 && (
                <tr>
                  <td colSpan={5}>
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
        )}
      </div>
      <AdminPagination
        page={auditPage}
        total={auditTotal}
        pageSize={20}
        onPageChange={handleAuditPageChange}
        testId="admin-audit-pagination"
      />
    </div>
  )
}
