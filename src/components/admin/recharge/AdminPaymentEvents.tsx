import { useEffect, useState } from 'react'
import { Activity, Copy } from 'lucide-react'
import { listAdminPaymentEvents, retryAdminPaymentEvent, type AdminPaymentEvent } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import AdminPagination from '../AdminPagination'
import ConfirmDialog from '../../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { EVENT_STATUS_LABEL, PAYMENT_EVENT_STATUSES, PAYMENT_PROVIDERS, providerLabel } from '../../../pages/recharge/status'
import { PAYMENT_EVENT_SOURCE_LABEL } from '../../../utils/adminRechargeDisplay'

const PAGE_SIZE = 50

export default function AdminPaymentEvents() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminPaymentEvent[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [provider, setProvider] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailTarget, setDetailTarget] = useState<AdminPaymentEvent | null>(null)
  const [retryTarget, setRetryTarget] = useState<AdminPaymentEvent | null>(null)
  const [acting, setActing] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await listAdminPaymentEvents({
        page,
        pageSize: PAGE_SIZE,
        status: status || undefined,
        provider: provider || undefined,
      })
      setItems(data.items)
      setTotal(data.total)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载支付事件失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [page, status, provider])

  return (
    <div className="space-y-4" data-testid="admin-payment-events">
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <label htmlFor="admin-payment-event-status-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            处理状态:
          </label>
          <select
            id="admin-payment-event-status-filter"
            className="input py-1.5 text-xs w-36"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          >
            <option value="">全部状态</option>
            {PAYMENT_EVENT_STATUSES.map((item) => (
              <option key={item} value={item}>{EVENT_STATUS_LABEL[item]}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="admin-payment-event-provider-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            支付渠道:
          </label>
          <select
            id="admin-payment-event-provider-filter"
            className="input py-1.5 text-xs w-36"
            value={provider}
            onChange={(e) => { setProvider(e.target.value); setPage(1) }}
          >
            <option value="">全部渠道</option>
            {PAYMENT_PROVIDERS.map((item) => (
              <option key={item} value={item}>{providerLabel(item)}</option>
            ))}
          </select>
        </div>
      </div>
      {loading && items.length === 0 ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={Activity} title="暂无支付事件" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>接收时间</th>
                <th>渠道</th>
                <th>事件来源</th>
                <th>处理状态</th>
                <th>关联支付标识</th>
                <th>失败摘要</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="接收时间" className="text-xs text-[var(--color-text-muted)]">
                    {new Date(item.createdAt).toLocaleString()}
                  </td>
                  <td data-label="渠道" className="font-semibold text-xs text-[var(--color-text)]">
                    {providerLabel(item.provider)}
                  </td>
                  <td data-label="事件来源" className="text-xs">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                      {PAYMENT_EVENT_SOURCE_LABEL[item.source] || item.source}
                    </span>
                  </td>
                  <td data-label="处理状态">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border border-[var(--color-border)] bg-[var(--color-background)]">
                      {EVENT_STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td data-label="关联支付标识">
                    <button
                      type="button"
                      onClick={() => setDetailTarget(item)}
                      className="text-left font-mono text-xs text-[var(--color-text)] space-y-0.5 hover:text-[var(--color-primary)] transition-colors cursor-pointer"
                      title="点击查看完整标识详情"
                    >
                      {item.paymentAttemptId && (
                        <div>尝试: {item.paymentAttemptId.slice(0, 10)}…</div>
                      )}
                      {item.providerPaymentId && (
                        <div className="text-[var(--color-text-muted)] text-[11px]">渠道: {item.providerPaymentId.slice(0, 14)}…</div>
                      )}
                      {!item.paymentAttemptId && !item.providerPaymentId && <span className="text-[var(--color-text-muted)]">—</span>}
                    </button>
                  </td>
                  <td data-label="失败摘要">
                    {item.status === 'succeeded' ? (
                      <span className="text-xs text-[var(--color-text-muted)]">—</span>
                    ) : (
                      <div className="text-xs">
                        {item.lastErrorCode ? (
                          <span className="text-[var(--color-danger)] font-mono">{item.lastErrorCode}</span>
                        ) : (
                          <span className="text-[var(--color-text-muted)]">—</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap space-x-2" data-label="操作">
                    <button
                      type="button"
                      className="text-xs font-bold text-[var(--color-primary)] hover:underline cursor-pointer"
                      onClick={() => setDetailTarget(item)}
                    >
                      详情
                    </button>
                    {(item.status === 'failed' || item.status === 'received') && (
                      <button
                        type="button"
                        className="text-xs font-bold text-[var(--color-primary)] hover:underline cursor-pointer"
                        onClick={() => setRetryTarget(item)}
                      >
                        重试
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <Dialog open={detailTarget != null} onOpenChange={(open) => { if (!open) setDetailTarget(null) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>支付事件详情</DialogTitle>
          <DialogDescription className="text-xs text-[var(--color-text-muted)] font-mono">
            事件ID: {detailTarget?.id}
          </DialogDescription>
          {detailTarget && (
            <div className="space-y-3 mt-2 text-xs">
              <div className="grid grid-cols-2 gap-2 p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]">
                <div>
                  <span className="text-[var(--color-text-muted)]">渠道：</span>
                  <span className="font-semibold text-[var(--color-text)]">{providerLabel(detailTarget.provider)}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">事件来源：</span>
                  <span className="font-semibold text-[var(--color-text)]">{PAYMENT_EVENT_SOURCE_LABEL[detailTarget.source] || detailTarget.source}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">处理状态：</span>
                  <span className="font-bold text-[var(--color-text)]">{EVENT_STATUS_LABEL[detailTarget.status] ?? detailTarget.status}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">重试次数：</span>
                  <span className="font-mono text-[var(--color-text)]">{detailTarget.attempts}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-[var(--color-text-muted)]">原始事件类型 (EventType)：</span>
                  <span className="font-mono font-bold text-[var(--color-text)] ml-1 select-all">{detailTarget.eventType}</span>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <div className="text-[var(--color-text-muted)] font-medium mb-1">支付尝试标识 (Payment Attempt ID)</div>
                  <div className="flex items-center justify-between gap-2 p-2 bg-[var(--color-background)] rounded border border-[var(--color-border)] font-mono text-[11px] break-all select-all">
                    <span>{detailTarget.paymentAttemptId || '（无）'}</span>
                    {detailTarget.paymentAttemptId && (
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(detailTarget.paymentAttemptId!)
                          showToast('已复制尝试标识')
                        }}
                        className="btn-ghost p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0 cursor-pointer"
                        title="复制"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div className="text-[var(--color-text-muted)] font-medium mb-1">渠道交易号 (Provider Payment ID)</div>
                  <div className="flex items-center justify-between gap-2 p-2 bg-[var(--color-background)] rounded border border-[var(--color-border)] font-mono text-[11px] break-all select-all">
                    <span>{detailTarget.providerPaymentId || '（无）'}</span>
                    {detailTarget.providerPaymentId && (
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(detailTarget.providerPaymentId!)
                          showToast('已复制渠道交易号')
                        }}
                        className="btn-ghost p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0 cursor-pointer"
                        title="复制"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {detailTarget.lastErrorCode && (
                  <div>
                    <div className="text-[var(--color-danger)] font-medium mb-1">错误码 (Last Error Code)</div>
                    <div className="p-2 bg-[var(--color-danger)]/10 text-[var(--color-danger)] rounded border border-[var(--color-danger)]/20 font-mono text-[11px] select-all">
                      {detailTarget.lastErrorCode}
                    </div>
                  </div>
                )}
              </div>

              <div className="p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] space-y-1 text-[11px] text-[var(--color-text-muted)]">
                <div>接收时间：{new Date(detailTarget.createdAt).toLocaleString()}</div>
                <div>处理时间：{detailTarget.processedAt ? new Date(detailTarget.processedAt).toLocaleString() : '未完成处理'}</div>
                <div>
                  处理耗时：
                  {detailTarget.processedAt
                    ? `${Math.max(0, new Date(detailTarget.processedAt).getTime() - new Date(detailTarget.createdAt).getTime())} ms`
                    : '—'}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={retryTarget != null}
        onOpenChange={(open) => { if (!open && !acting) setRetryTarget(null) }}
        title="重试该支付事件？"
        description="重新核验支付结果并尝试继续处理，请在订单详情查看处理结果。不会写入原始回调或密钥。"
        confirmLabel="重试"
        tone="primary"
        loading={acting}
        onConfirm={() => {
          if (!retryTarget) return
          setActing(true)
          retryAdminPaymentEvent(retryTarget.id)
            .then(() => {
              showToast('已提交重试')
              setRetryTarget(null)
              void load()
            })
            .catch((err) => showToast(getApiErrorMessage(err, '重试失败'), 'error'))
            .finally(() => setActing(false))
        }}
      />
    </div>
  )
}
