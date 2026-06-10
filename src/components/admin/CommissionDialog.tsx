import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { updateMerchantCommission } from '../../api/adminMerchant'
import { getApiErrorMessage } from '../../api/error'
import { Merchant } from '../../types/merchant'

interface Props {
  merchant: Merchant | null
  onClose: () => void
  /** 更新成功后回调（父级负责 Toast 与刷新列表） */
  onSuccess: () => void
}

/** 校验百分比输入：0-100，最多两位小数。返回错误文案或 null */
function validatePercent(raw: string): string | null {
  if (raw.trim() === '') return '请输入抽成比例'
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw.trim())) return '格式无效：请输入 0-100 之间的数字，最多两位小数'
  const n = Number(raw)
  if (n < 0 || n > 100) return '抽成比例必须在 0-100 之间'
  return null
}

/** 改抽成对话框：百分比输入（0-100，两位小数），提交前换算为 0-1 小数并展示确认文案 */
export default function CommissionDialog({ merchant, onClose, onSuccess }: Props) {
  const [percent, setPercent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (merchant) {
      setPercent((Number(merchant.commissionRate) * 100).toFixed(2).replace(/\.?0+$/, '') || '0')
      setError(null)
      setSubmitting(false)
    }
  }, [merchant?.id])

  const validationError = validatePercent(percent)
  // 换算：百分比 -> 0-1 小数（保留 4 位精度，对应两位小数百分比）
  const rate = validationError === null ? Math.round(Number(percent) * 100) / 10000 : null

  async function handleSubmit() {
    if (!merchant) return
    if (validationError) {
      setError(validationError)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await updateMerchantCommission(merchant.id, { commissionRate: rate! })
      onSuccess()
    } catch (err: any) {
      setError(getApiErrorMessage(err, '更新抽成失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={!!merchant} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent data-testid="commission-dialog" className="!max-w-sm">
        <DialogTitle>调整平台抽成</DialogTitle>
        <DialogDescription>
          商家「{merchant?.name}」当前抽成 {(Number(merchant?.commissionRate ?? 0) * 100).toFixed(2)}%
        </DialogDescription>
        <div className="space-y-4 mt-4">
          <div>
            <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
              新抽成比例（%）
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={percent}
                onChange={(e) => {
                  setPercent(e.target.value)
                  setError(null)
                }}
                placeholder="如 10 或 12.5"
                data-testid="commission-rate-input"
                className="input !text-sm"
              />
              <span className="text-sm text-[var(--color-text-muted)]">%</span>
            </div>
            {percent.trim() !== '' && validationError && (
              <div className="text-xs text-[var(--color-danger)] mt-1.5">{validationError}</div>
            )}
          </div>
          {rate !== null && (
            <div
              className="text-xs text-[var(--color-text)] bg-[var(--color-info)]/8 border border-[var(--color-info)]/20 rounded px-3 py-2"
              data-testid="commission-confirm-text"
            >
              确认后，平台将按订单金额的 <span className="font-bold">{Number(percent)}%</span> 抽成（提交值 {rate}）。
            </div>
          )}
          {error && (
            <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20">
              {error}
            </div>
          )}
          <button
            onClick={handleSubmit}
            disabled={submitting || !!validationError}
            data-testid="commission-submit"
            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? '提交中...' : '确认调整'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
