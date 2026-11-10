import { useEffect, useState } from 'react'
import { Copy, Scale } from 'lucide-react'
import {
  adminReconcileRechargeOrder,
  createAdminReconRun,
  listAdminReconItems,
  listAdminReconRuns,
  reviewAdminReconItem,
  type AdminReconCoverage,
  type AdminReconItem,
  type AdminReconRun,
} from '../../../api/adminRecharge'
import AdminStatementImport from './AdminStatementImport'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import ConfirmDialog from '../../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { formatCurrencyAmount } from '../../../pages/recharge/money'
import { PAYMENT_PROVIDERS, providerLabel, RECON_STATUS_LABEL } from '../../../pages/recharge/status'
import { getAdminRechargeStatusConfig } from '../../../utils/adminRechargeDisplay'

const SCOPE_TYPE_LABELS: Record<string, string> = {
  statement: '渠道账单',
  provider_query: '渠道主动查询',
  manual: '人工指定范围',
}

const RECON_MISMATCH_LABEL: Record<string, string> = {
  amount_mismatch: '金额不一致',
  paid_not_credited: '已支付，积分未入账',
  provider_paid_local_unpaid: '渠道已付，本地未付',
  local_paid_provider_not_paid: '本地已付，渠道未付',
  refund_mismatch: '退款状态不一致',
  currency_mismatch: '币种不一致',
  duplicate_provider_payment: '渠道重复支付',
  unknown_provider_transaction: '渠道未知交易',
}

const STATEMENT_SOURCE_LABEL: Record<AdminReconCoverage['statementSource'], string> = {
  provider_api: '渠道接口账单',
  imported_file: '导入账单文件',
  unsupported: '仅本地完整性检查（渠道未提供账单）',
}

function coverageText(coverage: AdminReconCoverage | null | undefined) {
  if (!coverage) return null
  const period = coverage.periodStart || coverage.periodEnd
    ? `${coverage.periodStart ? new Date(coverage.periodStart).toLocaleString() : '不限'} 至 ${coverage.periodEnd ? new Date(coverage.periodEnd).toLocaleString() : '不限'}`
    : '不限时间'
  return `${STATEMENT_SOURCE_LABEL[coverage.statementSource]}；渠道条目 ${coverage.providerEntries}，本地扫描 ${coverage.localScanned}；${period}`
}

const RECON_ITEM_STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  resolved: '已解决',
  ignored: '已忽略',
}

export default function AdminReconciliation() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminReconRun[]>([])
  const [loading, setLoading] = useState(true)
  const [provider, setProvider] = useState('simulator')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acting, setActing] = useState(false)
  const [selectedRun, setSelectedRun] = useState<AdminReconRun | null>(null)
  const [runItems, setRunItems] = useState<AdminReconItem[] | null>(null)
  const [itemBusy, setItemBusy] = useState<string | null>(null)
  const [reviewReason, setReviewReason] = useState('')

  async function loadRunItems(runId: string) {
    try {
      setRunItems((await listAdminReconItems({ runId, pageSize: 100 })).items)
    } catch {
      setRunItems(null)
    }
  }

  function openRun(run: AdminReconRun) {
    setSelectedRun(run)
    setRunItems(null)
    void loadRunItems(run.id)
  }

  async function actOnItem(item: AdminReconItem, action: 'requery_order' | 'resolve' | 'ignore') {
    if (!selectedRun || itemBusy) return
    const reason = reviewReason.trim()
    if (action !== 'requery_order' && !reason) return
    setItemBusy(item.id)
    try {
      if (action === 'requery_order' && item.rechargeOrderId) {
        await adminReconcileRechargeOrder(item.rechargeOrderId)
        showToast('已向渠道重新查询该订单，按查询结果处理')
      } else {
        await reviewAdminReconItem(item.id, { status: action === 'resolve' ? 'resolved' : 'ignored', reason })
        setReviewReason('')
        showToast('已记录复核结论（不改变资金状态）')
      }
      await loadRunItems(selectedRun.id)
    } catch (err) {
      showToast(getApiErrorMessage(err, '处理失败'), 'error')
    } finally {
      setItemBusy(null)
    }
  }

  async function handleCopy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`已复制${label}`, 'success')
    } catch {
      showToast(`复制失败，请手动复制${label}`, 'error')
    }
  }

  async function load() {
    setLoading(true)
    try {
      const data = await listAdminReconRuns()
      setItems(data.items)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载对账批次失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="space-y-4" data-testid="admin-reconciliation">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <label htmlFor="admin-recon-provider-select" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            核对渠道:
          </label>
          <select
            id="admin-recon-provider-select"
            className="input py-1.5 text-xs w-40"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {PAYMENT_PROVIDERS.map((item) => (
              <option key={item} value={item}>{providerLabel(item)}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <AdminStatementImport provider={provider} onImported={() => void load()} />
          <button
            type="button"
            className="btn-primary btn-sm text-xs cursor-pointer"
            onClick={() => setConfirmOpen(true)}
          >
            发起对账
          </button>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={Scale} title="暂无对账批次" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>核对渠道 / 环境</th>
                <th>对账范围</th>
                <th>对账状态</th>
                <th>核对结果</th>
                <th>发起时间</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="核对渠道 / 环境">
                    <div className="font-semibold text-xs text-[var(--color-text)]">
                      {providerLabel(item.provider)}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {item.environment === 'sandbox' ? '沙箱测试' : '正式充值'}
                    </div>
                  </td>
                  <td data-label="对账范围" className="text-xs">
                    <div className="font-medium text-[var(--color-text)]">
                      {SCOPE_TYPE_LABELS[item.scopeType] || item.scopeType}
                    </div>
                    <div className="text-[11px] font-mono text-[var(--color-text-muted)] mt-0.5 truncate max-w-[180px]" title={item.scopeKey}>
                      {item.scopeKey}
                    </div>
                    {item.coverage && (
                      <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5" data-testid={`recon-coverage-${item.id}`}>
                        {STATEMENT_SOURCE_LABEL[item.coverage.statementSource]}
                      </div>
                    )}
                  </td>
                  <td data-label="对账状态">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border border-[var(--color-border)] bg-[var(--color-background)]">
                      {item.status === 'completed_with_mismatches'
                        ? '核对完成（存在差异）'
                        : RECON_STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td data-label="核对结果" className="text-xs">
                    <button
                      type="button"
                      onClick={() => openRun(item)}
                      className="text-left cursor-pointer hover:underline"
                      title="点击查看差异明细"
                    >
                      <div className={item.mismatchCount > 0 ? 'text-[var(--color-danger)] font-bold' : 'text-[var(--color-cta)] font-semibold'}>
                        发现差异 {item.mismatchCount} 条
                      </div>
                      <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                        已检查 {item.itemCount} 条
                      </div>
                    </button>
                  </td>
                  <td data-label="发起时间" className="text-xs text-[var(--color-text-muted)]">
                    {new Date(item.createdAt).toLocaleString()}
                  </td>
                  <td className="text-right whitespace-nowrap" data-label="操作">
                    <button
                      type="button"
                      className="text-xs font-bold text-[var(--color-primary)] hover:underline cursor-pointer"
                      onClick={() => openRun(item)}
                    >
                      明细{item.items && item.items.length > 0 ? ` (${item.items.length})` : ''}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={selectedRun != null} onOpenChange={(open) => { if (!open) setSelectedRun(null) }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>对账差异明细</DialogTitle>
          <DialogDescription className="text-xs text-[var(--color-text-muted)] font-mono">
            批次号: {selectedRun?.id}
          </DialogDescription>
          {selectedRun && (
            <div className="space-y-4 mt-2 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]">
                <div>
                  <span className="text-[var(--color-text-muted)] block">核对渠道</span>
                  <span className="font-semibold text-[var(--color-text)]">{providerLabel(selectedRun.provider)}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)] block">执行环境</span>
                  <span className="font-semibold text-[var(--color-text)]">
                    {selectedRun.environment === 'sandbox' ? '沙箱测试' : '正式充值'}
                  </span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)] block">检查总数</span>
                  <span className="font-bold text-[var(--color-text)]">{selectedRun.itemCount} 条</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)] block">差异条数</span>
                  <span className={`font-bold ${selectedRun.mismatchCount > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-cta)]'}`}>
                    {selectedRun.mismatchCount} 条
                  </span>
                </div>
              </div>

              <div className="p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] space-y-2">
                <div className="font-bold text-[var(--color-text)]">对账范围与目标</div>
                {selectedRun.coverage && (
                  <div className="text-[var(--color-text)]" data-testid="recon-run-coverage">覆盖：{coverageText(selectedRun.coverage)}</div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <span className="text-[var(--color-text-muted)]">范围类型：</span>
                    <span className="font-medium text-[var(--color-text)]">
                      {SCOPE_TYPE_LABELS[selectedRun.scopeType] ?? selectedRun.scopeType}
                    </span>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-[var(--color-text-muted)] block mb-0.5">对账范围标识 (scopeKey)：</span>
                    <div className="flex items-start gap-1">
                      <span className="font-mono text-[11px] break-all select-all font-medium text-[var(--color-text)]">
                        {selectedRun.scopeKey}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopy(selectedRun.scopeKey, '对账范围标识')}
                        className="btn-ghost p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0 cursor-pointer -mt-0.5"
                        aria-label="复制对账范围标识"
                        title="复制对账范围标识"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] space-y-2">
                <div className="font-bold text-[var(--color-text)]">执行时间线</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <span className="text-[var(--color-text-muted)] block">发起时间</span>
                    <span className="text-[var(--color-text)]">
                      {selectedRun.createdAt ? `${new Date(selectedRun.createdAt).toLocaleString()}（本地时间）` : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-muted)] block">执行开始</span>
                    <span className="text-[var(--color-text)]">
                      {selectedRun.startedAt ? `${new Date(selectedRun.startedAt).toLocaleString()}（本地时间）` : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-muted)] block">执行完成</span>
                    <span className="text-[var(--color-text)]">
                      {selectedRun.completedAt ? `${new Date(selectedRun.completedAt).toLocaleString()}（本地时间）` : '—'}
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="font-bold text-xs text-[var(--color-text)] mb-2">
                  差异条目明细 ({(runItems ?? selectedRun.items)?.length || 0})
                </h4>
                {runItems?.some((ri) => ri.allowedActions?.includes('resolve')) && (
                  <label className="block mb-2">复核说明（标记已核实/忽略时必填，只记录判断，不改变资金）
                    <input className="input mt-1 text-xs" maxLength={160} value={reviewReason}
                      onChange={(e) => setReviewReason(e.target.value)} />
                  </label>
                )}
                {(runItems ?? selectedRun.items) && (runItems ?? selectedRun.items).length > 0 ? (
                  <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
                    <table className="admin-table table-cards text-xs">
                      <thead>
                        <tr>
                          <th>差异类型</th>
                          <th>渠道凭据 / 订单号</th>
                          <th>平台状态 vs 渠道状态</th>
                          <th>平台金额 vs 渠道金额</th>
                          <th>条目状态</th>
                          <th>处理</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(runItems ?? selectedRun.items).map((ri) => (
                          <tr key={ri.id}>
                            <td data-label="差异类型">
                              <span className="font-bold text-[var(--color-danger)]">
                                {RECON_MISMATCH_LABEL[ri.mismatchType] ?? ri.mismatchType}
                              </span>
                            </td>
                            <td data-label="渠道凭据 / 订单号">
                              <div className="text-right sm:text-left max-w-full space-y-1">
                                <div className="flex items-start justify-end sm:justify-start gap-1 font-mono text-[11px]">
                                  <span className="break-all select-all">凭据: {ri.providerEntryKey}</span>
                                  <button
                                    type="button"
                                    onClick={() => void handleCopy(ri.providerEntryKey, '渠道凭据')}
                                    className="btn-ghost p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0 cursor-pointer -mt-0.5"
                                    aria-label="复制渠道凭据"
                                    title="复制渠道凭据"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </button>
                                </div>
                                {ri.rechargeOrderId && (
                                  <div className="flex items-start justify-end sm:justify-start gap-1 font-mono text-[11px] text-[var(--color-text-muted)]">
                                    <span className="break-all select-all">订单: {ri.rechargeOrderId}</span>
                                    <button
                                      type="button"
                                      onClick={() => void handleCopy(ri.rechargeOrderId!, '充值订单号')}
                                      className="btn-ghost p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0 cursor-pointer -mt-0.5"
                                      aria-label="复制充值订单号"
                                      title="复制充值订单号"
                                    >
                                      <Copy className="w-3 h-3" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            </td>
                            <td data-label="平台状态 vs 渠道状态">
                              <div className="text-right sm:text-left">
                                <div>
                                  <span className="text-[var(--color-text-muted)]">平台: </span>
                                  <span className="font-semibold">
                                    {ri.localStatus ? getAdminRechargeStatusConfig(ri.localStatus).label : '—'}
                                  </span>
                                </div>
                                <div className="mt-0.5">
                                  <span className="text-[var(--color-text-muted)]">渠道: </span>
                                  <span className="font-semibold text-[var(--color-primary)]">{ri.providerStatus || '—'}</span>
                                </div>
                              </div>
                            </td>
                            <td data-label="平台金额 vs 渠道金额">
                              <div className="text-right sm:text-left">
                                <div>
                                  <span className="text-[var(--color-text-muted)]">平台: </span>
                                  <span className="font-semibold">
                                    {ri.localAmountMinor ? formatCurrencyAmount(ri.localAmountMinor, ri.currency || 'CNY') : '—'}
                                  </span>
                                </div>
                                <div className="mt-0.5">
                                  <span className="text-[var(--color-text-muted)]">渠道: </span>
                                  <span className="font-semibold text-[var(--color-primary)]">
                                    {ri.providerAmountMinor ? formatCurrencyAmount(ri.providerAmountMinor, ri.currency || 'CNY') : '—'}
                                  </span>
                                </div>
                              </div>
                            </td>
                            <td data-label="条目状态">
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-bold border border-[var(--color-border)] bg-[var(--color-background)]">
                                {RECON_ITEM_STATUS_LABEL[ri.status] ?? ri.status}
                              </span>
                            </td>
                            <td data-label="处理">
                              <div className="flex flex-wrap gap-1 justify-end sm:justify-start">
                                {ri.allowedActions?.includes('requery_order') && (
                                  <button type="button" className="btn-secondary btn-sm text-[11px]" disabled={itemBusy === ri.id}
                                    onClick={() => void actOnItem(ri, 'requery_order')}>渠道重查</button>
                                )}
                                {ri.allowedActions?.includes('resolve') && (
                                  <button type="button" className="btn-secondary btn-sm text-[11px]" disabled={itemBusy === ri.id || !reviewReason.trim()}
                                    onClick={() => void actOnItem(ri, 'resolve')}>标记已核实</button>
                                )}
                                {ri.allowedActions?.includes('ignore') && (
                                  <button type="button" className="btn-secondary btn-sm text-[11px]" disabled={itemBusy === ri.id || !reviewReason.trim()}
                                    onClick={() => void actOnItem(ri, 'ignore')}>忽略</button>
                                )}
                                {ri.allowedActions?.includes('resolve_order') && (
                                  <span className="text-[11px] text-[var(--color-text-muted)]">请在充值订单中处置</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-4 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] text-center text-[var(--color-text-muted)]">
                    本次对账批次无单项差异记录
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => { if (!acting) setConfirmOpen(open) }}
        title="发起渠道对账？"
        description="核对渠道记录与平台记录，查看未一致的项目。不会手工改写订单或可用积分。"
        confirmLabel="确认发起"
        tone="primary"
        loading={acting}
        onConfirm={() => {
          setActing(true)
          createAdminReconRun({ provider })
            .then(() => {
              showToast('对账已执行')
              setConfirmOpen(false)
              void load()
            })
            .catch((err) => showToast(getApiErrorMessage(err, '对账失败'), 'error'))
            .finally(() => setActing(false))
        }}
      />
    </div>
  )
}
