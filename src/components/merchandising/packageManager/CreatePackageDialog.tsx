// T-MERCH-FE-003 — CreatePackageDialog: the 新建套餐 dialog extracted from
// AdminPromotionPackageManager (SPEC-MERCH-001 §11 admin lane).
//
// Ownership: this dialog owns its open flag, every create form field, the
// field error, the submit error and the double-submit guard. The parent keeps
// the package list, the includeInactive query and the success feedback: a
// successful create closes this dialog and calls onCreated once so the parent
// can report the status and refresh the current query. A failure keeps the
// dialog open for retry and never notifies the parent.
//
// The imperative open() handle reproduces the previous parent-side
// openCreateDialog exactly: every open starts from a pristine form (empty
// code / label / duration / price / sort / description, placement back to
// store_home_sponsored, no stale field or server error) with the same
// synchronous reset timing as the inlined version, so no mount, remount or
// reset effect is involved.
//
// The dialog submits the frozen AdminPromotionPackageCreatePayload (code /
// label / placement / durationDays / pricePoints / description / sortOrder)
// and never sends status / id / timestamps.

import { forwardRef, useImperativeHandle, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getApiErrorCode, getApiErrorMessage } from '../../../api/error'
import type { createAdminPromotionPackage } from '../../../api/merchandising'
import type {
  AdminPromotionPackageCreatePayload,
  SponsoredPlacement,
} from '../../../types/merchandising'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'

/** Exact create-request signature the parent adapter satisfies. */
type CreatePackageRequest = typeof createAdminPromotionPackage

const MAX_CODE_LENGTH = 64
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

export interface CreatePackageDialogHandle {
  /** Open with a pristine form — same reset the inlined handler performed. */
  open: () => void
}

export interface CreatePackageDialogProps {
  /** Create request; injected so this module never imports the manager. */
  createPackage: CreatePackageRequest
  /** Called exactly once on success, after the dialog closed itself. */
  onCreated: () => void
}

const CreatePackageDialog = forwardRef<CreatePackageDialogHandle, CreatePackageDialogProps>(
  function CreatePackageDialog({ createPackage, onCreated }, ref) {
    const [open, setOpen] = useState(false)
    const [code, setCode] = useState('')
    const [label, setLabel] = useState('')
    const [placement, setPlacement] = useState('store_home_sponsored')
    const [durationDays, setDurationDays] = useState('')
    const [pricePoints, setPricePoints] = useState('')
    const [description, setDescription] = useState('')
    const [sortOrder, setSortOrder] = useState('')
    const [fieldError, setFieldError] = useState<string | null>(null)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    useImperativeHandle(ref, () => ({
      open: () => {
        // Fresh form on every open — clears stale field values, field errors and
        // all previous server errors so a retry never shows a leftover message.
        setCode('')
        setLabel('')
        setPlacement('store_home_sponsored')
        setDurationDays('')
        setPricePoints('')
        setDescription('')
        setSortOrder('')
        setFieldError(null)
        setSubmitError(null)
        setOpen(true)
      },
    }), [])

    const validateCreate = (): string | null => {
      const trimmedCode = code.trim()
      if (!trimmedCode) return '请输入套餐编码'
      if (trimmedCode.length > MAX_CODE_LENGTH) return `套餐编码不能超过 ${MAX_CODE_LENGTH} 个字符`
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
      return null
    }

    const handleCreateSubmit = async () => {
      // Entry guard: a pending request must not be re-entered (double submit).
      if (busy) return
      const error = validateCreate()
      if (error) {
        setFieldError(error)
        return
      }
      setFieldError(null)
      setSubmitError(null)
      setBusy(true)
      try {
        if (!isKnownSponsoredPlacement(placement)) {
          setFieldError('请选择有效的展位')
          return
        }
        const payload: AdminPromotionPackageCreatePayload = {
          code: code.trim(),
          label: label.trim(),
          placement,
          durationDays: Number(durationDays.trim()),
          pricePoints: Number(pricePoints.trim()),
          description: description.trim(),
          sortOrder: Number(sortOrder.trim()),
        }
        await createPackage(payload)
        // Success only: close the dialog and let the parent report status and
        // refresh the current query.
        setOpen(false)
        onCreated()
      } catch (e) {
        // Failure: keep the dialog open, surface the server error, never fake
        // success nor refresh the list — retry stays available.
        setSubmitError(
          getApiErrorCode(e) === 'PACKAGE_CODE_TAKEN'
            ? '套餐编码已存在，请更换编码。'
            : getApiErrorMessage(e, '套餐创建失败，请稍后重试。'),
        )
      } finally {
        setBusy(false)
      }
    }

    return (
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          // Prevent closing while a create request is in flight.
          if (!nextOpen && busy) return
          setOpen(nextOpen)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogTitle>新建推广套餐</DialogTitle>
          <DialogDescription>
            配置推广位的展位、时长与积分价格。套餐编码创建后不可修改。
          </DialogDescription>
          <div className="space-y-4 mt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="package-create-code"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  套餐编码
                </label>
                <input
                  id="package-create-code"
                  type="text"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value)
                    setFieldError(null)
                  }}
                  placeholder="请输入套餐编码"
                  maxLength={MAX_CODE_LENGTH}
                  className="input"
                  disabled={busy}
                />
              </div>
              <div>
                <label
                  htmlFor="package-create-label"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  套餐名称
                </label>
                <input
                  id="package-create-label"
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
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="package-create-placement"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  展位
                </label>
                <select
                  id="package-create-placement"
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
                  htmlFor="package-create-duration"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  时长（天）
                </label>
                <input
                  id="package-create-duration"
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
                  htmlFor="package-create-price"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  价格（积分）
                </label>
                <input
                  id="package-create-price"
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
            </div>
            <div>
              <label
                htmlFor="package-create-sort"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                展示顺序
                <span className="text-[11px] font-normal text-[var(--color-text-muted)] ml-1">
                  （数字越小越靠前）
                </span>
              </label>
              <input
                id="package-create-sort"
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
            <div>
              <label
                htmlFor="package-create-description"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                说明
              </label>
              <textarea
                id="package-create-description"
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
                onClick={() => void handleCreateSubmit()}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认创建'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  },
)

CreatePackageDialog.displayName = 'CreatePackageDialog'

export default CreatePackageDialog
