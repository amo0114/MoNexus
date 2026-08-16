/**
 * AdminCategoryManager (T-CAT-FE-003) — admin category governance panel.
 *
 * Two sections (SPEC-CATALOG-OPS-001 §7.2/§7.3):
 *   1. Category repository: list (status filter + pagination), create/edit,
 *      activate/deactivate (CAS), transactional reorder, logical delete
 *      (tombstone — refused with CATEGORY_REFERENCED while referenced,
 *      D-CAT-07/AC-CAT-011). Inactive rows keep a historical label and remain
 *      readable (D-CAT-22 / CHK-CAT-011).
 *   2. Category applications: admin list + review with create_new /
 *      map_existing / reject (D-CAT-10/D-CAT-11). Concurrent or post-withdraw
 *      review surfaces the stable CATEGORY_APPLICATION_ALREADY_REVIEWED code
 *      and refreshes the list (AC-CAT-013).
 *
 * Contract/UX guarantees:
 *   - every mutation is guarded by a single busy flag (double-submit disabled,
 *     CHK-UI-005) and keyed off stable error codes (never prose);
 *   - pagination + filter state is preserved across mutations (a removal on
 *     the last row of the last page clamps back one page);
 *   - no internal fields are rendered (normalizedLabel/reviewedByUserId are
 *     not part of the DTO allowlist — REQ-CAT-NF-005);
 *   - no notification is emitted anywhere on this flow (D-CAT-24).
 *
 * Host wiring is deferred (T-CAT-INT-001) — this panel is self-contained and
 * takes an injectable adapter so it can be mounted by the CMI Integration
 * Owner later.
 */
import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FolderTree,
  Inbox,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import ConfirmDialog from '../ui/ConfirmDialog'
import AdminPagination from '../admin/AdminPagination'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'
import { useAppStore } from '../../stores/appStore'
import {
  catalogGovernanceApi,
  getCatalogGovernanceErrorMessage,
  isCategoryApplicationAlreadyReviewed,
  type CatalogGovernanceAdapter,
} from '../../api/catalogGovernance'
import { getApiErrorMessage } from '../../api/error'
import {
  CATEGORY_APPLICATION_RESOLUTION_LABEL,
  CATEGORY_APPLICATION_STATUS_LABEL,
  CATEGORY_STATUS_LABEL,
} from '../../types/catalogGovernance'
import {
  CATEGORY_APPLICATION_STATUS,
  CATEGORY_CODE_PATTERN,
  CATEGORY_STATUS,
  type CategoryAdminDto,
  type CategoryApplicationDto,
  type CategoryApplicationStatus,
  type CategoryStatus,
  type PlatformMediaRef,
} from '../../types/catalog'
import CategoryCoverField from './CategoryCoverField'

const PAGE_SIZE = 10
const MAX_REORDER_IDS = 500

/* ------------------------------------------------------------------ *
 * Small display helpers
 * ------------------------------------------------------------------ */

function CategoryStatusBadge({ status }: { status: CategoryStatus }) {
  const active = status === CATEGORY_STATUS.ACTIVE
  return (
    <span
      data-testid={`category-status-${status}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
        active
          ? 'bg-[var(--color-success)]/10 text-[var(--color-success)]'
          : 'bg-[var(--color-muted)]/20 text-[var(--color-text-muted)]'
      }`}
    >
      {active ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {CATEGORY_STATUS_LABEL[status]}
    </span>
  )
}

function ApplicationStatusBadge({ status }: { status: CategoryApplicationStatus }) {
  const tone =
    status === CATEGORY_APPLICATION_STATUS.PENDING
      ? 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]'
      : status === CATEGORY_APPLICATION_STATUS.APPROVED
        ? 'bg-[var(--color-success)]/10 text-[var(--color-success)]'
        : 'bg-[var(--color-muted)]/20 text-[var(--color-text-muted)]'
  return (
    <span data-testid={`application-status-${status}`} className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {CATEGORY_APPLICATION_STATUS_LABEL[status]}
    </span>
  )
}

/** Generic filter select with a labelled testid (keyboard/AT friendly). */
function FilterSelect<T extends string>({
  id,
  value,
  onChange,
  options,
  label,
  testId,
}: {
  id: string
  value: T | ''
  onChange: (value: T | '') => void
  options: Array<{ value: T; label: string }>
  label: string
  testId: string
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-[var(--color-text-muted)] whitespace-nowrap">
        {label}
      </label>
      <select
        id={id}
        data-testid={testId}
        className="input py-2 pr-8 cursor-pointer"
        value={value}
        onChange={(e) => onChange(e.target.value as T | '')}
      >
        <option value="">全部</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Category create / edit dialog
 * ------------------------------------------------------------------ */

interface CategoryFormState {
  code: string
  label: string
  description: string
  iconKey: string
  /** Form-draft cover ref; undefined = untouched (edit keeps existing). */
  defaultCover: PlatformMediaRef | null | undefined
  sortOrder: string
}

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

function CategoryFormDialog({
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
            <label htmlFor="cat-form-code" className="block text-sm font-semibold mb-1">
              分类编码 {editing ? '' : '*'}
            </label>
            <input
              id="cat-form-code"
              data-testid="category-form-code"
              className="input font-mono"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              placeholder="如 network-node"
              disabled={editing || busy}
              aria-invalid={errors.code ? true : undefined}
            />
            {editing && (
              <p className="text-xs text-[var(--color-text-muted)] mt-1">编码创建后不可修改（D-CAT-06）。</p>
            )}
            {errors.code && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.code}</p>}
          </div>

          <div>
            <label htmlFor="cat-form-label" className="block text-sm font-semibold mb-1">
              分类名称 *
            </label>
            <input
              id="cat-form-label"
              data-testid="category-form-label"
              className="input"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cat-form-icon" className="block text-sm font-semibold mb-1">
                分类图标
              </label>
              <input
                id="cat-form-icon"
                data-testid="category-form-icon"
                className="input font-mono"
                value={form.iconKey}
                onChange={(e) => setForm((f) => ({ ...f, iconKey: e.target.value }))}
                placeholder="如 network"
                disabled={busy}
              />
              {errors.iconKey && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{errors.iconKey}</p>}
            </div>
            <div>
              <label htmlFor="cat-form-sort" className="block text-sm font-semibold mb-1">
                排序值
              </label>
              <input
                id="cat-form-sort"
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

/* ------------------------------------------------------------------ *
 * Application review dialog (create_new / map_existing / reject)
 * ------------------------------------------------------------------ */

type ReviewMode = 'create_new' | 'map_existing' | 'reject'

function ReviewDialog({
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

/* ------------------------------------------------------------------ *
 * Main panel
 * ------------------------------------------------------------------ */

export interface AdminCategoryManagerProps {
  /** Injectable governance adapter (production default = shared client). */
  adapter?: CatalogGovernanceAdapter
}

export default function AdminCategoryManager({ adapter = catalogGovernanceApi }: AdminCategoryManagerProps) {
  const showToast = useAppStore((s) => s.showToast)

  /* ---- category repository list state ---- */
  const [catItems, setCatItems] = useState<CategoryAdminDto[]>([])
  const [catTotal, setCatTotal] = useState(0)
  const [catPage, setCatPage] = useState(1)
  const [catStatus, setCatStatus] = useState<CategoryStatus | ''>('')
  const [catLoading, setCatLoading] = useState(true)
  const [catError, setCatError] = useState<string | null>(null)
  const [catReload, setCatReload] = useState(0)

  /* ---- application review list state ---- */
  const [appItems, setAppItems] = useState<CategoryApplicationDto[]>([])
  const [appTotal, setAppTotal] = useState(0)
  const [appPage, setAppPage] = useState(1)
  const [appStatus, setAppStatus] = useState<CategoryApplicationStatus | ''>(CATEGORY_APPLICATION_STATUS.PENDING)
  const [appLoading, setAppLoading] = useState(true)
  const [appReload, setAppReload] = useState(0)

  /* ---- dialogs / forms ---- */
  const [categoryForm, setCategoryForm] = useState<{ open: boolean; mode: 'create' | 'edit'; category: CategoryAdminDto | null }>({
    open: false, mode: 'create', category: null,
  })
  const [review, setReview] = useState<{ open: boolean; mode: ReviewMode; application: CategoryApplicationDto | null }>({
    open: false, mode: 'reject', application: null,
  })
  const [activeCategories, setActiveCategories] = useState<CategoryAdminDto[]>([])
  const [confirmTarget, setConfirmTarget] = useState<{ category: CategoryAdminDto; kind: 'deactivate' | 'delete' } | null>(null)

  /* ---- reorder mode ---- */
  const [reorderActive, setReorderActive] = useState(false)
  const [reorderRows, setReorderRows] = useState<CategoryAdminDto[]>([])
  const [reorderLoading, setReorderLoading] = useState(false)

  /** Single busy flag — double-submit disabled for every mutation (CHK-UI-005). */
  const [busy, setBusy] = useState<string | null>(null)

  /* ------------------------------------------------------------------ *
   * Data loading (pagination + filter retained across mutations)
   * ------------------------------------------------------------------ */

  useEffect(() => {
    let cancelled = false
    setCatLoading(true)
    setCatError(null)
    adapter
      .listCategories({ status: catStatus || undefined, page: catPage, pageSize: PAGE_SIZE })
      .then((data) => {
        if (cancelled) return
        setCatItems(data.items)
        setCatTotal(data.total)
        // Removal on the last row of the last page clamps back one page.
        if (data.items.length === 0 && data.page > 1) {
          setCatPage((p) => Math.max(1, p - 1))
          return
        }
        setCatLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setCatError(getApiErrorMessage(err, '加载分类列表失败'))
        setCatLoading(false)
      })
    return () => { cancelled = true }
  }, [adapter, catStatus, catPage, catReload])

  useEffect(() => {
    let cancelled = false
    setAppLoading(true)
    adapter
      .listAdminApplications({ status: appStatus || undefined, page: appPage, pageSize: PAGE_SIZE })
      .then((data) => {
        if (cancelled) return
        setAppItems(data.items)
        setAppTotal(data.total)
        if (data.items.length === 0 && data.page > 1) {
          setAppPage((p) => Math.max(1, p - 1))
          return
        }
        setAppLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        showToast(getApiErrorMessage(err, '加载申请列表失败'), 'error')
        setAppLoading(false)
      })
    return () => { cancelled = true }
  }, [adapter, appStatus, appPage, appReload, showToast])

  /* Load active categories once for the map_existing selector. */
  useEffect(() => {
    let cancelled = false
    adapter
      .listCategories({ status: CATEGORY_STATUS.ACTIVE, page: 1, pageSize: 100 })
      .then((data) => { if (!cancelled) setActiveCategories(data.items) })
      .catch(() => { /* the review submit will surface a real error if needed */ })
    return () => { cancelled = true }
  }, [adapter])

  function refreshCategories() {
    setCatReload((x) => x + 1)
  }
  function refreshApplications() {
    setAppReload((x) => x + 1)
  }

  /* ------------------------------------------------------------------ *
   * Mutations
   * ------------------------------------------------------------------ */

  async function handleCategorySubmit(form: CategoryFormState, editing: boolean) {
    if (busy) return
    const key = editing ? `update-${categoryForm.category?.id}` : 'create'
    setBusy(key)
    try {
      if (editing && categoryForm.category) {
        const payload = {
          label: form.label.trim(),
          description: form.description.trim() || null,
          iconKey: form.iconKey.trim() || null,
          ...(form.defaultCover !== undefined
            ? { defaultCover: form.defaultCover }
            : {}),
          sortOrder: form.sortOrder.trim() === '' ? 0 : Number(form.sortOrder),
        }
        await adapter.updateCategory(categoryForm.category.id, payload)
        showToast('分类已更新')
      } else {
        await adapter.createCategory({
          code: form.code.trim(),
          label: form.label.trim(),
          description: form.description.trim() || undefined,
          iconKey: form.iconKey.trim() || undefined,
          ...(form.defaultCover !== undefined && form.defaultCover !== null
            ? { defaultCover: form.defaultCover }
            : {}),
          sortOrder: form.sortOrder.trim() === '' ? 0 : Number(form.sortOrder),
        })
        showToast('分类已创建')
      }
      setCategoryForm({ open: false, mode: 'create', category: null })
      refreshCategories()
    } catch (err: unknown) {
      showToast(getCatalogGovernanceErrorMessage(err, editing ? '更新分类失败' : '创建分类失败'), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function handleDeactivate(category: CategoryAdminDto) {
    if (busy) return
    setBusy(`deactivate-${category.id}`)
    try {
      await adapter.deactivateCategory(category.id)
      showToast('分类已停用；历史商品仍可读取')
      setConfirmTarget(null)
      refreshCategories()
    } catch (err: unknown) {
      showToast(getCatalogGovernanceErrorMessage(err, '停用分类失败'), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function handleActivate(category: CategoryAdminDto) {
    if (busy) return
    setBusy(`activate-${category.id}`)
    try {
      await adapter.activateCategory(category.id)
      showToast('分类已启用')
      refreshCategories()
    } catch (err: unknown) {
      showToast(getCatalogGovernanceErrorMessage(err, '启用分类失败'), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(category: CategoryAdminDto) {
    if (busy) return
    setBusy(`delete-${category.id}`)
    try {
      await adapter.deleteCategory(category.id)
      showToast('分类已删除（保留记录，编码不再复用）')
      setConfirmTarget(null)
      refreshCategories()
    } catch (err: unknown) {
      // CATEGORY_REFERENCED (and any other stable code) shown as-is; list unchanged.
      showToast(getCatalogGovernanceErrorMessage(err, '删除分类失败'), 'error')
      setConfirmTarget(null)
      refreshCategories()
    } finally {
      setBusy(null)
    }
  }

  /** Enter reorder mode: load ALL categories (no filter) so a saved order is global. */
  async function enterReorder() {
    if (busy) return
    setReorderLoading(true)
    try {
      const rows: CategoryAdminDto[] = []
      const pageSize = 100
      for (let page = 1; page <= Math.ceil(MAX_REORDER_IDS / pageSize) + 1; page++) {
        const data = await adapter.listCategories({ page, pageSize })
        rows.push(...data.items)
        if (rows.length >= data.total || data.total === 0) break
      }
      if (rows.length > MAX_REORDER_IDS) {
        showToast(`分类过多（${rows.length}），一次最多调整 ${MAX_REORDER_IDS} 个`, 'error')
        return
      }
      setReorderRows(rows)
      setReorderActive(true)
    } catch (err: unknown) {
      showToast(getApiErrorMessage(err, '加载全部分类失败'), 'error')
    } finally {
      setReorderLoading(false)
    }
  }

  function moveReorder(index: number, delta: -1 | 1) {
    setReorderRows((rows) => {
      const target = index + delta
      if (target < 0 || target >= rows.length) return rows
      const next = [...rows]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function saveReorder() {
    if (busy) return
    if (reorderRows.length === 0) {
      showToast('没有可排序的分类', 'error')
      return
    }
    setBusy('reorder')
    try {
      const orderedIds = reorderRows.map((r) => r.id)
      const result = await adapter.reorderCategories(orderedIds)
      showToast(`已保存排序（${result.updated} 个分类）`)
      setReorderActive(false)
      refreshCategories()
    } catch (err: unknown) {
      showToast(getCatalogGovernanceErrorMessage(err, '保存排序失败'), 'error')
    } finally {
      setBusy(null)
    }
  }

  /* ---- Application review actions ---- */

  async function handleReviewSubmit(payload: {
    resolution?: 'create_new' | 'map_existing'
    code?: string
    label?: string
    description?: string
    iconKey?: string
    categoryId?: number
    reviewReason: string
  }) {
    if (busy || !review.application) return
    const key = `review-${review.application.id}`
    setBusy(key)
    try {
      if (payload.resolution) {
        if (payload.resolution === 'create_new') {
          await adapter.approveApplication(review.application.id, {
            resolution: 'create_new',
            category: {
              code: payload.code as string,
              label: payload.label as string,
              description: payload.description,
              iconKey: payload.iconKey,
            },
            reviewReason: payload.reviewReason,
          })
        } else {
          await adapter.approveApplication(review.application.id, {
            resolution: 'map_existing',
            categoryId: payload.categoryId as number,
            reviewReason: payload.reviewReason,
          })
        }
        showToast(payload.resolution === 'create_new' ? '已通过并新建分类' : '已通过并映射到现有分类')
      } else {
        await adapter.rejectApplication(review.application.id, { reviewReason: payload.reviewReason })
        showToast('已拒绝该申请')
      }
      setReview({ open: false, mode: 'reject', application: null })
      refreshApplications()
      refreshCategories() // create_new may add a category to the repository list
    } catch (err: unknown) {
      if (isCategoryApplicationAlreadyReviewed(err)) {
        showToast('该申请已被审核或已撤回，无法重复操作', 'error')
        setReview({ open: false, mode: 'reject', application: null })
        refreshApplications()
      } else {
        showToast(getCatalogGovernanceErrorMessage(err, '审核操作失败'), 'error')
      }
    } finally {
      setBusy(null)
    }
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */



  return (
    <div className="space-y-8" data-testid="admin-category-manager">
      {/* ─────────── Category repository ─────────── */}
      <section aria-labelledby="admin-category-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <FolderTree className="w-5 h-5 text-[var(--color-primary)]" />
            <h2 id="admin-category-heading" className="font-heading text-lg font-semibold text-[var(--color-text)]">
              分类管理
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <FilterSelect<CategoryStatus>
              id="admin-cat-filter"
              value={catStatus}
              onChange={(v) => { setCatStatus(v); setCatPage(1) }}
              options={[
                { value: CATEGORY_STATUS.ACTIVE, label: CATEGORY_STATUS_LABEL[CATEGORY_STATUS.ACTIVE] },
                { value: CATEGORY_STATUS.INACTIVE, label: CATEGORY_STATUS_LABEL[CATEGORY_STATUS.INACTIVE] },
              ]}
              label="状态筛选"
              testId="admin-category-status-filter"
            />
            {reorderActive ? (
              <>
                <button type="button" className="btn-primary px-4 py-2 text-sm" data-testid="reorder-save" disabled={busy !== null} onClick={() => void saveReorder()}>
                  {busy === 'reorder' ? <Loader2 className="w-4 h-4 animate-spin" /> : '保存排序'}
                </button>
                <button type="button" className="btn-secondary px-4 py-2 text-sm" disabled={busy !== null} onClick={() => setReorderActive(false)}>
                  取消排序
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn-secondary px-4 py-2 text-sm" data-testid="reorder-enter" disabled={busy !== null || reorderLoading} onClick={() => void enterReorder()}>
                  {reorderLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : '调整排序'}
                </button>
                <button
                  type="button"
                  className="btn-primary px-4 py-2 text-sm"
                  data-testid="admin-category-create"
                  disabled={busy !== null}
                  onClick={() => setCategoryForm({ open: true, mode: 'create', category: null })}
                >
                  <Plus className="w-4 h-4 inline-block mr-1" />
                  新建分类
                </button>
              </>
            )}
          </div>
        </div>

        {catError && (
          <p role="alert" data-testid="admin-category-error" className="text-sm text-[var(--color-danger)] mb-3">{catError}</p>
        )}

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] overflow-hidden">
          {reorderActive ? (
            <ReorderList
              rows={reorderRows}
              busy={busy !== null}
              onMove={moveReorder}
            />
          ) : catLoading ? (
            <div className="p-4"><TableSkeleton rows={5} /></div>
          ) : catItems.length === 0 ? (
            <EmptyState icon={FolderTree} title="暂无分类" description="点击右上角「新建分类」创建第一个分类。" compact />
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">编码</th>
                  <th scope="col">名称</th>
                  <th scope="col">状态</th>
                  <th scope="col">排序</th>
                  <th scope="col" className="w-56">操作</th>
                </tr>
              </thead>
              <tbody>
                {catItems.map((c) => (
                  <tr key={c.id} data-testid={`category-row-${c.id}`} data-status={c.status}>
                    <td className="font-mono text-sm">{c.code}</td>
                    <td>
                      <div className="font-semibold text-[var(--color-text)] flex items-center gap-2">
                        {c.label}
                        {c.status === CATEGORY_STATUS.INACTIVE && (
                          <span className="text-xs text-[var(--color-text-muted)]" data-testid="inactive-historical-label">
                            历史分类（已发布商品仍显示，不可用于新商品首次发布）
                          </span>
                        )}
                      </div>
                      {c.description && <div className="text-xs text-[var(--color-text-muted)] mt-0.5 line-clamp-1">{c.description}</div>}
                    </td>
                    <td><CategoryStatusBadge status={c.status} /></td>
                    <td className="text-sm text-[var(--color-text-muted)]">{c.sortOrder}</td>
                    <td>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          type="button"
                          className="icon-btn p-1.5 rounded-md hover:bg-[var(--color-border)] cursor-pointer"
                          aria-label={`编辑分类 ${c.label}`}
                          data-testid={`category-edit-${c.id}`}
                          disabled={busy !== null}
                          onClick={() => setCategoryForm({ open: true, mode: 'edit', category: c })}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {c.status === CATEGORY_STATUS.ACTIVE ? (
                          <button
                            type="button"
                            className="icon-btn p-1.5 rounded-md hover:bg-[var(--color-border)] cursor-pointer"
                            aria-label={`停用分类 ${c.label}`}
                            data-testid={`category-deactivate-${c.id}`}
                            disabled={busy !== null}
                            onClick={() => setConfirmTarget({ category: c, kind: 'deactivate' })}
                          >
                            <ChevronDown className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="icon-btn p-1.5 rounded-md hover:bg-[var(--color-border)] cursor-pointer"
                            aria-label={`启用分类 ${c.label}`}
                            data-testid={`category-activate-${c.id}`}
                            disabled={busy !== null}
                            onClick={() => void handleActivate(c)}
                          >
                            <ChevronUp className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn p-1.5 rounded-md hover:bg-[var(--color-danger)]/10 text-[var(--color-danger)] cursor-pointer"
                          aria-label={`删除分类 ${c.label}`}
                          data-testid={`category-delete-${c.id}`}
                          disabled={busy !== null}
                          onClick={() => setConfirmTarget({ category: c, kind: 'delete' })}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!reorderActive && (
          <AdminPagination
            page={catPage}
            total={catTotal}
            pageSize={PAGE_SIZE}
            onPageChange={setCatPage}
            testId="admin-category-pagination"
          />
        )}
      </section>

      {/* ─────────── Application review ─────────── */}
      <section aria-labelledby="admin-application-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Inbox className="w-5 h-5 text-[var(--color-primary)]" />
            <h2 id="admin-application-heading" className="font-heading text-lg font-semibold text-[var(--color-text)]">
              分类申请审核
            </h2>
          </div>
          <FilterSelect<CategoryApplicationStatus>
            id="admin-app-filter"
            value={appStatus}
            onChange={(v) => { setAppStatus(v); setAppPage(1) }}
            options={[
              { value: CATEGORY_APPLICATION_STATUS.PENDING, label: CATEGORY_APPLICATION_STATUS_LABEL[CATEGORY_APPLICATION_STATUS.PENDING] },
              { value: CATEGORY_APPLICATION_STATUS.APPROVED, label: CATEGORY_APPLICATION_STATUS_LABEL[CATEGORY_APPLICATION_STATUS.APPROVED] },
              { value: CATEGORY_APPLICATION_STATUS.REJECTED, label: CATEGORY_APPLICATION_STATUS_LABEL[CATEGORY_APPLICATION_STATUS.REJECTED] },
              { value: CATEGORY_APPLICATION_STATUS.WITHDRAWN, label: CATEGORY_APPLICATION_STATUS_LABEL[CATEGORY_APPLICATION_STATUS.WITHDRAWN] },
            ]}
            label="状态筛选"
            testId="admin-application-status-filter"
          />
        </div>

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] overflow-hidden">
          {appLoading ? (
            <div className="p-4"><TableSkeleton rows={5} /></div>
          ) : appItems.length === 0 ? (
            <EmptyState icon={Inbox} title="暂无申请" description="当前筛选条件下没有分类申请。" compact />
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">申请名称</th>
                  <th scope="col">状态</th>
                  <th scope="col">审核结果</th>
                  <th scope="col" className="w-64">操作</th>
                </tr>
              </thead>
              <tbody>
                {appItems.map((a) => (
                  <tr key={a.id} data-testid={`application-row-${a.id}`} data-status={a.status}>
                    <td>
                      <div className="font-semibold text-[var(--color-text)] flex items-center gap-2">
                        {a.proposedLabel}
                        {a.proposedCode && <span className="font-mono text-xs text-[var(--color-text-muted)]">（{a.proposedCode}）</span>}
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)] mt-0.5 line-clamp-2">{a.description}</div>
                    </td>
                    <td><ApplicationStatusBadge status={a.status} /></td>
                    <td>
                      {a.status === CATEGORY_APPLICATION_STATUS.PENDING ? (
                        <span className="text-sm text-[var(--color-text-muted)]">待处理</span>
                      ) : (
                        <div className="text-xs text-[var(--color-text-muted)]">
                          {a.resolution && (
                            <span data-testid={`application-resolution-${a.id}`}>
                              {CATEGORY_APPLICATION_RESOLUTION_LABEL[a.resolution]}
                              {a.approvedCategoryId != null ? ` → #${a.approvedCategoryId}` : ''}
                            </span>
                          )}
                          {a.reviewReason && <div className="mt-0.5 line-clamp-2">{a.reviewReason}</div>}
                        </div>
                      )}
                    </td>
                    <td>
                      {a.status === CATEGORY_APPLICATION_STATUS.PENDING ? (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            data-testid={`application-approve-new-${a.id}`}
                            disabled={busy !== null}
                            onClick={() => setReview({ open: true, mode: 'create_new', application: a })}
                          >
                            通过（新建）
                          </button>
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            data-testid={`application-approve-map-${a.id}`}
                            disabled={busy !== null}
                            onClick={() => setReview({ open: true, mode: 'map_existing', application: a })}
                          >
                            通过（映射）
                          </button>
                          <button
                            type="button"
                            className="btn-secondary btn-sm border-[var(--color-danger)] text-[var(--color-danger)]"
                            data-testid={`application-reject-${a.id}`}
                            disabled={busy !== null}
                            onClick={() => setReview({ open: true, mode: 'reject', application: a })}
                          >
                            拒绝
                          </button>
                        </div>
                      ) : (
                        <span className="text-sm text-[var(--color-text-muted)]">已处理</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <AdminPagination
          page={appPage}
          total={appTotal}
          pageSize={PAGE_SIZE}
          onPageChange={setAppPage}
          testId="admin-application-pagination"
        />
      </section>

      {/* ─────────── Dialogs ─────────── */}
      <CategoryFormDialog
        open={categoryForm.open}
        onOpenChange={(o) => { if (!busy) setCategoryForm((f) => ({ ...f, open: o })) }}
        mode={categoryForm.mode}
        category={categoryForm.category}
        busy={busy === `update-${categoryForm.category?.id}` || busy === 'create'}
        onSubmit={handleCategorySubmit}
      />

      <ReviewDialog
        open={review.open}
        onOpenChange={(o) => { if (!busy) setReview((r) => ({ ...r, open: o })) }}
        mode={review.mode}
        application={review.application}
        activeCategories={activeCategories}
        busy={busy === `review-${review.application?.id}`}
        onSubmit={handleReviewSubmit}
      />

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(o) => { if (!busy) setConfirmTarget(o && confirmTarget ? confirmTarget : null) }}
        title={confirmTarget?.kind === 'delete' ? '删除分类' : '停用分类'}
        description={
          confirmTarget === null
            ? undefined
            : confirmTarget.kind === 'delete'
              ? `确定删除「${confirmTarget.category.label}」？删除仅移除分类（保留记录、编码不可复用）；被商品或申请引用时会被拒绝，可改为停用。`
              : `确定停用「${confirmTarget.category.label}」？历史已发布商品仍可显示该分类，但新商品首次发布不能使用。`
        }
        confirmLabel={confirmTarget?.kind === 'delete' ? '删除' : '停用'}
        tone="danger"
        loading={busy !== null}
        onConfirm={() => {
          if (confirmTarget?.kind === 'delete') void handleDelete(confirmTarget.category)
          else if (confirmTarget?.kind === 'deactivate') void handleDeactivate(confirmTarget.category)
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Reorder list (drag-free arrow-based, keyboard friendly)
 * ------------------------------------------------------------------ */

function ReorderList({
  rows,
  busy,
  onMove,
}: {
  rows: CategoryAdminDto[]
  busy: boolean
  onMove: (index: number, delta: -1 | 1) => void
}) {
  if (rows.length === 0) {
    return <EmptyState icon={FolderTree} title="暂无分类" description="没有可排序的分类。" compact />
  }
  return (
    <ol className="divide-y divide-[var(--color-border)]" data-testid="reorder-list">
      {rows.map((c, index) => (
        <li key={c.id} data-testid={`reorder-row-${c.id}`} className="flex items-center gap-3 px-4 py-2.5">
          <span className="w-6 text-sm text-[var(--color-text-muted)] tabular-nums">{index + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm text-[var(--color-text)] flex items-center gap-2">
              {c.label}
              {c.status === CATEGORY_STATUS.INACTIVE && <CategoryStatusBadge status={c.status} />}
            </div>
            <div className="font-mono text-xs text-[var(--color-text-muted)]">{c.code}</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="icon-btn p-1.5 rounded-md hover:bg-[var(--color-border)] cursor-pointer"
              aria-label={`上移 ${c.label}`}
              data-testid={`reorder-up-${c.id}`}
              disabled={busy || index === 0}
              onClick={() => onMove(index, -1)}
            >
              <ArrowUp className="w-4 h-4" />
            </button>
            <button
              type="button"
              className="icon-btn p-1.5 rounded-md hover:bg-[var(--color-border)] cursor-pointer"
              aria-label={`下移 ${c.label}`}
              data-testid={`reorder-down-${c.id}`}
              disabled={busy || index === rows.length - 1}
              onClick={() => onMove(index, 1)}
            >
              <ArrowDown className="w-4 h-4" />
            </button>
          </div>
        </li>
      ))}
    </ol>
  )
}
