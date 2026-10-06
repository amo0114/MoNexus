// EditorialFormDialog — the create/edit dialog extracted from
// AdminEditorialManager (SPEC-MERCH-001 §5.5 admin lane).
//
// The dialog isolates the *form* concern only: field state, initialization,
// client-side validation and date conversion. The parent keeps list state,
// pagination, filters, the adapter and the refresh-after-success call; this
// component reports a submitted payload upward and never talks to the API.
//
// Timezone: ISO ↔ datetime-local conversion always uses the browser's local
// timezone (the datetime-local input holds local wall-clock time). An
// unparseable edit date is never silently submitted — it is surfaced as an
// error when the dialog opens and blocks submission until corrected.

import { useState } from 'react'
import { Loader2, Lock } from 'lucide-react'
import type {
  AdminEditorialCreatePayload,
  AdminEditorialFeatureDTO,
  AdminEditorialUpdatePayload,
  EditorialPlacement,
} from '../../../types/merchandising'
import AdminProductSearchSelect from '../AdminProductSearchSelect'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import { MAX_INTERNAL_REASON_LENGTH } from './types'

const MAX_PUBLIC_REASON_LENGTH = 120
const MIN_SORT_WEIGHT = -100000
const MAX_SORT_WEIGHT = 100000
const DEFAULT_SORT_WEIGHT = 0

/** Positive integer (no sign, no decimals, no leading zeros). */
const POSITIVE_INTEGER = /^[1-9]\d*$/
/** Integer, optionally negative (no decimals, no exponent notation). */
const INTEGER = /^-?\d+$/

const PLACEMENT_SELECT_OPTIONS: ReadonlyArray<{ value: EditorialPlacement; label: string }> = [
  { value: 'store_editorial', label: '店铺精选' },
  { value: 'category_editorial', label: '分类精选' },
]

/**
 * Parse a product id that is safe to send as a JS number: must be a positive
 * integer (POSITIVE_INTEGER) whose numeric value stays within the JS
 * safe-integer range. Returns null instead of a distorted number so callers
 * can surface their “商品 ID 必须为正整数” error.
 */
function parseSafeProductId(trimmed: string): number | null {
  if (!POSITIVE_INTEGER.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) return null
  return value
}

/**
 * Convert an ISO timestamp to a datetime-local value in the browser's local
 * timezone (e.g. "2026-08-01T02:00:00.000Z" → "2026-08-01T10:00" in UTC+8).
 * Returns null when the ISO string cannot be parsed — callers must surface an
 * error instead of silently submitting an empty/mangled date.
 */
function isoToDatetimeLocal(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

/**
 * Convert a datetime-local value (browser local wall-clock time) to an ISO-8601
 * UTC string. `new Date("YYYY-MM-DDTHH:mm")` parses as local time, so
 * `toISOString()` yields the exact UTC instant. Returns null when unparseable.
 */
function datetimeLocalToIso(value: string): string | null {
  if (value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/** Complete form field snapshot — also the fresh-open initial values. */
interface EditorialFormValues {
  productId: string
  placement: EditorialPlacement
  startsAt: string
  endsAt: string
  sortWeight: string
  publicReason: string
  internalReason: string
}

function emptyForm(): EditorialFormValues {
  return {
    productId: '',
    placement: 'store_editorial',
    startsAt: '',
    endsAt: '',
    sortWeight: String(DEFAULT_SORT_WEIGHT),
    publicReason: '',
    internalReason: '',
  }
}

/**
 * Derive the form state for a given target: create → blank defaults, edit →
 * pre-filled from the DTO. `fieldError` reproduces the immediate
 * "无法解析" surfacing for unparseable ISO timestamps.
 */
function initForm(feature: AdminEditorialFeatureDTO | null): {
  values: EditorialFormValues
  fieldError: string | null
} {
  if (feature == null) return { values: emptyForm(), fieldError: null }

  // ISO → datetime-local must honor the browser's local timezone; an
  // unparseable date is surfaced immediately and never silently submitted.
  const startsLocal = isoToDatetimeLocal(feature.startsAt)
  const endsLocal = isoToDatetimeLocal(feature.endsAt)
  const unparseable: string[] = []
  if (startsLocal == null) unparseable.push('开始时间')
  if (endsLocal == null) unparseable.push('结束时间')

  return {
    values: {
      productId: String(feature.productId),
      placement: feature.placement,
      startsAt: startsLocal ?? '',
      endsAt: endsLocal ?? '',
      sortWeight: String(feature.sortWeight),
      publicReason: feature.publicReason ?? '',
      internalReason: feature.internalReason,
    },
    fieldError:
      unparseable.length > 0
        ? `该精选的${unparseable.join('、')}无法解析，请重新选择后再保存。`
        : null,
  }
}

function validateForm(feature: AdminEditorialFeatureDTO | null, values: EditorialFormValues): string | null {
  if (feature == null && parseSafeProductId(values.productId.trim()) == null) {
    return '请选择商品'
  }
  // placement is a controlled select limited to the two frozen enums.
  const startsIso = datetimeLocalToIso(values.startsAt)
  if (startsIso == null) return '请选择有效的开始时间'
  const endsIso = datetimeLocalToIso(values.endsAt)
  if (endsIso == null) return '请选择有效的结束时间'
  const startsMs = new Date(startsIso).getTime()
  const endsMs = new Date(endsIso).getTime()
  if (endsMs <= startsMs) return '结束时间必须晚于开始时间'
  if (endsMs <= Date.now()) return '结束时间必须晚于当前时间'
  const sortWeight = values.sortWeight.trim()
  if (sortWeight !== '') {
    if (!INTEGER.test(sortWeight)) return '权重必须为整数'
    const weight = Number(sortWeight)
    if (!Number.isSafeInteger(weight)) return '权重必须为整数'
    if (weight < MIN_SORT_WEIGHT || weight > MAX_SORT_WEIGHT) {
      return `权重必须在 ${MIN_SORT_WEIGHT} 到 ${MAX_SORT_WEIGHT} 之间`
    }
  }
  if (values.publicReason.trim().length > MAX_PUBLIC_REASON_LENGTH) {
    return `公开理由不能超过 ${MAX_PUBLIC_REASON_LENGTH} 字`
  }
  const internalReason = values.internalReason.trim()
  if (internalReason.length < 1) return '请输入内部原因'
  if (internalReason.length > MAX_INTERNAL_REASON_LENGTH) {
    return `内部原因不能超过 ${MAX_INTERNAL_REASON_LENGTH} 字`
  }
  return null
}

/** What this dialog asks its parent to do. */
export interface EditorialFormDialogSubmitHandlers {
  /** Create a new editorial feature; the parent owns the payload typing. */
  onCreate: (payload: AdminEditorialCreatePayload) => Promise<void>
  /** Update an existing feature; productId is never part of an update. */
  onUpdate: (id: number, payload: AdminEditorialUpdatePayload) => Promise<void>
  /** Maps a failed mutation to the message rendered inside the dialog. */
  onFailure: (error: unknown, feature: AdminEditorialFeatureDTO | null) => string
}

export interface EditorialFormDialogProps {
  open: boolean
  /**
   * The feature being edited, or null for create. Also the form identity:
   * changing the target re-initializes the whole form.
   */
  feature: AdminEditorialFeatureDTO | null
  onOpenChange: (open: boolean) => void
  submit: EditorialFormDialogSubmitHandlers
}

export default function EditorialFormDialog({
  open,
  feature,
  onOpenChange,
  submit,
}: EditorialFormDialogProps) {
  const [values, setValues] = useState<EditorialFormValues>(() => initForm(feature).values)
  const [fieldError, setFieldError] = useState<string | null>(() => initForm(feature).fieldError)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A fresh form on every open — the reset the pre-extraction dialog performed
  // in its open handlers. Identity is the (open, feature) pair, so re-opening
  // for the same feature, switching target, or opening for another feature all
  // rebuild the form and clear both error slots. Re-opening for the SAME
  // feature compares equal unless `open` is part of the identity, which is why
  // the open flag cannot be left out.
  //
  // Adjusting state during render is React's documented "reset state when
  // props change" pattern: it re-renders before commit, so the dialog subtree
  // never unmounts (no focus loss, no portal churn, no key-based remount).
  const [initFor, setInitFor] = useState<{ open: boolean; feature: AdminEditorialFeatureDTO | null }>({
    open,
    feature,
  })
  if (initFor.open !== open || initFor.feature !== feature) {
    setInitFor({ open, feature })
    if (open) {
      const next = initForm(feature)
      setValues(next.values)
      setFieldError(next.fieldError)
      setSubmitError(null)
      // busy is intentionally untouched: a mutation in flight must not be
      // un-latched underneath itself.
    }
    // While closed the current input is kept; the next open rebuilds it.
  }

  const patch = (changes: Partial<EditorialFormValues>) => {
    setValues((prev) => ({ ...prev, ...changes }))
    setFieldError(null)
  }

  const handleSubmit = async () => {
    if (busy) return
    const error = validateForm(feature, values)
    if (error) {
      setFieldError(error)
      return
    }
    setFieldError(null)
    setSubmitError(null)
    setBusy(true)
    try {
      const startsIso = datetimeLocalToIso(values.startsAt)
      const endsIso = datetimeLocalToIso(values.endsAt)
      if (startsIso == null || endsIso == null) {
        setFieldError('请选择有效的开始和结束时间')
        return
      }
      const sortWeightRaw = values.sortWeight.trim()
      const sortWeight = sortWeightRaw === '' ? DEFAULT_SORT_WEIGHT : Number(sortWeightRaw)
      const publicReasonTrimmed = values.publicReason.trim()
      const publicReason = publicReasonTrimmed === '' ? null : publicReasonTrimmed
      const internalReason = values.internalReason.trim()
      if (feature == null) {
        const productId = parseSafeProductId(values.productId.trim())
        if (productId == null) {
          setFieldError('请选择商品')
          return
        }
        // Exact create payload — productId always present, all fields sent.
        const payload: AdminEditorialCreatePayload = {
          productId,
          placement: values.placement,
          startsAt: startsIso,
          endsAt: endsIso,
          sortWeight,
          publicReason,
          internalReason,
        }
        await submit.onCreate(payload)
      } else {
        // Exact update payload — no productId, all editable fields (PATCH ≥1).
        const payload: AdminEditorialUpdatePayload = {
          placement: values.placement,
          startsAt: startsIso,
          endsAt: endsIso,
          sortWeight,
          publicReason,
          internalReason,
        }
        await submit.onUpdate(feature.id, payload)
      }
      // Success only: the parent closes the dialog, reports status and
      // refreshes the current filter/page inside onCreate/onUpdate.
    } catch (e) {
      // Failure: keep the dialog open, surface the server error, no fake success.
      setSubmitError(submit.onFailure(e, feature))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogTitle>{feature == null ? '新建精选' : '编辑精选'}</DialogTitle>
        <DialogDescription>
          {feature == null
            ? '为指定商品设置一个平台精选展示位，独立于自然热卖与推广。'
            : `正在编辑“${feature.productName}”的平台精选。`}
        </DialogDescription>
        <div className="space-y-4 mt-4">
          <div>
            <label
              id="editorial-form-product-label"
              htmlFor="editorial-form-product"
              className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
            >
              商品
            </label>
            <AdminProductSearchSelect
              value={values.productId.trim() ? Number(values.productId) : null}
              onChange={(id) => patch({ productId: id == null ? '' : String(id) })}
              disabled={busy}
              readOnly={feature != null}
              inputId="editorial-form-product"
              labelledBy="editorial-form-product-label"
              testId="editorial-form-product"
            />
            {feature != null && (
              <p className="text-xs text-[var(--color-text-muted)] mt-1">新建后商品不可变更。</p>
            )}
          </div>
          <div>
            <label
              htmlFor="editorial-form-placement"
              className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
            >
              展位
            </label>
            <select
              id="editorial-form-placement"
              value={values.placement}
              onChange={(e) => patch({ placement: e.target.value as EditorialPlacement })}
              className="input py-2 pr-8"
              disabled={busy}
            >
              {PLACEMENT_SELECT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="editorial-form-starts-at"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                开始时间
              </label>
              <input
                id="editorial-form-starts-at"
                type="datetime-local"
                value={values.startsAt}
                onChange={(e) => patch({ startsAt: e.target.value })}
                className="input"
                disabled={busy}
              />
            </div>
            <div>
              <label
                htmlFor="editorial-form-ends-at"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                结束时间
              </label>
              <input
                id="editorial-form-ends-at"
                type="datetime-local"
                value={values.endsAt}
                onChange={(e) => patch({ endsAt: e.target.value })}
                className="input"
                disabled={busy}
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="editorial-form-sort-weight"
              className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
            >
              排序权重
              <span className="text-[11px] font-normal text-[var(--color-text-muted)] ml-1">
                （数字越大越靠前）
              </span>
            </label>
            <input
              id="editorial-form-sort-weight"
              aria-label="权重"
              type="number"
              step="1"
              min={MIN_SORT_WEIGHT}
              max={MAX_SORT_WEIGHT}
              value={values.sortWeight}
              onChange={(e) => patch({ sortWeight: e.target.value })}
              placeholder={`${MIN_SORT_WEIGHT} 到 ${MAX_SORT_WEIGHT} 的整数`}
              className="input"
              disabled={busy}
            />
          </div>
          <div>
            <label
              htmlFor="editorial-form-public-reason"
              className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
            >
              公开理由（对外展示）
            </label>
            <p className="text-xs text-[var(--color-text-muted)] mb-1.5">
              展示在精选商品旁的说明文字，向所有用户可见；留空则不展示任何理由。
            </p>
            <textarea
              id="editorial-form-public-reason"
              value={values.publicReason}
              onChange={(e) => patch({ publicReason: e.target.value })}
              rows={3}
              maxLength={MAX_PUBLIC_REASON_LENGTH}
              placeholder="请输入对外展示的公开理由（不超过 120 字）"
              className="input resize-y"
              disabled={busy}
            />
          </div>
          <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Lock className="w-3.5 h-3.5 text-[var(--color-text-muted)]" aria-hidden="true" />
              <label
                htmlFor="editorial-form-internal-reason"
                className="block text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider"
              >
                内部原因（仅管理员可见）
              </label>
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mb-1.5">
              内部备注，不会对外展示，也不会出现在任何公开商品页。
            </p>
            <textarea
              id="editorial-form-internal-reason"
              value={values.internalReason}
              onChange={(e) => patch({ internalReason: e.target.value })}
              rows={3}
              maxLength={MAX_INTERNAL_REASON_LENGTH}
              placeholder="请输入内部原因（1 到 500 字）"
              className="input resize-y"
              disabled={busy}
            />
          </div>
          {fieldError && (
            <div
              role="alert"
              className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
            >
              {fieldError}
            </div>
          )}
          {submitError && (
            <div
              role="alert"
              className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
            >
              {submitError}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-primary px-4 py-2 text-sm"
              disabled={busy}
              onClick={() => void handleSubmit()}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : feature == null ? '确认新建' : '确认保存'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
