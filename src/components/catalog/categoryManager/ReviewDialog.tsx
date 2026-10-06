import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import {
  CATEGORY_CODE_PATTERN,
  type CategoryAdminDto,
  type CategoryApplicationDto,
} from '../../../types/catalog'
import type { ReviewMode } from './types'

export default function ReviewDialog({
  open,
  onOpenChange,
  mode,
  application,
  activeCategories,
  busy,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ReviewMode
  application: CategoryApplicationDto | null
  activeCategories: CategoryAdminDto[]
  busy: boolean
  onSubmit: (payload: {
    resolution?: 'create_new' | 'map_existing'
    code?: string
    label?: string
    description?: string
    iconKey?: string
    categoryId?: number
    reviewReason: string
  }) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [iconKey, setIconKey] = useState('')
  const [categoryId, setCategoryId] = useState<number | ''>('')
  const [reviewReason, setReviewReason] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setCode(application?.proposedCode && CATEGORY_CODE_PATTERN.test(application.proposedCode) ? application.proposedCode : '')
    setLabel(application?.proposedLabel ?? '')
    setDescription(application?.description ?? '')
    setIconKey('')
    setCategoryId('')
    setReviewReason('')
    setErrors({})
    setFormError(null)
  }, [open, application])

  function handleSubmit() {
    if (busy) return
    const next: Record<string, string> = {}
    if (mode === 'create_new') {
      if (!code.trim()) next.code = '分类编码不能为空'
      else if (!CATEGORY_CODE_PATTERN.test(code.trim())) next.code = '编码必须以小写字母开头，且只能包含小写字母、数字、- 或 _'
      if (!label.trim()) next.label = '分类名称不能为空'
      else if (label.trim().length > 50) next.label = '分类名称最多 50 字'
      if (description.trim().length > 500) next.description = '分类描述最多 500 字'
      if (iconKey.trim().length > 64) next.iconKey = '分类图标最多 64 字'
    }
    if (mode === 'map_existing' && categoryId === '') next.categoryId = '请选择要映射的分类'
    if (!reviewReason.trim()) next.reviewReason = '审核理由不能为空'
    else if (reviewReason.length > 500) next.reviewReason = '审核理由最多 500 字'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setFormError(null)
    void onSubmit({
      ...(mode === 'create_new' ? { resolution: 'create_new', code: code.trim(), label: label.trim(), description: description.trim() || undefined, iconKey: iconKey.trim() || undefined } : {}),
      ...(mode === 'map_existing' ? { resolution: 'map_existing', categoryId: Number(categoryId) } : {}),
      reviewReason: reviewReason.trim(),
    }).catch(() => {
      /* parent surfaces toast; keep open for correction */
    })
  }

  const title =
    mode === 'create_new' ? '通过并新建分类'
      : mode === 'map_existing' ? '通过并映射现有分类'
        : '拒绝申请'

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          申请名称：{application?.proposedLabel ?? '—'}
          {application?.proposedCode ? `（建议编码 ${application.proposedCode}）` : ''}
        </DialogDescription>

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3 mt-4 text-sm text-[var(--color-text-muted)] max-h-32 overflow-auto">
          {application?.description ?? ''}
        </div>

        <div className="grid gap-4 mt-4">
          {mode === 'create_new' && (
            <>
              <div>
                <label htmlFor="review-code" className="block text-sm font-semibold mb-1">分类编码 *</label>
                <input id="review-code" data-testid="review-code" className="input font-mono" value={code}
                  onChange={(e) => setCode(e.target.value)} disabled={busy} aria-invalid={errors.code ? true : undefined} />
                {errors.code && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.code}</p>}
              </div>
              <div>
                <label htmlFor="review-label" className="block text-sm font-semibold mb-1">分类名称 *</label>
                <input id="review-label" data-testid="review-label" className="input" value={label}
                  onChange={(e) => setLabel(e.target.value)} disabled={busy} aria-invalid={errors.label ? true : undefined} />
                {errors.label && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.label}</p>}
              </div>
              <div>
                <label htmlFor="review-desc" className="block text-sm font-semibold mb-1">分类描述</label>
                <textarea id="review-desc" data-testid="review-description" className="input min-h-[60px] resize-y" value={description}
                  onChange={(e) => setDescription(e.target.value)} disabled={busy} />
                {errors.description && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.description}</p>}
              </div>
              <div>
                <label htmlFor="review-icon" className="block text-sm font-semibold mb-1">分类图标</label>
                <input id="review-icon" data-testid="review-icon" className="input font-mono" value={iconKey}
                  onChange={(e) => setIconKey(e.target.value)} disabled={busy} placeholder="可选" />
                {errors.iconKey && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.iconKey}</p>}
              </div>
            </>
          )}

          {mode === 'map_existing' && (
            <div>
              <label htmlFor="review-category" className="block text-sm font-semibold mb-1">映射到现有分类 *</label>
              <select id="review-category" data-testid="review-category" className="input py-2 cursor-pointer"
                value={categoryId} onChange={(e) => setCategoryId(e.target.value === '' ? '' : Number(e.target.value))}
                disabled={busy} aria-invalid={errors.categoryId ? true : undefined}>
                <option value="">请选择分类</option>
                {activeCategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}（{c.code}）</option>
                ))}
              </select>
              {errors.categoryId && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.categoryId}</p>}
            </div>
          )}

          <div>
            <label htmlFor="review-reason" className="block text-sm font-semibold mb-1">审核理由 *</label>
            <textarea id="review-reason" data-testid="review-reason" className="input min-h-[60px] resize-y" value={reviewReason}
              onChange={(e) => setReviewReason(e.target.value)} disabled={busy} aria-invalid={errors.reviewReason ? true : undefined} />
            {errors.reviewReason && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.reviewReason}</p>}
          </div>

          {formError && (
            <p role="alert" data-testid="review-form-error" className="text-sm text-[var(--color-danger)]">{formError}</p>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button type="button" className="btn-secondary px-4 py-2 text-sm" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            type="button"
            data-testid="review-submit"
            className={mode === 'reject' ? 'btn-secondary px-4 py-2 text-sm border-[var(--color-danger)] text-[var(--color-danger)]' : 'btn-primary px-4 py-2 text-sm min-w-[120px]'}
            disabled={busy}
            onClick={handleSubmit}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : mode === 'reject' ? '确认拒绝' : '确认通过'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
