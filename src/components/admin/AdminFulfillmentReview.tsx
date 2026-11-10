import { useState } from 'react'
import { reviewAdminOrderFulfillment, type AdminOrderDetail } from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

export default function AdminFulfillmentReview({ order, onSuccess }: { order: AdminOrderDetail; onSuccess?: () => void }) {
  const [evidence, setEvidence] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const showToast = useAppStore(s => s.showToast)
  // The backend computes what fulfillment-review would accept; older payloads fall back to the status gate.
  const actions = order.fulfillmentReviewActions
    ?? (['pending', 'processing'].includes(order.status) && !order.delivery?.id
      && (order.cancelRequestedAt || order.externalFulfillment || order.provisionTask)
      ? ['recheck_cancel', ...(order.cancelRequestedAt && !order.fakaBridgeTask ? ['confirm_cancelled' as const] : [])]
      : [])
  if (actions.length === 0) return null
  const diag = order.fulfillmentDiagnostics
  async function submit(action: 'retry' | 'confirm_cancelled') {
    if (busy) return
    setBusy(true)
    try {
      const result = await reviewAdminOrderFulfillment(order.id, action === 'retry'
        ? { action } : { action, evidence: evidence.trim() })
      showToast(result.outcome === 'refunded' ? '核对取消完成，积分已退还' : '已请求核对取消，积分保持冻结')
      setEvidence(''); setConfirmed(false)
      onSuccess?.()
    } catch (err) { showToast(getApiErrorMessage(err, '履约核对失败'), 'error') }
    finally { setBusy(false) }
  }
  return <section className="p-3.5 rounded-xl border border-[var(--color-border)] space-y-3" data-testid="admin-fulfillment-review">
    <h3 className="font-bold text-sm">外部履约核对</h3>
    <p className="text-xs text-[var(--color-text-muted)]">先重新核对取消（不会重新执行交付）。远端结果未知时积分继续冻结；超时、404 和联系不上供应商均不能作为退款证据。</p>
    {diag && <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs" data-testid="admin-fulfillment-diagnostics">
      <dt className="text-[var(--color-text-muted)]">任务</dt><dd>{diag.kind === 'xboard' ? 'Xboard' : diag.providerId ?? '外部履约'} #{diag.taskId ?? '—'}</dd>
      <dt className="text-[var(--color-text-muted)]">状态</dt><dd>{diag.status}{diag.leaseActive ? '（执行中）' : ''}</dd>
      <dt className="text-[var(--color-text-muted)]">尝试次数</dt><dd>{diag.attempts ?? '—'}</dd>
      <dt className="text-[var(--color-text-muted)]">取消意图</dt><dd>{diag.cancelRequested ? '已请求' : '无'}</dd>
      {diag.revokeStatus && <><dt className="text-[var(--color-text-muted)]">撤销</dt><dd>{diag.revokeStatus}{diag.revokedAt ? ` · ${new Date(diag.revokedAt).toLocaleString()}` : ''}</dd></>}
    </dl>}
    {actions.includes('recheck_cancel') && <button className="btn-secondary text-xs" disabled={busy} onClick={() => void submit('retry')}>重新核对取消</button>}
    {order.fakaBridgeTask && <p className="text-xs">Xboard 订单须由供应商撤销核验成功后退款，请处理撤销任务并重新核对。</p>}
    {actions.includes('confirm_cancelled') && <>
      <label className="block text-xs">远端已撤销或确认未生效的证据（至少 20 字符）
        <textarea className="input mt-1" value={evidence} maxLength={1000} disabled={busy}
          onChange={event => setEvidence(event.target.value)} placeholder="填写供应商工单或撤销凭证、核对时间；勿填写密码或密钥" />
      </label>
      <label className="flex gap-2 text-xs"><input type="checkbox" checked={confirmed} disabled={busy}
        onChange={event => setConfirmed(event.target.checked)} />我已核实远端未生效或已撤销，并确认退款</label>
      <button className="btn-primary text-xs" disabled={busy || !confirmed || evidence.trim().length < 20}
        onClick={() => void submit('confirm_cancelled')}>记录证据并退款</button>
    </>}
  </section>
}
