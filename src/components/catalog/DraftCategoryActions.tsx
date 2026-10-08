import { useEffect, useId, useRef, useState } from 'react'
import { catalogApi } from '../../api/catalog'
import { catalogGovernanceApi, getCatalogGovernanceErrorMessage } from '../../api/catalogGovernance'
import { captureFeedbackOwner } from '../../lib/completionFeedback'
import type { CategoryRegistryItem } from '../../types/catalog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import CategoryFormDialog from './categoryManager/CategoryFormDialog'
import type { CategoryFormState } from './categoryManager/types'

/** Human category actions use the existing governance APIs, never the model. */
export default function DraftCategoryActions({ actor, categories, onCategoriesChange, onSelect, onBusyChange, disabled, exampleProduct }: {
  actor: 'admin' | 'merchant'
  categories: CategoryRegistryItem[]
  onCategoriesChange: (items: CategoryRegistryItem[]) => void
  onSelect: (id: number) => void
  onBusyChange: (busy: boolean) => void
  disabled: boolean
  exampleProduct?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function run(action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    onBusyChange(true)
    setError('')
    try { await action() }
    finally {
      lock.current = false
      if (mounted.current) { setBusy(false); onBusyChange(false) }
    }
  }

  async function createCategory(form: CategoryFormState) {
    const ownsFeedback = captureFeedbackOwner()
    const current = () => mounted.current && ownsFeedback()
    await run(async () => {
      try {
        const category = await catalogGovernanceApi.createCategory({
          code: form.code.trim(), label: form.label.trim(), description: form.description.trim() || undefined,
          iconKey: form.iconKey.trim() || undefined, defaultCover: form.defaultCover,
          sortOrder: Number(form.sortOrder || 0),
        })
        if (!current()) return
        // Use the successful write result immediately: a failed list refresh
        // must not encourage retrying an already-created category.
        onCategoriesChange([...categories.filter(item => item.id !== category.id), {
          id: category.id, code: category.code, label: category.label, iconKey: category.iconKey, sortOrder: category.sortOrder,
        }].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id))
        onSelect(category.id)
        setOpen(false)
        setMessage(`已创建并选中「${category.label}」，商品内容已保留。`)
      } catch (err) {
        if (current()) setError(getCatalogGovernanceErrorMessage(err, '创建分类失败，请修改后重试'))
        throw err
      }
    })
  }

  async function applyCategory() {
    if (!label.trim() || label.trim().length > 50 || description.trim().length < 20 || description.trim().length > 1000) {
      setError('请填写分类名称（最多 50 字）和分类描述（20–1000 字）')
      return
    }
    const ownsFeedback = captureFeedbackOwner()
    await run(async () => {
      try {
        await catalogGovernanceApi.createApplication({ proposedLabel: label.trim(), description: description.trim(), exampleProducts: exampleProduct?.slice(0, 1000) || undefined })
        if (!mounted.current || !ownsFeedback()) return
        setOpen(false)
        setLabel('')
        setDescription('')
        setMessage('申请已提交，等待平台审核。审核通过后点击「刷新分类」选择；当前页面的商品内容会保留。')
      } catch (err) {
        if (mounted.current && ownsFeedback()) setError(getCatalogGovernanceErrorMessage(err, '提交申请失败'))
      }
    })
  }

  async function refresh() {
    const ownsFeedback = captureFeedbackOwner()
    await run(async () => {
      try {
        const items = await catalogApi.listActiveCategories()
        if (!mounted.current || !ownsFeedback()) return
        onCategoriesChange(items)
        setMessage('分类列表已更新，请选择合适的分类。')
      } catch (err) {
        if (mounted.current && ownsFeedback()) setError(getCatalogGovernanceErrorMessage(err, '刷新分类失败'))
      }
    })
  }

  return <div className="mt-2 space-y-2">
    <div className="flex flex-wrap gap-3">
      <button type="button" className="min-h-9 text-sm text-[var(--color-primary)] underline underline-offset-4" disabled={disabled || busy}
        onClick={() => { setError(''); setOpen(true) }}>{actor === 'admin' ? '没有合适的分类？新建分类' : '没有合适的分类？申请新分类'}</button>
      <button type="button" className="min-h-9 text-sm text-[var(--color-text-muted)] underline underline-offset-4" disabled={disabled || busy} onClick={() => void refresh()}>刷新分类</button>
    </div>
    {message && <p role="status" className="text-xs leading-relaxed text-[var(--color-text-muted)]">{message}</p>}
    {error && !open && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
    {actor === 'admin' ? <CategoryFormDialog open={open} onOpenChange={setOpen} mode="create" category={null} busy={busy} onSubmit={createCategory} submitError={error} />
      : <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>申请新分类</DialogTitle>
          <DialogDescription>分类需由平台审核后才能用于商品。提交申请不会创建商品或清空当前内容；保存草稿仍需选择已启用的分类。</DialogDescription>
          <div className="mt-4 space-y-4">
            <div><label htmlFor={`${id}-label`} className="mb-1 block text-sm font-semibold">分类名称 *</label>
              <input id={`${id}-label`} className="input" maxLength={50} value={label} disabled={busy} onChange={event => setLabel(event.target.value)} /></div>
            <div><label htmlFor={`${id}-description`} className="mb-1 block text-sm font-semibold">分类描述（至少 20 字）*</label>
              <textarea id={`${id}-description`} className="input min-h-28" maxLength={1000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></div>
            {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
            <div className="flex justify-end gap-3"><button type="button" className="btn-secondary" disabled={busy} onClick={() => setOpen(false)}>取消</button>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void applyCategory()}>{busy ? '提交中…' : '提交申请'}</button></div>
          </div>
        </DialogContent>
      </Dialog>}
  </div>
}
