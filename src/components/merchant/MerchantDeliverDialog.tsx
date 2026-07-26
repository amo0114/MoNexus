import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { useAppStore } from '../../stores/appStore'
import { getMerchantOrderDetail } from '../../api/merchant'
import { MerchantOrder } from '../../types/merchant'

interface Props {
  isOpen: boolean
  onClose: () => void
  order: MerchantOrder | null
  onSubmit: (payload: { deliveryContent?: string; structuredValues?: Record<string, string> }) => Promise<void>
}

export default function MerchantDeliverDialog({ isOpen, onClose, order, onSubmit }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [content, setContent] = useState('')
  const [structuredValues, setStructuredValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<MerchantOrder | null>(null)

  // P4b：按订单的模板快照渲染（下单时冻结——商家改规格模板不影响本单契约）；
  // 无快照保持单文本框（纯文本交付，旧行为）。
  const template = order?.deliveryFieldsSnapshot ?? []
  const isStructured = template.length > 0

  useEffect(() => {
    if (!isOpen) return
    setContent('')
    setStructuredValues({})
    setDetail(null)
    if (order?.id == null) return
    // 买家购买前填写的信息只在订单详情接口返回（列表按敏感边界剥离），
    // 发货时按需拉取，作为履约依据展示。
    let cancelled = false
    getMerchantOrderDetail(order.id)
      .then((data) => { if (!cancelled) setDetail(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isOpen, order?.id])

  const answers = detail?.purchaseFormAnswers ?? null
  const snapshot = detail?.purchaseFormSnapshot ?? null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isStructured) {
      const missing = template.find(f => !(structuredValues[f.key] ?? '').trim())
      if (missing) {
        showToast(`交付字段「${missing.label}」不能为空`, 'error')
        return
      }
    } else if (!content.trim()) {
      showToast('发货内容不能为空', 'error')
      return
    }
    setLoading(true)
    try {
      await onSubmit(
        isStructured
          ? { structuredValues: Object.fromEntries(template.map(f => [f.key, structuredValues[f.key].trim()])) }
          : { deliveryContent: content.trim() }
      )
      onClose()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '发货失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent data-testid="merchant-deliver-dialog">
        <DialogTitle>订单发货</DialogTitle>
        <DialogDescription>
          订单 #{order?.id ?? ''} · {order?.product?.name ?? ''}，发货内容将直接交付给买家。
        </DialogDescription>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4" data-testid="merchant-deliver-form">
          {answers && Object.keys(answers).length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3" data-testid="merchant-buyer-answers">
              <div className="text-xs font-bold text-[var(--color-text-muted)] mb-2 uppercase tracking-wider">
                买家购买时填写的信息
              </div>
              <dl className="space-y-1 text-xs">
                {Object.entries(answers).map(([key, value]) => {
                  const label = snapshot?.find(f => f.key === key)?.label ?? key
                  return (
                    <div key={key} className="flex gap-2">
                      <dt className="text-[var(--color-text-muted)] shrink-0">{label}：</dt>
                      <dd className="text-[var(--color-text)] break-all">{value}</dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          )}
          {isStructured ? (
            <div className="space-y-3" data-testid="merchant-deliver-structured">
              {template.map(field => (
                <div key={field.key}>
                  <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
                    {field.label} <span className="text-red-500 normal-case">*</span>
                  </label>
                  <input
                    type="text"
                    className="input font-mono"
                    placeholder={field.placeholder ?? ''}
                    maxLength={2000}
                    value={structuredValues[field.key] ?? ''}
                    onChange={(e) => setStructuredValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                    spellCheck="false"
                    data-testid={`merchant-deliver-field-${field.key}`}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div>
              <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
                发货内容（卡密 / 账号等） <span className="text-red-500 normal-case">*</span>
              </label>
              <textarea
                required
                className="input min-h-[140px] font-mono leading-relaxed resize-y"
                placeholder={'例如:\nABCD-1234-EFGH-5678\n账号: xxx 密码: yyy'}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck="false"
                data-testid="merchant-deliver-content"
              />
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-secondary px-5 py-2 text-sm" disabled={loading}>
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary px-5 py-2 text-sm min-w-[110px]"
              data-testid="merchant-deliver-submit"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '确认发货'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
