import { useEffect, useRef, useState } from 'react'
import {
  Book,
  FolderTree,
  Gamepad2,
  Gem,
  Loader2,
  Network,
  Package,
  Sparkles,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import {
  CATEGORY_CODE_PATTERN,
  type CategoryAdminDto,
  type PlatformMediaRef,
} from '../../../types/catalog'
import CategoryCoverField from '../CategoryCoverField'
import type { CategoryFormState } from './types'

/**
 * Best-effort category code generated from a display label (D-UX-17).
 * Non-ASCII labels cannot form a valid code → returns '' so the admin can
 * type one in advanced settings.
 */
function slugifyCategoryCode(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return CATEGORY_CODE_PATTERN.test(slug) ? slug : ''
}

/** Small icon picker for category.iconKey (D-UX-17, §6.3). */
const CATEGORY_ICON_PRESETS = [
  { key: 'network', label: '网络', Icon: Network },
  { key: 'folder-tree', label: '文件夹', Icon: FolderTree },
  { key: 'book', label: '资料', Icon: Book },
  { key: 'gamepad2', label: '游戏', Icon: Gamepad2 },
  { key: 'gem', label: '账号', Icon: Gem },
  { key: 'sparkles', label: '精选', Icon: Sparkles },
  { key: 'package', label: '通用', Icon: Package },
] as const

const EMPTY_CATEGORY_FORM: CategoryFormState = {
  code: '',
  label: '',
  description: '',
  iconKey: '',
  defaultCover: undefined,
  sortOrder: '0',
}

function validateCategoryForm(
  form: CategoryFormState,
  editing: boolean,
): Partial<Record<keyof CategoryFormState, string>> {
  const errors: Partial<Record<keyof CategoryFormState, string>> = {}
  if (!editing) {
    if (!form.code.trim()) errors.code = '分类编码不能为空'
    else if (!CATEGORY_CODE_PATTERN.test(form.code.trim())) {
      errors.code = '编码必须以小写字母开头，且只能包含小写字母、数字、- 或 _'
    }
  }
  if (!form.label.trim()) errors.label = '分类名称不能为空'
  else if (form.label.trim().length > 50) errors.label = '分类名称最多 50 字'
  if (form.description.trim().length > 500) errors.description = '分类描述最多 500 字'
  if (form.iconKey.trim().length > 64) errors.iconKey = '分类图标最多 64 字'
  // D-UX-11: a new (active) category must have a default cover.
  if (!editing && form.defaultCover == null) {
    errors.defaultCover = '请上传分类默认封面'
  }
  if (form.sortOrder.trim() !== '') {
    const n = Number(form.sortOrder)
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) errors.sortOrder = '排序值必须是 0 到 1000000 的整数'
  }
  return errors
}

export default function CategoryFormDialog({
  open,
  onOpenChange,
  mode,
  category,
  busy,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  category: CategoryAdminDto | null
  busy: boolean
  onSubmit: (form: CategoryFormState, editing: boolean) => Promise<void>
}) {
  const editing = mode === 'edit'
  const [form, setForm] = useState<CategoryFormState>(EMPTY_CATEGORY_FORM)
  const [errors, setErrors] = useState<Partial<Record<keyof CategoryFormState, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  // Once the admin edits the code manually, label changes stop auto-filling it.
  const codeTouchedRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setFormError(null)
    setErrors({})
    if (category) {
      setForm({
        code: category.code,
        label: category.label,
        description: category.description ?? '',
        iconKey: category.iconKey ?? '',
        // Edit mode starts with an untouched cover; the field previews the
        // existing canonical URL until the admin uploads/removes a cover.
        defaultCover: undefined,
        sortOrder: String(category.sortOrder ?? 0),
      })
    } else {
      setForm(EMPTY_CATEGORY_FORM)
    }
  }, [open, category])

  function handleSubmit() {
    if (busy) return
    const next = validateCategoryForm(form, editing)
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setFormError(null)
    void onSubmit(form, editing).catch(() => {
      /* the parent surfaces the toast; keep the dialog open for corrections */
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{editing ? '编辑分类' : '新建分类'}</DialogTitle>
        <DialogDescription>
          {editing
            ? '修改展示信息；编码创建后不可修改。'
            : '编码创建后不可修改且不可复用；分类仅用于展示与检索，不改变交付方式。'}
        </DialogDescription>

        <div className="grid gap-4 mt-4">
          <div>
            <label htmlFor="cat-form-label" className="block text-sm font-semibold mb-1">
              分类名称 *
            </label>
            <input
              id="cat-form-label"
              data-testid="category-form-label"
              className="input"
              value={form.label}
              onChange={(e) => {
                const nextLabel = e.target.value
                setForm((f) => {
                  const next = { ...f, label: nextLabel }
                  // D-UX-17: the code defaults from the name until edited manually.
                  if (!editing && !codeTouchedRef.current) next.code = slugifyCategoryCode(nextLabel)
                  return next
                })
              }}
              disabled={busy}
              aria-invalid={errors.label ? true : undefined}
            />
            {errors.label && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.label}</p>}
          </div>

          <div>
            <label htmlFor="cat-form-desc" className="block text-sm font-semibold mb-1">
              分类描述
            </label>
            <textarea
              id="cat-form-desc"
              data-testid="category-form-description"
              className="input min-h-[80px] resize-y"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              disabled={busy}
            />
            {errors.description && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.description}</p>}
          </div>

          <div>
            <label htmlFor="cat-form-sort" className="block text-sm font-semibold mb-1">
              展示顺序
              <span className="text-[11px] font-normal text-[var(--color-text-muted)] ml-1">（数字越小越靠前；同值按分类编号排序）</span>
            </label>
            <input
              id="cat-form-sort"
              aria-label="排序值"
              data-testid="category-form-sort"
              className="input"
              type="number"
              min={0}
              max={1_000_000}
              value={form.sortOrder}
              onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
              disabled={busy}
            />
            {errors.sortOrder && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.sortOrder}</p>}
          </div>

          <div>
            <CategoryCoverField
              existingUrl={category?.defaultCoverUrl ?? null}
              value={form.defaultCover}
              onChange={(ref) => setForm((f) => ({ ...f, defaultCover: ref }))}
              disabled={busy}
              required={!editing}
              error={errors.defaultCover ?? null}
              testId="category-form-cover"
            />
          </div>

          {/* D-UX-17 / §6.3: code & icon live in advanced settings; code is
              auto-derived from the name until edited manually. */}
          <details
            className="rounded-lg border border-[var(--color-border)] p-3"
            data-testid="category-advanced-settings"
          >
            <summary className="cursor-pointer text-sm font-semibold text-[var(--color-text)]">
              高级设置（分类编码 / 图标）
            </summary>
            <div className="mt-3 grid gap-4">
              <div>
                <label htmlFor="cat-form-code" className="block text-sm font-semibold mb-1">
                  分类编码 {editing ? '' : '*'}
                </label>
                <input
                  id="cat-form-code"
                  data-testid="category-form-code"
                  className="input font-mono"
                  value={form.code}
                  onChange={(e) => { codeTouchedRef.current = true; setForm((f) => ({ ...f, code: e.target.value })) }}
                  placeholder="如 network-node"
                  disabled={editing || busy}
                  aria-invalid={errors.code ? true : undefined}
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  创建后不可修改；留空时默认从名称生成。
                </p>
                {errors.code && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.code}</p>}
              </div>
              <div>
                <span className="block text-sm font-semibold mb-1">分类图标</span>
                <div className="flex flex-wrap gap-2">
                  {CATEGORY_ICON_PRESETS.map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={form.iconKey === key}
                      data-testid={`category-icon-${key}`}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs ${
                        form.iconKey === key
                          ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[var(--color-primary)]/10'
                          : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-primary)]/40'
                      }`}
                      onClick={() => setForm((f) => ({ ...f, iconKey: key }))}
                      disabled={busy}
                    >
                      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                      {label}
                    </button>
                  ))}
                </div>
                {form.iconKey && !CATEGORY_ICON_PRESETS.some(p => p.key === form.iconKey) && (
                  <p className="text-xs text-[var(--color-text-muted)] mt-1 font-mono">
                    图标键：{form.iconKey}
                  </p>
                )}
                {errors.iconKey && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.iconKey}</p>}
              </div>
            </div>
          </details>

          {formError && (
            <p role="alert" data-testid="category-form-error" className="text-sm text-[var(--color-danger)]">
              {formError}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button type="button" className="btn-secondary px-4 py-2 text-sm" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            type="button"
            data-testid="category-form-submit"
            className="btn-primary px-4 py-2 text-sm min-w-[120px]"
            disabled={busy}
            onClick={handleSubmit}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : editing ? '保存修改' : '创建分类'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
