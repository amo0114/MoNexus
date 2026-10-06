// T-MERCH-FE-003 — EditPackageDialog: the per-row 编辑 dialog extracted from
// AdminPromotionPackageManager (SPEC-MERCH-001 §11 admin lane).
//
// Ownership: this dialog owns its open flag, the edit target, every editable
// form field, the field error, the submit error and the double-submit guard.
// The parent keeps the package list, the includeInactive query, the per-row
// 编辑 trigger and the success feedback: a successful update closes this
// dialog and calls onUpdated once so the parent can report the status and
// refresh the current query. A failure keeps the dialog open for retry and
// never notifies the parent.
//
// Reopen and target-switch behaviour are preserved exactly: open(pkg) performs
// the whole prefill the inlined openEditDialog performed (the target itself,
// every editable field seeded from the DTO, placement/status from the frozen
// enums, duration/price/sort stringified, field and server errors cleared)
// before the dialog becomes visible, so a reopen after a cancel, a failed
// save, a successful save and a switch to another row all start from that
// DTO's pristine values. Seeding happens on open instead of on a key change,
// so the dialog is never remounted and its DOM identity is stable.
//
// The dialog shows the immutable code read-only and submits the frozen
// AdminPromotionPackageUpdatePayload (label / placement / durationDays /
// pricePoints / description / sortOrder / status) — never code / id /
// createdAt / updatedAt.

import { forwardRef, useImperativeHandle, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getApiErrorMessage } from '../../../api/error'
import type { updateAdminPromotionPackage } from '../../../api/merchandising'
import type {
  AdminPromotionPackageDTO,
  AdminPromotionPackageUpdatePayload,
  PackageStatus,
  SponsoredPlacement,
} from '../../../types/merchandising'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'

/** Exact update-request signature the parent adapter satisfies. */
type UpdatePackageRequest = typeof updateAdminPromotionPackage

const MAX_LABEL_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 1000
const MIN_DURATION_DAYS = 1
const MAX_DURATION_DAYS = 90
const MIN_SORT_ORDER = -100000
const MAX_SORT_ORDER = 100000

/** Positive integer (no sign, no decimals, no leading zeros, no exponent). */
const POSITIVE_INTEGER = /^[1-9]\d*$/
/** Integer, optionally negative (no decimals, no exponent notation). */
const INTEGER = /^-?\d+$/

/**
 * Fail-closed runtime guard for the placement select: only the two frozen
 * SponsoredPlacement values are accepted; a type assertion never masks an
 * out-of-enum value.
 */
function isKnownSponsoredPlacement(value: string): value is SponsoredPlacement {
  return value === 'store_home_sponsored' || value === 'category_sponsored'
}

/**
 * Fail-closed runtime guard for the status select: only the two frozen
 * PackageStatus values are accepted; a type assertion never masks an
 * out-of-enum value.
 */
function isKnownPackageStatus(value: string): value is PackageStatus {
  return value === 'active' || value === 'inactive'
}

export interface EditPackageDialogHandle {
  /** Open prefilled from the DTO — same seeding the inlined handler performed. */
  open: (pkg: AdminPromotionPackageDTO) => void
}

export interface EditPackageDialogProps {
  /** Update request; injected so this module never imports the manager. */
  updatePackage: UpdatePackageRequest
  /** Called exactly once on success, after the dialog closed itself. */
  onUpdated: () => void
}

const EditPackageDialog = forwardRef<EditPackageDialogHandle, EditPackageDialogProps>(
  function EditPackageDialog({ updatePackage, onUpdated }, ref) {
    // Target of the current open — null until the first open.
    const [target, setTarget] = useState<AdminPromotionPackageDTO | null>(null)
    const [open, setOpen] = useState(false)
    const [label, setLabel] = useState('')
    const [placement, setPlacement] = useState('store_home_sponsored')
    const [durationDays, setDurationDays] = useState('')
    const [pricePoints, setPricePoints] = useState('')
    const [description, setDescription] = useState('')
    const [sortOrder, setSortOrder] = useState('')
    const [status, setStatus] = useState('active')
    const [fieldError, setFieldError] = useState<string | null>(null)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    useImperativeHandle(ref, () => ({
      open: (pkg) => {
        // Fresh form on every open — clears stale values, field errors and all
        // previous server errors so a retry never shows a leftover message.
        setTarget(pkg)
        setLabel(pkg.label)
        setPlacement(pkg.placement)
        setDurationDays(String(pkg.durationDays))
        setPricePoints(String(pkg.pricePoints))
        setDescription(pkg.description)
        setSortOrder(String(pkg.sortOrder))
        setStatus(pkg.status)
        setFieldError(null)
        setSubmitError(null)
        setOpen(true)
      },
    }), [])

    // Mirrors the create validation boundaries exactly — label trim 必填 ≤100,
    // description trim ≤1000, placement 仅两个 frozen enum, durationDays 严格十进制
    // 整数 1..90, pricePoints 严格正整数, sortOrder 严格整数 -100000..100000；拒绝
    // 小数、指数、空值、超 safe integer；status runtime fail-closed。
    const validateEdit = (): string | null => {
      const trimmedLabel = label.trim()
      if (!trimmedLabel) return '请输入套餐名称'
      if (trimmedLabel.length > MAX_LABEL_LENGTH) return `套餐名称不能超过 ${MAX_LABEL_LENGTH} 个字符`
      if (!isKnownSponsoredPlacement(placement)) return '请选择有效的展位'
      const durationRaw = durationDays.trim()
      if (!POSITIVE_INTEGER.test(durationRaw)) {
        return `时长必须为 ${MIN_DURATION_DAYS} 到 ${MAX_DURATION_DAYS} 的整数`
      }
      const parsedDurationDays = Number(durationRaw)
      if (
        !Number.isSafeInteger(parsedDurationDays) ||
        parsedDurationDays < MIN_DURATION_DAYS ||
        parsedDurationDays > MAX_DURATION_DAYS
      ) {
        return `时长必须为 ${MIN_DURATION_DAYS} 到 ${MAX_DURATION_DAYS} 的整数`
      }
      const priceRaw = pricePoints.trim()
      if (!POSITIVE_INTEGER.test(priceRaw)) return '价格必须为正整数'
      const parsedPricePoints = Number(priceRaw)
      if (!Number.isSafeInteger(parsedPricePoints)) return '价格必须为正整数'
      const sortRaw = sortOrder.trim()
      if (sortRaw === '' || !INTEGER.test(sortRaw)) {
        return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
      }
      const parsedSortOrder = Number(sortRaw)
      if (!Number.isSafeInteger(parsedSortOrder)) return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
      if (parsedSortOrder < MIN_SORT_ORDER || parsedSortOrder > MAX_SORT_ORDER) {
        return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
      }
      if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
        return `说明不能超过 ${MAX_DESCRIPTION_LENGTH} 字`
      }
      if (!isKnownPackageStatus(status)) return '请选择有效的状态'
      return null
    }

    const handleEditSubmit = async () => {
      // Entry guard: a pending request must not be re-entered (double submit).
      if (busy) return
      const error = validateEdit()
      if (error) {
        setFieldError(error)
        return
      }
      setFieldError(null)
      setSubmitError(null)
      setBusy(true)
      try {
        // Fail-closed at runtime: never trust the select value by type alone.
        if (!isKnownSponsoredPlacement(placement)) {
          setFieldError('请选择有效的展位')
          return
        }
        if (!isKnownPackageStatus(status)) {
          setFieldError('请选择有效的状态')
          return
        }
        if (target == null) {
          setFieldError('缺少待编辑的套餐，请重新打开编辑窗口。')
          return
        }
        // Exact update payload — the 7 editable fields only; code / id /
        // createdAt / updatedAt are never sent (code is immutable).
        const payload: AdminPromotionPackageUpdatePayload = {
          label: label.trim(),
          placement,
          durationDays: Number(durationDays.trim()),
          pricePoints: Number(pricePoints.trim()),
          description: description.trim(),
          sortOrder: Number(sortOrder.trim()),
          status,
        }
        await updatePackage(target.id, payload)
        // Success only: close the dialog, drop the target and let the parent
        // report status and refresh the current query.
        setOpen(false)
        setTarget(null)
        onUpdated()
      } catch (e) {
        // Failure: keep the dialog open, surface the server error, never fake
        // success nor refresh the list — retry stays available.
        setSubmitError(
          getApiErrorMessage(e, '套餐更新失败，请稍后重试。'),
        )
      } finally {
        setBusy(false)
      }
    }

    return (
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          // Prevent closing while an edit request is in flight.
          if (!nextOpen && busy) return
          setOpen(nextOpen)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogTitle>编辑推广套餐</DialogTitle>
          <DialogDescription>
            修改套餐的展位、时长、价格、排序与启停状态。套餐编码创建后不可修改。
          </DialogDescription>
          <div className="space-y-4 mt-4">
            <div>
              <label
                htmlFor="package-edit-code"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                套餐编码
              </label>
              <div
                id="package-edit-code"
                className="input bg-[var(--color-surface)] font-mono text-xs text-[var(--color-text-muted)]"
              >
                {target?.code ?? '—'}
              </div>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">创建后不可修改。</p>
            </div>
            <div>
              <label
                htmlFor="package-edit-label"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                套餐名称
              </label>
              <input
                id="package-edit-label"
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value)
                  setFieldError(null)
                }}
                placeholder="请输入套餐名称"
                maxLength={MAX_LABEL_LENGTH}
                className="input"
                disabled={busy}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="package-edit-placement"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  展位
                </label>
                <select
                  id="package-edit-placement"
                  value={placement}
                  onChange={(e) => {
                    setPlacement(e.target.value)
                    setFieldError(null)
                  }}
                  className="input py-2 pr-8"
                  disabled={busy}
                >
                  <option value="store_home_sponsored">首页推广位</option>
                  <option value="category_sponsored">分类推广位</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="package-edit-status"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  状态
                </label>
                <select
                  id="package-edit-status"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value)
                    setFieldError(null)
                  }}
                  className="input py-2 pr-8"
                  disabled={busy}
                >
                  <option value="active">启用</option>
                  <option value="inactive">停用</option>
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="package-edit-duration"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  时长（天）
                </label>
                <input
                  id="package-edit-duration"
                  type="text"
                  inputMode="numeric"
                  value={durationDays}
                  onChange={(e) => {
                    setDurationDays(e.target.value)
                    setFieldError(null)
                  }}
                  placeholder={`${MIN_DURATION_DAYS}-${MAX_DURATION_DAYS}`}
                  className="input"
                  disabled={busy}
                />
              </div>
              <div>
                <label
                  htmlFor="package-edit-price"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  价格（积分）
                </label>
                <input
                  id="package-edit-price"
                  type="text"
                  inputMode="numeric"
                  value={pricePoints}
                  onChange={(e) => {
                    setPricePoints(e.target.value)
                    setFieldError(null)
                  }}
                  placeholder="正整数"
                  className="input"
                  disabled={busy}
                />
              </div>
              <div>
                <label
                  htmlFor="package-edit-sort"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  展示顺序
                  <span className="text-[11px] font-normal text-[var(--color-text-muted)] ml-1">
                    （数字越小越靠前）
                  </span>
                </label>
                <input
                  id="package-edit-sort"
                  aria-label="排序"
                  type="text"
                  inputMode="numeric"
                  value={sortOrder}
                  onChange={(e) => {
                    setSortOrder(e.target.value)
                    setFieldError(null)
                  }}
                  placeholder={`${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`}
                  className="input"
                  disabled={busy}
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="package-edit-description"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                说明
              </label>
              <textarea
                id="package-edit-description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value)
                  setFieldError(null)
                }}
                rows={3}
                maxLength={MAX_DESCRIPTION_LENGTH}
                placeholder="请输入套餐说明（可为空，不超过 1000 字）"
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
                onClick={() => setOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={busy}
                onClick={() => void handleEditSubmit()}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认保存'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  },
)

EditPackageDialog.displayName = 'EditPackageDialog'

export default EditPackageDialog
