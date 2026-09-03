import { useEffect, useRef, useState } from 'react'
import { Store } from 'lucide-react'
import {
  getAdminMerchants,
  approveMerchant,
  rejectMerchant,
  suspendMerchant,
} from '../../api/adminMerchant'
import { getApiErrorMessage } from '../../api/error'
import { Merchant } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import AdminPagination from './AdminPagination'
import CommissionDialog from './CommissionDialog'

interface Props {
  active?: boolean
}

function MerchantStatusPill({ status }: { status: string }) {
  const styles: Record<string, { bg: string; text: string; border: string; label: string }> = {
    active:    { bg: 'bg-[var(--color-cta)]/10',   text: 'text-[var(--color-cta)]',   border: 'border-[var(--color-cta)]/25',   label: '营业中' },
    pending:   { bg: 'bg-orange-500/10',           text: 'text-orange-500',           border: 'border-orange-500/25',           label: '待审核' },
    suspended: { bg: 'bg-red-500/10',              text: 'text-red-500',              border: 'border-red-500/25',              label: '已停用' },
    rejected:  { bg: 'bg-red-500/10',              text: 'text-red-500',              border: 'border-red-500/25',              label: '已拒绝' },
  }
  const s = styles[status] || { bg: 'bg-[var(--color-text-muted)]/10', text: 'text-[var(--color-text-muted)]', border: 'border-[var(--color-text-muted)]/25', label: status }
  return (
    <span className={`inline-flex items-center px-2.5 py-1 text-xs rounded font-bold border ${s.bg} ${s.text} ${s.border}`}>
      {s.label}
    </span>
  )
}

function ActionLink({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode
  onClick: () => void
  tone: 'cta' | 'danger' | 'primary'
}) {
  const colors = {
    cta: 'text-[var(--color-cta)]',
    danger: 'text-[var(--color-danger)]',
    primary: 'text-[var(--color-primary)]',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${colors[tone]} hover:underline text-xs font-semibold cursor-pointer btn-sm`}
    >
      {children}
    </button>
  )
}

export default function AdminMerchantPanel({ active = true }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [merchantPage, setMerchantPage] = useState(1)
  const [merchantTotal, setMerchantTotal] = useState(0)
  const [draftMerchantStatus, setDraftMerchantStatus] = useState('')
  const [draftMerchantSearch, setDraftMerchantSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [commissionTarget, setCommissionTarget] = useState<Merchant | null>(null)

  const appliedMerchantFiltersRef = useRef<{ status: string; q: string }>({ status: '', q: '' })
  const merchantsReqSeqRef = useRef(0)

  async function fetchMerchants(pageArg = merchantPage, filtersArg = appliedMerchantFiltersRef.current) {
    const seq = ++merchantsReqSeqRef.current
    setLoading(true)
    try {
      const data = await getAdminMerchants({
        status: filtersArg.status || undefined,
        q: filtersArg.q.trim() || undefined,
        page: pageArg,
        pageSize: 20,
      })
      if (seq !== merchantsReqSeqRef.current) return
      setMerchants(data.items)
      setMerchantTotal(data.total)
      setMerchantPage(data.page)
    } catch (err: any) {
      if (seq !== merchantsReqSeqRef.current) return
      showToast(getApiErrorMessage(err, '加载商家列表失败'), 'error')
    } finally {
      if (seq === merchantsReqSeqRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!active) {
      merchantsReqSeqRef.current++
      return
    }
    void fetchMerchants(merchantPage, appliedMerchantFiltersRef.current)
    return () => {
      merchantsReqSeqRef.current++
    }
  }, [active])

  function handleMerchantSearch() {
    appliedMerchantFiltersRef.current = {
      status: draftMerchantStatus,
      q: draftMerchantSearch,
    }
    void fetchMerchants(1, appliedMerchantFiltersRef.current)
  }

  function handleMerchantReset() {
    setDraftMerchantStatus('')
    setDraftMerchantSearch('')
    appliedMerchantFiltersRef.current = { status: '', q: '' }
    void fetchMerchants(1, { status: '', q: '' })
  }

  function handleMerchantPageChange(nextPage: number) {
    void fetchMerchants(nextPage, appliedMerchantFiltersRef.current)
  }

  async function handleApproveMerchant(id: number) {
    try {
      await approveMerchant(id)
      showToast('已通过审核')
      void fetchMerchants(merchantPage, appliedMerchantFiltersRef.current)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    }
  }

  async function handleRejectMerchant(id: number) {
    try {
      await rejectMerchant(id, {})
      showToast('已拒绝入驻')
      void fetchMerchants(merchantPage, appliedMerchantFiltersRef.current)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    }
  }

  async function handleSuspendMerchant(id: number) {
    try {
      await suspendMerchant(id)
      showToast('已停用商家')
      void fetchMerchants(merchantPage, appliedMerchantFiltersRef.current)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">商家管理</h2>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={draftMerchantStatus}
            onChange={(e) => setDraftMerchantStatus(e.target.value)}
            className="input py-1.5 w-36"
            data-testid="admin-merchant-status-filter"
          >
            <option value="">全部状态</option>
            <option value="pending">待审核</option>
            <option value="active">正常</option>
            <option value="suspended">已停用</option>
            <option value="rejected">已拒绝</option>
          </select>
          <input
            type="text"
            placeholder="搜索商家名称..."
            value={draftMerchantSearch}
            onChange={(e) => setDraftMerchantSearch(e.target.value)}
            className="input py-1.5 w-48"
            data-testid="admin-merchant-search-input"
          />
          <button
            type="button"
            onClick={handleMerchantSearch}
            className="btn-primary py-1.5 px-3 text-sm cursor-pointer"
            data-testid="admin-merchant-search-btn"
          >
            查询
          </button>
          <button
            type="button"
            onClick={handleMerchantReset}
            className="btn-secondary py-1.5 px-3 text-sm cursor-pointer"
            data-testid="admin-merchant-reset-btn"
          >
            重置
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        {loading && merchants.length === 0 ? (
          <TableSkeleton />
        ) : (
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>商家名称</th>
                <th>联系人</th>
                <th>抽成比例</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((m) => (
                <tr key={m.id}>
                  <td data-label="商家名称">
                    <div className="font-bold text-[var(--color-text)]">{m.name}</div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-1">{m.description?.slice(0, 20)}</div>
                  </td>
                  <td className="text-sm" data-label="联系人">
                    <div className="text-[var(--color-text)]">{m.contactEmail || '-'}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">{m.contactPhone || '-'}</div>
                  </td>
                  <td className="text-[var(--color-primary)] font-bold" data-label="抽成比例">
                    {(Number(m.commissionRate) * 100).toFixed(0)}%
                  </td>
                  <td data-label="状态">
                    <MerchantStatusPill status={m.status} />
                  </td>
                  <td className="text-right space-x-3 whitespace-nowrap" data-label="操作">
                    {m.status === 'pending' && (
                      <>
                        <ActionLink tone="cta" onClick={() => handleApproveMerchant(m.id)}>通过</ActionLink>
                        <ActionLink tone="danger" onClick={() => handleRejectMerchant(m.id)}>拒绝</ActionLink>
                      </>
                    )}
                    {m.status === 'active' && (
                      <>
                        <ActionLink tone="primary" onClick={() => setCommissionTarget(m)}>改抽成</ActionLink>
                        <ActionLink tone="danger" onClick={() => handleSuspendMerchant(m.id)}>停用</ActionLink>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && merchants.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState compact icon={Store} title="暂无商家" description="没有符合条件的商家数据" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <AdminPagination
        page={merchantPage}
        total={merchantTotal}
        pageSize={20}
        onPageChange={handleMerchantPageChange}
        testId="admin-merchants-pagination"
      />

      {/* Commission Dialog */}
      <CommissionDialog
        merchant={commissionTarget}
        onClose={() => setCommissionTarget(null)}
        onSuccess={() => {
          setCommissionTarget(null)
          showToast('抽成更新成功')
          void fetchMerchants(merchantPage, appliedMerchantFiltersRef.current)
        }}
      />
    </div>
  )
}
