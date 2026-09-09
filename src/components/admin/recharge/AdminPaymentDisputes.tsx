import { useEffect, useState } from 'react'
import { Copy, ShieldAlert } from 'lucide-react'
import { listAdminPaymentDisputes, type AdminPaymentDispute } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import AdminPagination from '../AdminPagination'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { formatCurrencyAmount, formatPoints } from '../../../pages/recharge/money'
import { DISPUTE_STATUS_LABEL, PAYMENT_DISPUTE_STATUSES, providerLabel } from '../../../pages/recharge/status'

const PAGE_SIZE = 20

function formatShanghaiDateTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    return `${d.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}（北京时间）`
  } catch {
    return isoString
  }
}

export default function AdminPaymentDisputes() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminPaymentDispute[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [selectedDispute, setSelectedDispute] = useState<AdminPaymentDispute | null>(null)

  async function handleCopy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`已复制${label}`, 'success')
    } catch {
      showToast(`复制失败，请手动复制${label}`, 'error')
    }
  }

  useEffect(() => {
    setLoading(true)
    listAdminPaymentDisputes({ page, pageSize: PAGE_SIZE, status: status || undefined })
      .then((data) => {
        setItems(data.items)
        setTotal(data.total)
      })
      .catch((err) => showToast(getApiErrorMessage(err, '加载争议失败'), 'error'))
      .finally(() => setLoading(false))
  }, [page, status, showToast])

  return (
    <div className="space-y-4" data-testid="admin-payment-disputes">
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <label htmlFor="admin-payment-dispute-status-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            争议状态:
          </label>
          <select
            id="admin-payment-dispute-status-filter"
            className="input py-1.5 text-xs w-36"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          >
            <option value="">全部状态</option>
            {PAYMENT_DISPUTE_STATUSES.map((item) => (
              <option key={item} value={item}>{DISPUTE_STATUS_LABEL[item]}</option>
            ))}
          </select>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={ShieldAlert} title="暂无支付争议" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>争议号 / 渠道</th>
                <th>充值订单</th>
                <th>争议金额</th>
                <th>状态</th>
                <th>积分追回情况</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="争议号 / 渠道">
                    <button
                      type="button"
                      onClick={() => setSelectedDispute(item)}
                      className="text-left font-mono text-xs font-semibold text-[var(--color-primary)] hover:underline cursor-pointer"
                      title={item.providerDisputeId}
                    >
                      {item.providerDisputeId}
                    </button>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      {providerLabel(item.provider)}
                    </div>
                    {item.reasonCode && (
                      <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                        原因: {item.reasonCode}
                      </div>
                    )}
                  </td>
                  <td data-label="充值订单" className="font-mono text-xs">
                    <span title={item.rechargeOrderId}>{item.rechargeOrderId.slice(0, 8)}…</span>
                    {item.evidenceDueAt && (
                      <div className="text-[11px] text-[var(--color-warning)] mt-0.5 font-sans">
                        举证截止: {formatShanghaiDateTime(item.evidenceDueAt)}
                      </div>
                    )}
                  </td>
                  <td data-label="争议金额" className="whitespace-nowrap font-medium text-xs">
                    {formatCurrencyAmount(item.amountMinor, item.currency)}
                  </td>
                  <td data-label="状态">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border border-[var(--color-border)] bg-[var(--color-background)]">
                      {DISPUTE_STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td data-label="积分追回情况">
                    {item.recoveryCase ? (
                      <div className="text-xs space-y-0.5">
                        <div>
                          <span className="text-[var(--color-text-muted)]">已冻结待追回：</span>
                          <span className="font-semibold text-[var(--color-warning)]">{formatPoints(item.recoveryCase.pointsHeld)} 积分</span>
                        </div>
                        <div>
                          <span className="text-[var(--color-text-muted)]">应追回：</span>
                          <span className="font-semibold text-[var(--color-danger)]">{formatPoints(item.recoveryCase.pointsToRecover)} 积分</span>
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)]">—</span>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap" data-label="操作">
                    <button
                      type="button"
                      className="text-xs font-bold text-[var(--color-primary)] hover:underline cursor-pointer"
                      onClick={() => setSelectedDispute(item)}
                    >
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <Dialog open={selectedDispute != null} onOpenChange={(open) => { if (!open) setSelectedDispute(null) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>支付争议详情</DialogTitle>
          <DialogDescription className="text-xs text-[var(--color-text-muted)] font-mono">
            争议记录ID: {selectedDispute?.id}
          </DialogDescription>
          {selectedDispute && (
            <div className="space-y-3 mt-2 text-xs">
              <div className="grid grid-cols-2 gap-2 p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]">
                <div>
                  <span className="text-[var(--color-text-muted)]">渠道：</span>
                  <span className="font-semibold text-[var(--color-text)]">{providerLabel(selectedDispute.provider)}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">争议状态：</span>
                  <span className="font-bold text-[var(--color-text)]">{DISPUTE_STATUS_LABEL[selectedDispute.status] ?? selectedDispute.status}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">争议金额：</span>
                  <span className="font-bold text-[var(--color-danger)]">{formatCurrencyAmount(selectedDispute.amountMinor, selectedDispute.currency)}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">原因代号：</span>
                  <span className="font-mono text-[var(--color-text)]">{selectedDispute.reasonCode || '未提供'}</span>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <div className="text-[var(--color-text-muted)] font-medium mb-1">渠道争议编号 (Provider Dispute ID)</div>
                  <div className="flex items-center justify-between gap-2 p-2 bg-[var(--color-background)] rounded border border-[var(--color-border)] font-mono text-[11px] break-all select-all">
                    <span>{selectedDispute.providerDisputeId}</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy(selectedDispute.providerDisputeId, '渠道争议编号')}
                      className="btn-ghost p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0 cursor-pointer"
                      aria-label="复制渠道争议编号"
                      title="复制渠道争议编号"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-[var(--color-text-muted)] font-medium mb-1">关联充值订单 (Recharge Order ID)</div>
                  <div className="flex items-center justify-between gap-2 p-2 bg-[var(--color-background)] rounded border border-[var(--color-border)] font-mono text-[11px] break-all select-all">
                    <span>{selectedDispute.rechargeOrderId}</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy(selectedDispute.rechargeOrderId, '充值订单号')}
                      className="btn-ghost p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0 cursor-pointer"
                      aria-label="复制充值订单号"
                      title="复制充值订单号"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] space-y-1.5 text-[11px]">
                <div className="font-bold text-[var(--color-text)] mb-1">时间轨迹（北京时间）</div>
                <div>
                  <span className="text-[var(--color-text-muted)]">争议发起时间：</span>
                  <span className="text-[var(--color-text)]">{formatShanghaiDateTime(selectedDispute.openedAt)}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">举证截止时间：</span>
                  <span className={selectedDispute.evidenceDueAt ? 'text-[var(--color-warning)] font-semibold' : 'text-[var(--color-text-muted)]'}>
                    {selectedDispute.evidenceDueAt ? formatShanghaiDateTime(selectedDispute.evidenceDueAt) : '无截止时间'}
                  </span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">争议关闭时间：</span>
                  <span className="text-[var(--color-text)]">
                    {selectedDispute.closedAt ? formatShanghaiDateTime(selectedDispute.closedAt) : '处理中（未关闭）'}
                  </span>
                </div>
              </div>

              <div className="p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] text-xs space-y-2">
                <div className="font-bold text-[var(--color-text)]">积分追回关联详情</div>
                {selectedDispute.recoveryCase ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <div>
                        <span className="text-[var(--color-text-muted)] block">应追回积分</span>
                        <span className="font-bold text-[var(--color-danger)]">{formatPoints(selectedDispute.recoveryCase.pointsToRecover)} 积分</span>
                      </div>
                      <div>
                        <span className="text-[var(--color-text-muted)] block">已冻结积分</span>
                        <span className="font-semibold text-[var(--color-warning)]">{formatPoints(selectedDispute.recoveryCase.pointsHeld)} 积分</span>
                      </div>
                      <div>
                        <span className="text-[var(--color-text-muted)] block">待追回积分</span>
                        <span className="font-semibold text-[var(--color-text)]">{formatPoints(selectedDispute.recoveryCase.outstandingPoints)} 积分</span>
                      </div>
                    </div>
                    <details className="text-[11px] text-[var(--color-text-muted)] pt-1.5 border-t border-[var(--color-border)]">
                      <summary className="cursor-pointer hover:underline text-[var(--color-primary)]">追偿技术参数</summary>
                      <div className="mt-1.5 space-y-1 font-mono text-[10px]">
                        <div>案件标识 (ID): <span className="select-all">{selectedDispute.recoveryCase.id}</span></div>
                        <div>原始状态 (Status): <span>{selectedDispute.recoveryCase.status}</span></div>
                      </div>
                    </details>
                  </div>
                ) : (
                  <div className="text-[11px] text-[var(--color-text-muted)]">暂无关联追偿案件记录</div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
