import { useEffect, useState } from 'react'
import {
  createAdminOrderAfterSales,
  executeAdminAfterSales,
  listAdminOrderAfterSales,
  rejectAdminAfterSales,
  type AdminAfterSalesCase,
  type AfterSalesSourceComposition,
} from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

const ORIGIN_LABELS: Record<string, string> = {
  recharge: '充值积分',
  reward: '奖励积分',
  merchant_settlement: '结算积分',
  admin_adjustment: '后台调整积分',
  legacy_unknown: '历史积分（来源未知）',
}

function Composition({ value }: { value: AfterSalesSourceComposition | null }) {
  if (!value || Object.keys(value).length === 0) return <span>历史订单，来源未记录</span>
  return <span>{Object.entries(value).map(([origin, points]) => `${ORIGIN_LABELS[origin] ?? origin} ${points}`).join('，')}</span>
}

/**
 * Full refund of a closed order. The order stays closed; points return to the
 * sources they were paid from, and a settled earning is reversed with any
 * merchant shortfall tracked separately. No partial amounts in this batch.
 */
export default function AdminOrderAfterSales({ orderId, onSuccess }: { orderId: number; onSuccess?: () => void }) {
  const showToast = useAppStore((s) => s.showToast)
  const [cases, setCases] = useState<AdminAfterSalesCase[]>([])
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      setCases(await listAdminOrderAfterSales(orderId))
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载售后记录失败'), 'error')
    }
  }

  useEffect(() => { void load() }, [orderId])

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return
    setBusy(true)
    try {
      await action()
      showToast(success)
      setReason(''); setNote(''); setConfirmed(false)
      await load()
      onSuccess?.()
    } catch (err) {
      showToast(getApiErrorMessage(err, '售后处理失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const open = cases.find((c) => c.status === 'open')
  const executed = cases.find((c) => c.status === 'executed')
  return (
    <section className="p-3.5 rounded-xl border border-[var(--color-border)] space-y-3 text-xs" data-testid="admin-order-after-sales">
      <h3 className="font-bold text-sm">订单售后（全额退款）</h3>
      {executed && (
        <div className="space-y-1">
          <div>已执行：退还 {executed.refundAmount} 积分（<Composition value={executed.paymentComposition} />）</div>
          {executed.adjustment && (
            <div>
              商家收益冲正 {executed.adjustment.settlementDelta}，佣金冲正 {executed.adjustment.commissionDelta}，已扣回 {executed.adjustment.clawbackPoints}
              {executed.adjustment.recoveryCase ? `，欠收 #${executed.adjustment.recoveryCase.id} 应收 ${executed.adjustment.recoveryCase.amountDue}` : ''}
            </div>
          )}
        </div>
      )}
      {open && (
        <div className="space-y-2">
          <div>售后 #{open.id}：{open.reason}</div>
          <div>原支付：<Composition value={open.paymentComposition} /></div>
          {open.settlement && (
            <div>
              商家收益：{open.settlement.status === 'settled'
                ? `已入账 ${open.settlement.settlementAmount} 积分${open.settlement.batchId ? `（批次 #${open.settlement.batchId}）` : ''}`
                : '尚未入账，执行后作废'}
              {open.estimatedShortfall ? `；预计商家结算积分不足 ${open.estimatedShortfall}，将形成欠收` : ''}
            </div>
          )}
          {open.blocker && <div className="text-[var(--color-danger)]">{open.blocker}</div>}
          <label className="block">处理备注
            <input className="input mt-1" value={note} maxLength={500} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          </label>
          {open.allowedActions.includes('execute') && (
            <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)} />我已核实售后依据，确认按原来源全额退款</label>
          )}
          <div className="flex gap-2">
            {open.allowedActions.includes('reject') && (
              <button type="button" className="btn-secondary btn-sm text-xs" disabled={busy || !note.trim()}
                onClick={() => void run(() => rejectAdminAfterSales(open.id, note.trim()), '已驳回售后')}>驳回</button>
            )}
            {open.allowedActions.includes('execute') && (
              <button type="button" className="btn-primary btn-sm text-xs" disabled={busy || !confirmed}
                onClick={() => void run(() => executeAdminAfterSales(open.id, note.trim() || undefined), '售后退款已执行')}>执行全额退款</button>
            )}
          </div>
        </div>
      )}
      {!open && !executed && (
        <div className="space-y-2">
          <label className="block">售后依据（必填）
            <textarea className="input mt-1" value={reason} maxLength={500} disabled={busy}
              onChange={(e) => setReason(e.target.value)} placeholder="例如：商品与描述严重不符，附工单号" />
          </label>
          <button type="button" className="btn-secondary btn-sm text-xs" disabled={busy || !reason.trim()}
            onClick={() => void run(() => createAdminOrderAfterSales(orderId, { reason: reason.trim() }), '已发起售后，请核对后执行')}>发起售后</button>
        </div>
      )}
    </section>
  )
}
