import { useEffect, useRef, useState } from 'react'
import { DollarSign } from 'lucide-react'
import { getAdminSettlements, batchSettle } from '../../api/adminMerchant'
import { getApiErrorMessage } from '../../api/error'
import { Settlement } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import RegistryPill from '../ui/RegistryPill'
import ConfirmDialog from '../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import AdminPagination from './AdminPagination'
import AdminPanelHeader from './AdminPanelHeader'
import { blockReasonToUserMessage } from '../../utils/settlementCopy'

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
    Map<number, { settlementAmount: number; orderId: number; status: 'pending' }>
  >(() => new Map())
  const [settlementStatusFilter, setSettlementStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)

  const [showBatchSettleConfirm, setShowBatchSettleConfirm] = useState(false)
  const [showSelectionDetail, setShowSelectionDetail] = useState(false)
  const [settling, setSettling] = useState(false)

  const settlementsReqSeqRef = useRef(0)
  const headerCheckboxRef = useRef<HTMLInputElement>(null)

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
      setSelectedSettlementsMap((prev) => {
        if (prev.size === 0) return prev
        const next = new Map(prev)
        for (const item of data.items) {
          if (next.has(item.id)) {
            if (item.status === 'pending' && item.payable === true) {
              next.set(item.id, {
                settlementAmount: Number(item.settlementAmount) || 0,
                orderId: item.orderId,
                status: 'pending',
              })
            } else {
              next.delete(item.id)
            }
          }
        }
        return next
      })
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

  function isSettlementSelectable(s: Settlement): boolean {
    return s.status === 'pending' && s.payable === true
  }

  const currentPageEligible = settlements.filter(isSettlementSelectable)
  const isCurrentPageAllSelected =
    currentPageEligible.length > 0 &&
    currentPageEligible.every((s) => selectedSettlementsMap.has(s.id))

  const selectedEligibleCount = currentPageEligible.filter((s) =>
    selectedSettlementsMap.has(s.id),
  ).length
  const isCurrentPagePartiallySelected =
    selectedEligibleCount > 0 && !isCurrentPageAllSelected

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = isCurrentPagePartiallySelected
    }
  }, [isCurrentPagePartiallySelected])

  function handleToggleCurrentPageAll() {
    setSelectedSettlementsMap((prev) => {
      const next = new Map(prev)
      if (isCurrentPageAllSelected) {
        for (const s of currentPageEligible) {
          next.delete(s.id)
        }
      } else {
        for (const s of currentPageEligible) {
          next.set(s.id, {
            settlementAmount: Number(s.settlementAmount) || 0,
            orderId: s.orderId,
            status: 'pending',
          })
        }
      }
      return next
    })
  }

  function handleToggleSettlementRow(s: Settlement) {
    if (!isSettlementSelectable(s)) return
    setSelectedSettlementsMap((prev) => {
      const next = new Map(prev)
      if (next.has(s.id)) {
        next.delete(s.id)
      } else {
        next.set(s.id, {
          settlementAmount: Number(s.settlementAmount) || 0,
          orderId: s.orderId,
          status: 'pending',
        })
      }
      return next
    })
  }

  function handleClearSelection() {
    setSelectedSettlementsMap(new Map())
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
      showToast(
        `成功结算 ${settled} 笔订单，入账合计 ${creditedTotal ?? pendingSelectedAmount} 积分`,
      )
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
          <div className="flex flex-wrap items-center gap-3">
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
            {selectedSettlementsMap.size > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowSelectionDetail(true)}
                  className="text-xs text-[var(--color-primary)] hover:underline cursor-pointer"
                  data-testid="admin-view-settlements-selection"
                >
                  已选明细 ({selectedSettlementsMap.size})
                </button>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="btn-secondary px-3 py-2 text-sm cursor-pointer"
                  data-testid="admin-clear-settlements-selection"
                >
                  清空已选
                </button>
              </>
            )}
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

      {/* 移动端独立全选/清空控制栏 (<768px) */}
      <div className="md:hidden flex flex-wrap items-center justify-between gap-2 p-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleToggleCurrentPageAll}
            disabled={currentPageEligible.length === 0}
            className="btn-secondary btn-sm text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="admin-mobile-toggle-page-all"
          >
            {isCurrentPageAllSelected ? '取消本页全选' : '全选本页待结算'}
          </button>
          {selectedSettlementsMap.size > 0 && (
            <button
              type="button"
              onClick={handleClearSelection}
              className="btn-secondary btn-sm text-xs cursor-pointer"
              data-testid="admin-mobile-clear-selection"
            >
              清空已选
            </button>
          )}
        </div>
        {selectedSettlementsMap.size > 0 && (
          <button
            type="button"
            onClick={() => setShowSelectionDetail(true)}
            className="text-xs text-[var(--color-primary)] font-semibold cursor-pointer"
            data-testid="admin-mobile-view-selection"
          >
            已选 {selectedSettlementsMap.size} 笔 (查看明细)
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        {loading && settlements.length === 0 ? (
          <TableSkeleton />
        ) : (
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th className="w-12">
                  <label
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center cursor-pointer"
                    title={
                      currentPageEligible.length === 0
                        ? '本页无可结算订单'
                        : isCurrentPageAllSelected
                          ? '取消选择当前页全部可结算订单'
                          : '选择当前页全部可结算订单'
                    }
                  >
                    <input
                      ref={headerCheckboxRef}
                      type="checkbox"
                      className="accent-[var(--color-primary)] w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
                      onChange={handleToggleCurrentPageAll}
                      checked={isCurrentPageAllSelected}
                      disabled={currentPageEligible.length === 0}
                      aria-label="选择当前页待结算订单"
                    />
                  </label>
                </th>
                <th>订单信息</th>
                <th>商家</th>
                <th>抽成/订单金额</th>
                <th>结算金额</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((s) => {
                const selectable = isSettlementSelectable(s)
                const isPending = s.status === 'pending'
                const displayReason =
                  !selectable && isPending
                    ? (blockReasonToUserMessage(s.blockReason) ?? '暂时无法结算，请联系平台处理')
                    : ''

                return (
                  <tr key={s.id}>
                    <td data-label="选择">
                      {isPending ? (
                        <label
                          className={`min-w-[44px] min-h-[44px] flex items-center justify-center ${
                            !selectable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                          }`}
                          title={displayReason || undefined}
                        >
                          <input
                            type="checkbox"
                            className="accent-[var(--color-primary)] w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
                            checked={selectedSettlementsMap.has(s.id)}
                            onChange={() => handleToggleSettlementRow(s)}
                            disabled={!selectable}
                            aria-label={`选择订单 ORD-${s.orderId}`}
                            data-testid={`admin-settlement-checkbox-${s.id}`}
                          />
                        </label>
                      ) : (
                        <span className="text-[var(--color-text-muted)] text-xs min-w-[44px] min-h-[44px] flex items-center justify-center">
                          —
                        </span>
                      )}
                    </td>
                    <td data-label="订单信息">
                      <div className="font-mono text-xs text-[var(--color-text-muted)]">
                        ORD-{s.orderId}
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)] mt-1">
                        {new Date(s.createdAt).toLocaleString()}
                      </div>
                    </td>
                    <td className="font-bold text-sm text-[var(--color-text)]" data-label="商家">
                      {s.merchant?.name || s.merchantId}
                    </td>
                    <td className="text-sm" data-label="抽成/订单金额">
                      <div className="text-[var(--color-text)]">
                        平台服务费:{' '}
                        <span className="text-[var(--color-text-muted)]">
                          {s.commissionAmount.toLocaleString()}
                        </span>{' '}
                        ({(Number(s.commissionRate) * 100).toFixed(0)}%)
                      </div>
                      <div className="text-[var(--color-text)]">
                        订单金额:{' '}
                        <span className="text-[var(--color-text)]">
                          {s.orderAmount.toLocaleString()}
                        </span>
                      </div>
                    </td>
                    <td className="font-bold text-[var(--color-cta)]" data-label="结算金额">
                      {s.settlementAmount.toLocaleString()}
                    </td>
                    <td data-label="状态">
                      <div className="flex flex-col items-start gap-1">
                        <SettlementStatusPill status={s.status} />
                        {isPending && !selectable && displayReason ? (
                          <span
                            className="text-[11px] text-[var(--color-danger)]"
                            data-testid={`settlement-block-reason-${s.id}`}
                            title={displayReason}
                          >
                            {displayReason}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!loading && settlements.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      compact
                      icon={DollarSign}
                      title="暂无结算记录"
                      description="订单完成后将生成待结算记录"
                    />
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

      {/* 跨页已选结算单明细弹窗 */}
      <Dialog open={showSelectionDetail} onOpenChange={setShowSelectionDetail}>
        <DialogContent className="max-w-lg" data-testid="admin-settlements-selection-dialog">
          <DialogTitle>已选结算单明细</DialogTitle>
          <DialogDescription>
            共跨页选中 {selectedSettlementsMap.size} 笔待结算订单，累计应结金额{' '}
            {pendingSelectedAmount.toLocaleString()} 积分。
          </DialogDescription>
          <div className="max-h-60 overflow-y-auto divide-y divide-[var(--color-border)] my-3 border border-[var(--color-border)] rounded-lg">
            {Array.from(selectedSettlementsMap.entries()).map(([settlementId, info]) => (
              <div
                key={settlementId}
                className="p-2.5 flex items-center justify-between text-xs"
                data-testid={`admin-selection-detail-item-${settlementId}`}
              >
                <div>
                  <span className="font-mono font-bold text-[var(--color-text)]">
                    ORD-{info.orderId}
                  </span>
                  <span className="text-[var(--color-text-muted)] ml-2">
                    结算单 #{settlementId}
                  </span>
                </div>
                <div className="font-bold text-[var(--color-cta)]">
                  {info.settlementAmount.toLocaleString()} 积分
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => {
                handleClearSelection()
                setShowSelectionDetail(false)
              }}
              className="btn-secondary btn-sm text-xs text-[var(--color-danger)]"
              data-testid="admin-dialog-clear-selection"
            >
              清空已选
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowSelectionDetail(false)}
                className="btn-secondary btn-sm text-xs"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowSelectionDetail(false)
                  setShowBatchSettleConfirm(true)
                }}
                className="btn-cta btn-sm text-xs"
              >
                去结算
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
