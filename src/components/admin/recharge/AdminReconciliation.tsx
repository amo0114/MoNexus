import { useEffect, useState } from 'react'
import { Copy, Scale } from 'lucide-react'
import { createAdminReconRun, listAdminReconRuns, type AdminReconRun } from '../../../api/adminRecharge'
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
        <button
          type="button"
          className="btn-primary btn-sm text-xs cursor-pointer"
          onClick={() => setConfirmOpen(true)}
        >
          发起对账
        </button>
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
                      onClick={() => setSelectedRun(item)}
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
                      onClick={() => setSelectedRun(item)}
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

              <div>
                <h4 className="font-bold text-xs text-[var(--color-text)] mb-2">
                  差异条目明细 ({selectedRun.items?.length || 0})
                </h4>
                {selectedRun.items && selectedRun.items.length > 0 ? (
                  <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
                    <table className="admin-table table-cards text-xs">
                      <thead>
                        <tr>
                          <th>差异类型</th>
                          <th>渠道凭据 / 订单号</th>
                          <th>平台状态 vs 渠道状态</th>
                          <th>平台金额 vs 渠道金额</th>
                          <th>条目状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRun.items.map((ri) => (
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
