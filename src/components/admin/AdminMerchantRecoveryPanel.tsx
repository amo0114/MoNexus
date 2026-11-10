import { useEffect, useState } from 'react'
import { actOnMerchantRecovery, getMerchantRecoveryCases } from '../../api/adminMerchant'
import { getApiErrorMessage } from '../../api/error'
import type { MerchantRecoveryActionKind, MerchantRecoveryCase } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'

const ACTION_LABELS: Record<MerchantRecoveryActionKind, string> = {
  wallet_clawback: '从结算积分扣回',
  offline_received: '登记线下收讫',
  waived: '平台豁免',
}

/**
 * Open merchant shortfalls from after-sales reversals. Each action is an
 * evidenced fact: offline receipt does not credit anyone, a waiver records the
 * platform absorbing the loss. An open case pauses that merchant's settlements.
 */
export default function AdminMerchantRecoveryPanel({ active = true, onChanged }: { active?: boolean; onChanged?: () => void }) {
  const showToast = useAppStore((s) => s.showToast)
  const [cases, setCases] = useState<MerchantRecoveryCase[]>([])
  const [editing, setEditing] = useState<{ id: number; kind: MerchantRecoveryActionKind; amount: string; evidence: string; requestKey: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      setCases((await getMerchantRecoveryCases({ status: 'open', pageSize: 50 })).items)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载商家欠收失败'), 'error')
    }
  }

  useEffect(() => {
    if (active) void load()
  }, [active])

  async function submit() {
    if (!editing || busy) return
    setBusy(true)
    try {
      await actOnMerchantRecovery(editing.id, {
        kind: editing.kind,
        amount: Number(editing.amount),
        requestKey: editing.requestKey,
        evidence: editing.evidence.trim() || undefined,
      })
      showToast('已记录欠收处理')
      setEditing(null)
      await load()
      onChanged?.()
    } catch (err) {
      showToast(getApiErrorMessage(err, '欠收处理失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (cases.length === 0) return null
  return (
    <section className="space-y-2" data-testid="admin-merchant-recovery">
      <h3 className="font-bold text-sm">商家欠收（售后冲正后结算积分不足）</h3>
      <p className="text-xs text-[var(--color-text-muted)]">有未结清欠收的商家暂停自动结算；买家退款不受影响。</p>
      {cases.map((c) => (
        <div key={c.id} className="p-3 rounded-xl border border-[var(--color-border)] text-xs space-y-2">
          <div className="flex flex-wrap justify-between gap-2">
            <span>欠收 #{c.id} · 商家 #{c.merchantId} · ORD-{c.orderId}</span>
            <span className="font-bold text-[var(--color-danger)]">未收 {c.outstanding.toLocaleString()} / 应收 {c.amountDue.toLocaleString()} 积分</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {c.allowedActions.map((kind) => (
              <button
                key={kind}
                type="button"
                className="btn-secondary btn-sm text-xs"
                disabled={busy}
                onClick={() => setEditing({ id: c.id, kind, amount: String(c.outstanding), evidence: '', requestKey: crypto.randomUUID() })}
              >
                {ACTION_LABELS[kind]}
              </button>
            ))}
          </div>
          {editing?.id === c.id && (
            <div className="space-y-2">
              <label className="block">金额（积分，不超过未收部分）
                <input className="input mt-1" inputMode="numeric" value={editing.amount} disabled={busy}
                  onChange={(e) => setEditing({ ...editing, amount: e.target.value.replace(/\D/g, '') })} />
              </label>
              {editing.kind !== 'wallet_clawback' && (
                <label className="block">凭证（必填：转账单号、豁免依据等，勿填写密码或密钥）
                  <textarea className="input mt-1" maxLength={1000} value={editing.evidence} disabled={busy}
                    onChange={(e) => setEditing({ ...editing, evidence: e.target.value })} />
                </label>
              )}
              <div className="flex gap-2">
                <button type="button" className="btn-secondary btn-sm text-xs" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                <button
                  type="button"
                  className="btn-primary btn-sm text-xs"
                  disabled={busy || !Number(editing.amount) || (editing.kind !== 'wallet_clawback' && !editing.evidence.trim())}
                  onClick={() => void submit()}
                >
                  确认{ACTION_LABELS[editing.kind]}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  )
}
