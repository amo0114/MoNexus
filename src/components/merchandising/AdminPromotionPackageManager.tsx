// T-MERCH-FE-003 — AdminPromotionPackageManager: admin-only view of promotion
// packages (SPEC-MERCH-001 §11 admin lane): a list shell with the “包含停用套餐”
// includeInactive toggle, a “新建套餐” create dialog and a per-row “编辑” dialog.
//
// The create dialog submits the frozen AdminPromotionPackageCreatePayload
// (code / label / placement / durationDays / pricePoints / description /
// sortOrder) and never sends status / id / timestamps. The edit dialog
// prefills from the DTO, reuses the same validation boundaries, shows the
// immutable code read-only, and submits the frozen
// AdminPromotionPackageUpdatePayload (label / placement / durationDays /
// pricePoints / description / sortOrder / status) — active/inactive status
// is managed inside the edit dialog only, with no separate quick toggle, so
// there is a single mutation owner. The update payload never contains code /
// id / createdAt / updatedAt.
//
// The full AdminPromotionPackageAdapter (listPackages / createPackage /
// updatePackage) is exported and defaults to the frozen admin API.
//
// The server remains authoritative: the client only renders the wire enum
// values through fixed Chinese labels (placement/status) and never rewrites
// the enums themselves. The list is not paginated — the API returns an array.
//
// Concurrency: a strictly-increasing request id guards against a stale
// includeInactive response overwriting a newer toggle result. On a list
// failure we surface getApiErrorMessage and never fabricate old data. Create
// and edit are guarded against double-submit, keep the dialog open on failure
// for retry, and only close + refresh the current query on real success.


import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, PackageSearch, Plus } from 'lucide-react'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import {
  createAdminPromotionPackage,
  listAdminPromotionPackages,
  updateAdminPromotionPackage,
} from '../../api/merchandising'
import type {
  AdminPromotionPackageCreatePayload,
  AdminPromotionPackageDTO,
  AdminPromotionPackageUpdatePayload,
  PackageStatus,
  SponsoredPlacement,
} from '../../types/merchandising'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'
import { PLACEMENT_LABEL } from './promotionCopy'
/**
 * Real adapter — passthrough to the frozen admin promotion package API.
 * `updatePackage` backs the per-row edit dialog.
 */
export interface AdminPromotionPackageAdapter {
  listPackages: typeof listAdminPromotionPackages
  createPackage: typeof createAdminPromotionPackage
  updatePackage: typeof updateAdminPromotionPackage
}

const DEFAULT_ADAPTER: AdminPromotionPackageAdapter = {
  listPackages: listAdminPromotionPackages,
  createPackage: createAdminPromotionPackage,
  updatePackage: updateAdminPromotionPackage,
}

export interface AdminPromotionPackageManagerProps {
  adapter?: AdminPromotionPackageAdapter
  className?: string
}

/** Clear Chinese labels for the frozen PackageStatus enum (wire value unchanged). */
const PACKAGE_STATUS_LABEL: Record<PackageStatus, string> = {
  active: '启用',
  inactive: '停用',
}

/** Safe date formatting: unparseable input is shown verbatim. */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

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

/**
 * Fail-closed runtime guard for the status select: only the two frozen
 * PackageStatus values are accepted; a type assertion never masks an
 * out-of-enum value.
 */
function isKnownPackageStatus(value: string): value is PackageStatus {
  return value === 'active' || value === 'inactive'
}
export default function AdminPromotionPackageManager({
  adapter = DEFAULT_ADAPTER,
  className = '',
}: AdminPromotionPackageManagerProps) {
  const [packages, setPackages] = useState<AdminPromotionPackageDTO[]>([])
  const [includeInactive, setIncludeInactive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Create dialog state — always reset to a fresh empty form on open.
  const [createOpen, setCreateOpen] = useState(false)
  const [createCode, setCreateCode] = useState('')
  const [createLabel, setCreateLabel] = useState('')
  const [createPlacement, setCreatePlacement] = useState('store_home_sponsored')
  const [createDurationDays, setCreateDurationDays] = useState('')
  const [createPricePoints, setCreatePricePoints] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createSortOrder, setCreateSortOrder] = useState('')
  const [createFieldError, setCreateFieldError] = useState<string | null>(null)
  const [createSubmitError, setCreateSubmitError] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)

  // Edit dialog state — always reset to a fresh prefill on open.
  const [editOpen, setEditOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AdminPromotionPackageDTO | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editPlacement, setEditPlacement] = useState('store_home_sponsored')
  const [editDurationDays, setEditDurationDays] = useState('')
  const [editPricePoints, setEditPricePoints] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editSortOrder, setEditSortOrder] = useState('')
  const [editStatus, setEditStatus] = useState('active')
  const [editFieldError, setEditFieldError] = useState<string | null>(null)
  const [editSubmitError, setEditSubmitError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  // Non-error feedback (create success) — rendered with role=status.
  const [feedback, setFeedback] = useState<string | null>(null)

  // Strictly-increasing request id: a stale list response (older
  // includeInactive request) must never overwrite a newer toggle result.
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const data = await adapter.listPackages(includeInactive)
      if (seq !== requestSeqRef.current) return
      setPackages(data)
    } catch (e) {
      if (seq !== requestSeqRef.current) return
      // Failure never fabricates old data — clear the list and surface the error.
      setPackages([])
      setLoadError(getApiErrorMessage(e, '套餐列表加载失败，请稍后重试。'))
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [adapter, includeInactive])

  // Initial load calls listPackages(false); toggling the checkbox re-runs this
  // effect and calls listPackages(true/false) exactly, with loading shown.
  useEffect(() => {
    void load()
  }, [load])

  const handleIncludeInactiveChange = (checked: boolean) => {
    setIncludeInactive(checked)
  }

  const openCreateDialog = () => {
    // Fresh form on every open — clears stale field values, field errors and
    // all previous server errors so a retry never shows a leftover message.
    setCreateCode('')
    setCreateLabel('')
    setCreatePlacement('store_home_sponsored')
    setCreateDurationDays('')
    setCreatePricePoints('')
    setCreateDescription('')
    setCreateSortOrder('')
    setCreateFieldError(null)
    setCreateSubmitError(null)
    setCreateOpen(true)
  }

  const validateCreate = (): string | null => {
    const code = createCode.trim()
    if (!code) return '请输入套餐编码'
    if (code.length > MAX_CODE_LENGTH) return `套餐编码不能超过 ${MAX_CODE_LENGTH} 个字符`
    const label = createLabel.trim()
    if (!label) return '请输入套餐名称'
    if (label.length > MAX_LABEL_LENGTH) return `套餐名称不能超过 ${MAX_LABEL_LENGTH} 个字符`
    if (!isKnownSponsoredPlacement(createPlacement)) return '请选择有效的展位'
    const durationRaw = createDurationDays.trim()
    if (!POSITIVE_INTEGER.test(durationRaw)) {
      return `时长必须为 ${MIN_DURATION_DAYS} 到 ${MAX_DURATION_DAYS} 的整数`
    }
    const durationDays = Number(durationRaw)
    if (
      !Number.isSafeInteger(durationDays) ||
      durationDays < MIN_DURATION_DAYS ||
      durationDays > MAX_DURATION_DAYS
    ) {
      return `时长必须为 ${MIN_DURATION_DAYS} 到 ${MAX_DURATION_DAYS} 的整数`
    }
    const priceRaw = createPricePoints.trim()
    if (!POSITIVE_INTEGER.test(priceRaw)) return '价格必须为正整数'
    const pricePoints = Number(priceRaw)
    if (!Number.isSafeInteger(pricePoints)) return '价格必须为正整数'
    const sortRaw = createSortOrder.trim()
    if (sortRaw === '' || !INTEGER.test(sortRaw)) {
      return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
    }
    const sortOrder = Number(sortRaw)
    if (!Number.isSafeInteger(sortOrder)) return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
    if (sortOrder < MIN_SORT_ORDER || sortOrder > MAX_SORT_ORDER) {
      return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
    }
    if (createDescription.trim().length > MAX_DESCRIPTION_LENGTH) {
      return `说明不能超过 ${MAX_DESCRIPTION_LENGTH} 字`
    }
    return null
  }

  const handleCreateSubmit = async () => {
    // Entry guard: a pending request must not be re-entered (double submit).
    if (createBusy) return
    const fieldError = validateCreate()
    if (fieldError) {
      setCreateFieldError(fieldError)
      return
    }
    setCreateFieldError(null)
    setCreateSubmitError(null)
    setCreateBusy(true)
    try {
      if (!isKnownSponsoredPlacement(createPlacement)) {
        setCreateFieldError('请选择有效的展位')
        return
      }
      const payload: AdminPromotionPackageCreatePayload = {
        code: createCode.trim(),
        label: createLabel.trim(),
        placement: createPlacement,
        durationDays: Number(createDurationDays.trim()),
        pricePoints: Number(createPricePoints.trim()),
        description: createDescription.trim(),
        sortOrder: Number(createSortOrder.trim()),
      }
      await adapter.createPackage(payload)
      // Success only: close the dialog, report status, refresh the current query.
      setCreateOpen(false)
      setFeedback('套餐创建成功。')
      void load()
    } catch (e) {
      // Failure: keep the dialog open, surface the server error, never fake
      // success nor refresh the list — retry stays available.
      setCreateSubmitError(
        getApiErrorCode(e) === 'PACKAGE_CODE_TAKEN'
          ? '套餐编码已存在，请更换编码。'
          : getApiErrorMessage(e, '套餐创建失败，请稍后重试。'),
      )
    } finally {
      setCreateBusy(false)
    }
  }

  const openEditDialog = (pkg: AdminPromotionPackageDTO) => {
    // Fresh form on every open — clears stale values, field errors and all
    // previous server errors so a retry never shows a leftover message.
    setEditTarget(pkg)
    setEditLabel(pkg.label)
    setEditPlacement(pkg.placement)
    setEditDurationDays(String(pkg.durationDays))
    setEditPricePoints(String(pkg.pricePoints))
    setEditDescription(pkg.description)
    setEditSortOrder(String(pkg.sortOrder))
    setEditStatus(pkg.status)
    setEditFieldError(null)
    setEditSubmitError(null)
    setEditOpen(true)
  }

  // Mirrors the create validation boundaries exactly — label trim 必填 ≤100,
  // description trim ≤1000, placement 仅两个 frozen enum, durationDays 严格十进制
  // 整数 1..90, pricePoints 严格正整数, sortOrder 严格整数 -100000..100000；拒绝
  // 小数、指数、空值、超 safe integer；status runtime fail-closed。
  const validateEdit = (): string | null => {
    const label = editLabel.trim()
    if (!label) return '请输入套餐名称'
    if (label.length > MAX_LABEL_LENGTH) return `套餐名称不能超过 ${MAX_LABEL_LENGTH} 个字符`
    if (!isKnownSponsoredPlacement(editPlacement)) return '请选择有效的展位'
    const durationRaw = editDurationDays.trim()
    if (!POSITIVE_INTEGER.test(durationRaw)) {
      return `时长必须为 ${MIN_DURATION_DAYS} 到 ${MAX_DURATION_DAYS} 的整数`
    }
    const durationDays = Number(durationRaw)
    if (
      !Number.isSafeInteger(durationDays) ||
      durationDays < MIN_DURATION_DAYS ||
      durationDays > MAX_DURATION_DAYS
    ) {
      return `时长必须为 ${MIN_DURATION_DAYS} 到 ${MAX_DURATION_DAYS} 的整数`
    }
    const priceRaw = editPricePoints.trim()
    if (!POSITIVE_INTEGER.test(priceRaw)) return '价格必须为正整数'
    const pricePoints = Number(priceRaw)
    if (!Number.isSafeInteger(pricePoints)) return '价格必须为正整数'
    const sortRaw = editSortOrder.trim()
    if (sortRaw === '' || !INTEGER.test(sortRaw)) {
      return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
    }
    const sortOrder = Number(sortRaw)
    if (!Number.isSafeInteger(sortOrder)) return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
    if (sortOrder < MIN_SORT_ORDER || sortOrder > MAX_SORT_ORDER) {
      return `排序必须为 ${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`
    }
    if (editDescription.trim().length > MAX_DESCRIPTION_LENGTH) {
      return `说明不能超过 ${MAX_DESCRIPTION_LENGTH} 字`
    }
    if (!isKnownPackageStatus(editStatus)) return '请选择有效的状态'
    return null
  }

  const handleEditSubmit = async () => {
    // Entry guard: a pending request must not be re-entered (double submit).
    if (editBusy) return
    const fieldError = validateEdit()
    if (fieldError) {
      setEditFieldError(fieldError)
      return
    }
    setEditFieldError(null)
    setEditSubmitError(null)
    setEditBusy(true)
    try {
      // Fail-closed at runtime: never trust the select value by type alone.
      if (!isKnownSponsoredPlacement(editPlacement)) {
        setEditFieldError('请选择有效的展位')
        return
      }
      if (!isKnownPackageStatus(editStatus)) {
        setEditFieldError('请选择有效的状态')
        return
      }
      if (editTarget == null) {
        setEditFieldError('缺少待编辑的套餐，请重新打开编辑窗口。')
        return
      }
      // Exact update payload — the 7 editable fields only; code / id /
      // createdAt / updatedAt are never sent (code is immutable).
      const payload: AdminPromotionPackageUpdatePayload = {
        label: editLabel.trim(),
        placement: editPlacement,
        durationDays: Number(editDurationDays.trim()),
        pricePoints: Number(editPricePoints.trim()),
        description: editDescription.trim(),
        sortOrder: Number(editSortOrder.trim()),
        status: editStatus,
      }
      await adapter.updatePackage(editTarget.id, payload)
      // Success only: close the dialog, report status, refresh the current query.
      setEditOpen(false)
      setEditTarget(null)
      setFeedback('套餐更新成功。')
      void load()
    } catch (e) {
      // Failure: keep the dialog open, surface the server error, never fake
      // success nor refresh the list — retry stays available.
      setEditSubmitError(
        getApiErrorMessage(e, '套餐更新失败，请稍后重试。'),
      )
    } finally {
      setEditBusy(false)
    }
  }

  return (
    <section
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-5 ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[var(--color-text)]">推广套餐管理</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            推广套餐决定推广位的展位、时长与积分价格，由平台统一维护。可在编辑弹窗中调整套餐内容与启停状态。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm flex items-center gap-2 shrink-0"
          onClick={openCreateDialog}
        >
          <Plus className="w-4 h-4" />
          新建套餐
        </button>
      </div>

      {feedback && (
        <div role="status" className="mt-3 text-sm text-[var(--color-success)]">
          {feedback}
        </div>
      )}


      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer select-none">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={includeInactive}
            onChange={(e) => handleIncludeInactiveChange(e.target.checked)}
          />
          包含停用套餐
        </label>
        <span className="text-xs text-[var(--color-text-muted)]">
          {includeInactive ? '当前显示启用与停用的全部套餐' : '当前仅显示启用中的套餐'}
        </span>
      </div>

      <div className="mt-4">
        {loading ? (
          <TableSkeleton rows={5} />
        ) : loadError ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-4 text-sm text-[var(--color-danger)]"
          >
            <div>{loadError}</div>
            <button type="button" className="btn-secondary btn-sm" onClick={() => void load()}>
              重新加载
            </button>
          </div>
        ) : packages.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title="暂无套餐记录"
            description="当前条件下没有匹配的推广套餐，可勾选“包含停用套餐”查看全部套餐。"
            compact
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="推广套餐列表">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-muted)]">
                  <th className="px-3 py-2">套餐编码</th>
                  <th className="px-3 py-2">名称</th>
                  <th className="px-3 py-2">展位</th>
                  <th className="px-3 py-2">时长</th>
                  <th className="px-3 py-2">价格（积分）</th>
                  <th className="px-3 py-2">说明</th>
                  <th className="px-3 py-2">排序</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">创建 / 更新</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {packages.map((pkg) => (
                  <tr key={pkg.id}>
                    <td className="px-3 py-3 font-mono text-xs">{pkg.code}</td>
                    <td className="px-3 py-3">{pkg.label}</td>
                    <td className="px-3 py-3">
                      {PLACEMENT_LABEL[pkg.placement] ?? pkg.placement}
                    </td>
                    <td className="px-3 py-3">{pkg.durationDays} 天</td>
                    <td className="px-3 py-3">{pkg.pricePoints}</td>
                    <td className="px-3 py-3">{pkg.description || '—'}</td>
                    <td className="px-3 py-3">{pkg.sortOrder}</td>
                    <td className="px-3 py-3">{PACKAGE_STATUS_LABEL[pkg.status] ?? pkg.status}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-1">
                        <span>
                          <span className="text-[var(--color-text-muted)]">创建</span>{' '}
                          <time dateTime={pkg.createdAt}>{formatDateTime(pkg.createdAt)}</time>
                        </span>
                        <span>
                          <span className="text-[var(--color-text-muted)]">更新</span>{' '}
                          <time dateTime={pkg.updatedAt}>{formatDateTime(pkg.updatedAt)}</time>
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        aria-label={`编辑套餐 ${pkg.code}（套餐 ID ${pkg.id}）`}
                        className="btn-secondary btn-sm"
                        onClick={() => openEditDialog(pkg)}
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          // Prevent closing while a create request is in flight.
          if (!open && createBusy) return
          setCreateOpen(open)
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
                  value={createCode}
                  onChange={(e) => {
                    setCreateCode(e.target.value)
                    setCreateFieldError(null)
                  }}
                  placeholder="请输入套餐编码"
                  maxLength={MAX_CODE_LENGTH}
                  className="input"
                  disabled={createBusy}
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
                  value={createLabel}
                  onChange={(e) => {
                    setCreateLabel(e.target.value)
                    setCreateFieldError(null)
                  }}
                  placeholder="请输入套餐名称"
                  maxLength={MAX_LABEL_LENGTH}
                  className="input"
                  disabled={createBusy}
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
                  value={createPlacement}
                  onChange={(e) => {
                    setCreatePlacement(e.target.value)
                    setCreateFieldError(null)
                  }}
                  className="input py-2 pr-8"
                  disabled={createBusy}
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
                  value={createDurationDays}
                  onChange={(e) => {
                    setCreateDurationDays(e.target.value)
                    setCreateFieldError(null)
                  }}
                  placeholder={`${MIN_DURATION_DAYS}-${MAX_DURATION_DAYS}`}
                  className="input"
                  disabled={createBusy}
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
                  value={createPricePoints}
                  onChange={(e) => {
                    setCreatePricePoints(e.target.value)
                    setCreateFieldError(null)
                  }}
                  placeholder="正整数"
                  className="input"
                  disabled={createBusy}
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="package-create-sort"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                排序
              </label>
              <input
                id="package-create-sort"
                type="text"
                inputMode="numeric"
                value={createSortOrder}
                onChange={(e) => {
                  setCreateSortOrder(e.target.value)
                  setCreateFieldError(null)
                }}
                placeholder={`${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`}
                className="input"
                disabled={createBusy}
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
                value={createDescription}
                onChange={(e) => {
                  setCreateDescription(e.target.value)
                  setCreateFieldError(null)
                }}
                rows={3}
                maxLength={MAX_DESCRIPTION_LENGTH}
                placeholder="请输入套餐说明（可为空，不超过 1000 字）"
                className="input resize-y"
                disabled={createBusy}
              />
            </div>
            {createFieldError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {createFieldError}
              </div>
            )}
            {createSubmitError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {createSubmitError}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm"
                disabled={createBusy}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={createBusy}
                onClick={() => void handleCreateSubmit()}
              >
                {createBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认创建'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          // Prevent closing while an edit request is in flight.
          if (!open && editBusy) return
          setEditOpen(open)
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
                {editTarget?.code ?? '—'}
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
                value={editLabel}
                onChange={(e) => {
                  setEditLabel(e.target.value)
                  setEditFieldError(null)
                }}
                placeholder="请输入套餐名称"
                maxLength={MAX_LABEL_LENGTH}
                className="input"
                disabled={editBusy}
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
                  value={editPlacement}
                  onChange={(e) => {
                    setEditPlacement(e.target.value)
                    setEditFieldError(null)
                  }}
                  className="input py-2 pr-8"
                  disabled={editBusy}
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
                  value={editStatus}
                  onChange={(e) => {
                    setEditStatus(e.target.value)
                    setEditFieldError(null)
                  }}
                  className="input py-2 pr-8"
                  disabled={editBusy}
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
                  value={editDurationDays}
                  onChange={(e) => {
                    setEditDurationDays(e.target.value)
                    setEditFieldError(null)
                  }}
                  placeholder={`${MIN_DURATION_DAYS}-${MAX_DURATION_DAYS}`}
                  className="input"
                  disabled={editBusy}
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
                  value={editPricePoints}
                  onChange={(e) => {
                    setEditPricePoints(e.target.value)
                    setEditFieldError(null)
                  }}
                  placeholder="正整数"
                  className="input"
                  disabled={editBusy}
                />
              </div>
              <div>
                <label
                  htmlFor="package-edit-sort"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  排序
                </label>
                <input
                  id="package-edit-sort"
                  type="text"
                  inputMode="numeric"
                  value={editSortOrder}
                  onChange={(e) => {
                    setEditSortOrder(e.target.value)
                    setEditFieldError(null)
                  }}
                  placeholder={`${MIN_SORT_ORDER} 到 ${MAX_SORT_ORDER} 的整数`}
                  className="input"
                  disabled={editBusy}
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
                value={editDescription}
                onChange={(e) => {
                  setEditDescription(e.target.value)
                  setEditFieldError(null)
                }}
                rows={3}
                maxLength={MAX_DESCRIPTION_LENGTH}
                placeholder="请输入套餐说明（可为空，不超过 1000 字）"
                className="input resize-y"
                disabled={editBusy}
              />
            </div>
            {editFieldError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {editFieldError}
              </div>
            )}
            {editSubmitError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {editSubmitError}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm"
                disabled={editBusy}
                onClick={() => setEditOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={editBusy}
                onClick={() => void handleEditSubmit()}
              >
                {editBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认保存'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
