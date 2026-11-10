import { useState } from 'react'
import { closeAdminPaymentRecoveryCase } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import ConfirmDialog from '../../ui/ConfirmDialog'

type CloseStatus = 'recovered' | 'written_off' | 'restored'

// What each verdict actually does to the user's points (see disputes/service.ts).
const OUTCOMES: Record<CloseStatus, { label: string; effect: string }> = {
  recovered: { label: '确认已追回', effect: '扣除仍冻结的积分作为追回，解除账户限制；用于已通过其他途径收回的情况。' },
  written_off: { label: '核销为平台损失', effect: '扣除仍冻结的积分，剩余差额由平台承担，解除账户限制。' },
  restored: { label: '恢复用户积分', effect: '释放冻结积分；若已扣回则按原来源退还，解除账户限制。' },
}

export default function AdminPaymentRecoveryClose({ caseId, status, onClosed }: { caseId: string; status: string; onClosed?: () => void }) {
  const showToast = useAppStore((s) => s.showToast)
  const [target, setTarget] = useState<CloseStatus | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  if (status === 'recovered' || status === 'written_off' || status === 'restored') return null

  async function confirm() {
    if (!target || busy) return
    setBusy(true)
    try {
      await closeAdminPaymentRecoveryCase(caseId, { status: target, resolutionReason: reason.trim() })
      showToast('恢复案件已结案')
      setTarget(null)
      setReason('')
      onClosed?.()
    } catch (err) {
      showToast(getApiErrorMessage(err, '结案失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 pt-2 border-t border-[var(--color-border)]" data-testid="admin-recovery-close">
      <label className="block text-[11px]">结案依据（必填）
        <input className="input mt-1 text-xs" maxLength={160} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(OUTCOMES) as CloseStatus[]).map((key) => (
          <button key={key} type="button" className="btn-secondary btn-sm text-[11px]" disabled={busy || !reason.trim()} onClick={() => setTarget(key)}>
            {OUTCOMES[key].label}
          </button>
        ))}
      </div>
      <ConfirmDialog
        open={target != null}
        onOpenChange={(open) => { if (!open && !busy) setTarget(null) }}
        title={target ? OUTCOMES[target].label : ''}
        description={target ? OUTCOMES[target].effect : ''}
        tone="primary"
        loading={busy}
        onConfirm={() => void confirm()}
      />
    </div>
  )
}
