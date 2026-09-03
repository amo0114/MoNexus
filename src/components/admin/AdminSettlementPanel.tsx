import { useEffect, useRef, useState } from 'react'
import { DollarSign } from 'lucide-react'
import { getAdminSettlements, batchSettle } from '../../api/adminMerchant'
import { getApiErrorMessage } from '../../api/error'
import { Settlement } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import RegistryPill from '../ui/RegistryPill'
import ConfirmDialog from '../ui/ConfirmDialog'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import AdminPagination from './AdminPagination'
import AdminPanelHeader from './AdminPanelHeader'

interface Props {
  active?: boolean
}

function SettlementStatusPill({ status }: { status: string }) {
  return <RegistryPill value={status} category="settlementStatuses" />
}

export default function AdminSettlementPanel({ active = true }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [settlementPage, setSettlementPage] = useState(1)
  const [settlementTotal, setSettlementTotal] = useState(0)
  const [selectedSettlementsMap, setSelectedSettlementsMap] = useState<
    Map<number, { settlementAmount: number; status: 'pending' }>
  >(() => new Map())
  const [settlementStatusFilter, setSettlementStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)

  const [showBatchSettleConfirm, setShowBatchSettleConfirm] = useState(false)
  const [settling, setSettling] = useState(false)

  const settlementsReqSeqRef = useRef(0)

  async function fetchSettlements(pageArg = settlementPage, statusArg = settlementStatusFilter) {
    const seq = ++settlementsReqSeqRef.current
    setLoading(true)
    try {
      const data = await getAdminSettlements({
        status: statusArg || undefined,
        page: pageArg,
        pageSize: 20,
      })
      if (seq !== settlementsReqSeqRef.current) return
      setSettlements(data.items)
      setSettlementTotal(data.total)
      setSettlementPage(data.page)
    } catch (err: any) {
      if (seq !== settlementsReqSeqRef.current) return
      showToast(getApiErrorMessage(err, '加载结算列表失败'), 'error')
    } finally {
      if (seq === settlementsReqSeqRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!active) {
      settlementsReqSeqRef.current++
      return
    }
    void fetchSettlements(settlementPage, settlementStatusFilter)
    return () => {
      settlementsReqSeqRef.current++
    }
  }, [active])

  function handleSettlementStatusFilterChange(newStatus: string) {
    setSettlementStatusFilter(newStatus)
    setSelectedSettlementsMap(new Map())
    setSettlementPage(1)
    void fetchSettlements(1, newStatus)
  }

  function handleSettlementPageChange(nextPage: number) {
    void fetchSettlements(nextPage, settlementStatusFilter)
  }

  const currentPagePending = settlements.filter((s) => s.status === 'pending')
  const isCurrentPageAllSelected =
    currentPagePending.length > 0 &&
    currentPagePending.every((s) => selectedSettlementsMap.has(s.id))

  function handleToggleCurrentPageAll() {
    setSelectedSettlementsMap((prev) => {
      const next = new Map(prev)
      if (isCurrentPageAllSelected) {
        for (const s of currentPagePending) {
          next.delete(s.id)
        }
      } else {
        for (const s of currentPagePending) {
          next.set(s.id, {
            settlementAmount: Number(s.settlementAmount) || 0,
            status: 'pending',
          })
        }
      }
      return next
    })
  }

  function handleToggleSettlementRow(s: Settlement) {
    if (s.status !== 'pending') return
    setSelectedSettlementsMap((prev) => {
      const next = new Map(prev)
      if (next.has(s.id)) {
        next.delete(s.id)
      } else {
        next.set(s.id, {
          settlementAmount: Number(s.settlementAmount) || 0,
          status: 'pending',
        })
      }
      return next
    })
  }

  const pendingSelectedAmount = Array.from(selectedSettlementsMap.values()).reduce(
    (sum, item) => sum + item.settlementAmount,
    0,
  )

  function handleBatchSettleClick() {
    if (selectedSettlementsMap.size === 0) {
      showToast('请选择待结算（pending）记录', 'error')
      return
    }
    setShowBatchSettleConfirm(true)
  }

  async function confirmBatchSettle() {
    if (settling || selectedSettlementsMap.size === 0) return
    setSettling(true)
    const idsToSettle = Array.from(selectedSettlementsMap.keys())
    try {
      const { settled, creditedTotal } = await batchSettle({
        settlementIds: idsToSettle,
      })
      showToast(`成功结算 ${settled} 笔订单，入账合计 ${creditedTotal ?? pendingSelectedAmount} 积分`)
      setShowBatchSettleConfirm(false)
      setSelectedSettlementsMap(new Map())
      void fetchSettlements(settlementPage, settlementStatusFilter)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '批量结算失败'), 'error')
    } finally {
      setSettling(false)
    }
  }

  return (
    <div className="space-y-4">
      <AdminPanelHeader
        title="结算管理"
        description="管理商户结算单、处理批量出账与流水核对"
        actions={
          <div className="flex items-center gap-3">
            <select
              value={settlementStatusFilter}
              onChange={(e) => handleSettlementStatusFilterChange(e.target.value)}
              className="input py-1.5 w-36"
              data-testid="admin-settlement-status-filter"
            >
              <option value="">全部状态</option>
              <option value="holding">冻结中</option>
              <option value="pending">待结算</option>
              <option value="settled">已结算</option>
              <option value="voided">已作废</option>
            </select>
            <button
              onClick={handleBatchSettleClick}
              disabled={selectedSettlementsMap.size === 0}
              className="btn-cta px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              data-testid="admin-batch-settle"
            >
              批量结算 ({selectedSettlementsMap.size})
            </button>
          </div>
        }
      />
      <div className="overflow-x-auto">
        {loading && settlements.length === 0 ? (
          <TableSkeleton />
        ) : (
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th className="w-10">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-primary)] cursor-pointer"
                    onChange={handleToggleCurrentPageAll}
                    checked={isCurrentPageAllSelected}
                    disabled={currentPagePending.length === 0}
                    aria-label="选择当前页待结算订单"
                  />
                </th>
                <th>订单信息</th>
                <th>商家</th>
                <th>抽成/订单金额</th>
                <th>结算金额</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((s) => (
                <tr key={s.id}>
                  <td data-label="选择">
                    {s.status === 'pending' ? (
                      <input
                        type="checkbox"
                        className="accent-[var(--color-primary)] cursor-pointer"
                        checked={selectedSettlementsMap.has(s.id)}
                        onChange={() => handleToggleSettlementRow(s)}
                        aria-label={`选择订单 ORD-${s.orderId}`}
                      />
                    ) : (
                      <span className="text-[var(--color-text-muted)] text-xs">—</span>
                    )}
                  </td>
                  <td data-label="订单信息">
                    <div className="font-mono text-xs text-[var(--color-text-muted)]">ORD-{s.orderId}</div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-1">{new Date(s.createdAt).toLocaleString()}</div>
                  </td>
                  <td className="font-bold text-sm text-[var(--color-text)]" data-label="商家">
                    {s.merchant?.name || s.merchantId}
                  </td>
                  <td className="text-sm" data-label="抽成/订单金额">
                    <div className="text-[var(--color-text)]">平台服务费: <span className="text-[var(--color-text-muted)]">{s.commissionAmount}</span> ({(Number(s.commissionRate) * 100).toFixed(0)}%)</div>
                    <div className="text-[var(--color-text)]">订单金额: <span className="text-[var(--color-text)]">{s.orderAmount}</span></div>
                  </td>
                  <td className="font-bold text-[var(--color-cta)]" data-label="结算金额">
                    {s.settlementAmount}
                  </td>
                  <td data-label="状态">
                    <SettlementStatusPill status={s.status} />
                  </td>
                </tr>
              ))}
              {!loading && settlements.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState compact icon={DollarSign} title="暂无结算记录" description="订单完成后将生成待结算记录" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <AdminPagination
        page={settlementPage}
        total={settlementTotal}
        pageSize={20}
        onPageChange={handleSettlementPageChange}
        testId="admin-settlements-pagination"
      />

      {/* 批量结算确认弹窗 */}
      <ConfirmDialog
        open={showBatchSettleConfirm}
        onOpenChange={(open) => {
          if (!open && !settling) setShowBatchSettleConfirm(false)
        }}
        title="批量结算确认"
        description={`确定对选中的 ${selectedSettlementsMap.size} 笔待结算订单执行批量结算？合计应结金额为 ${pendingSelectedAmount.toLocaleString()} 积分。结算后将真实为对应商户账户入账，不可逆撤回。`}
        confirmLabel={settling ? '结算中…' : `确认结算 (${selectedSettlementsMap.size} 笔)`}
        tone="primary"
        loading={settling}
        onConfirm={confirmBatchSettle}
        testId="admin-batch-settle-confirm-dialog"
      />
    </div>
  )
}
