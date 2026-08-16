// AdminEditorialManager — admin-only management of platform editorial (平台精选)
// features (SPEC-MERCH-001 §5.5 admin lane).
//
// The frozen label 平台精选 is an independent editorial placement, separate from
// organic hot ranking (自然热卖) and paid promotion (推广) — it is never a
// product-quality endorsement. This admin view is the only place the internal
// `internalReason` is surfaced; the internal audit fields (createdByUserId /
// revokedByUserId) are never rendered here.
//
// The server remains authoritative: the client only applies UX-level validation
// on top (positive product id, two placement enums, parseable start/end with
// endsAt strictly later than startsAt and later than now, integer sortWeight in
// [-100000, 100000], trimmed publicReason ≤120 → null when empty, trimmed
// internalReason 1..500) before submitting the frozen payloads.
//
// Timezone: ISO ↔ datetime-local conversion always uses the browser's local
// timezone (the datetime-local input holds local wall-clock time). An
// unparseable edit date is never silently submitted — it is surfaced as an
// error when the dialog opens and blocks submission until corrected.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Ban, Bookmark, Loader2, Lock, Plus, ShieldAlert } from 'lucide-react'
import { getApiErrorMessage } from '../../api/error'
import {
  createAdminEditorialFeature,
  listAdminEditorialFeatures,
  revokeAdminEditorialFeature,
  updateAdminEditorialFeature,
  type AdminEditorialFeatureQuery,
} from '../../api/merchandising'
import type {
  AdminEditorialCreatePayload,
  AdminEditorialFeatureDTO,
  AdminEditorialUpdatePayload,
  EditorialPlacement,
  EditorialStatus,
} from '../../types/merchandising'
import AdminPagination from '../admin/AdminPagination'
import AdminProductSearchSelect from './AdminProductSearchSelect'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'

const PAGE_SIZE = 10
const MAX_PUBLIC_REASON_LENGTH = 120
const MAX_INTERNAL_REASON_LENGTH = 500
const MIN_SORT_WEIGHT = -100000
const MAX_SORT_WEIGHT = 100000
const DEFAULT_SORT_WEIGHT = 0

/** Positive integer (no sign, no decimals, no leading zeros). */
const POSITIVE_INTEGER = /^[1-9]\d*$/
/** Integer, optionally negative (no decimals, no exponent notation). */
const INTEGER = /^-?\d+$/

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

/** Safe date formatting: unparseable input is shown verbatim. */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
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

/** Real adapter — passthrough to the frozen admin editorial API. */
export interface AdminEditorialAdapter {
  listFeatures: typeof listAdminEditorialFeatures
  createFeature: typeof createAdminEditorialFeature
  updateFeature: typeof updateAdminEditorialFeature
  revokeFeature: typeof revokeAdminEditorialFeature
}

const DEFAULT_ADAPTER: AdminEditorialAdapter = {
  listFeatures: listAdminEditorialFeatures,
  createFeature: createAdminEditorialFeature,
  updateFeature: updateAdminEditorialFeature,
  revokeFeature: revokeAdminEditorialFeature,
}

export interface AdminEditorialManagerProps {
  adapter?: AdminEditorialAdapter
  className?: string
}

const STATUS_LABEL: Record<EditorialStatus, string> = {
  scheduled: '待生效',
  active: '展示中',
  revoked: '已撤销',
  expired: '已到期',
}

const PLACEMENT_LABEL: Record<EditorialPlacement, string> = {
  store_editorial: '店铺精选',
  category_editorial: '分类精选',
}

const STATUS_OPTIONS: ReadonlyArray<{ value: EditorialStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'scheduled', label: '待生效' },
  { value: 'active', label: '展示中' },
  { value: 'revoked', label: '已撤销' },
  { value: 'expired', label: '已到期' },
]

const PLACEMENT_FILTER_OPTIONS: ReadonlyArray<{ value: EditorialPlacement | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'store_editorial', label: '店铺精选' },
  { value: 'category_editorial', label: '分类精选' },
]

const PLACEMENT_SELECT_OPTIONS: ReadonlyArray<{ value: EditorialPlacement; label: string }> = [
  { value: 'store_editorial', label: '店铺精选' },
  { value: 'category_editorial', label: '分类精选' },
]

export default function AdminEditorialManager({
  adapter = DEFAULT_ADAPTER,
  className = '',
}: AdminEditorialManagerProps) {
  const [items, setItems] = useState<AdminEditorialFeatureDTO[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Applied filters — changed filters immediately reset to page 1 and refetch.
  const [statusFilter, setStatusFilter] = useState<EditorialStatus | 'all'>('all')
  const [placementFilter, setPlacementFilter] = useState<EditorialPlacement | 'all'>('all')

  // Non-error feedback (create/update/revoke success) — rendered with role=status.
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // Create/edit dialog state (one shared form; edit pre-fills it).
  const [formOpen, setFormOpen] = useState(false)
  const [editingFeature, setEditingFeature] = useState<AdminEditorialFeatureDTO | null>(null)
  const [formProductId, setFormProductId] = useState('')
  const [formPlacement, setFormPlacement] = useState<EditorialPlacement>('store_editorial')
  const [formStartsAt, setFormStartsAt] = useState('')
  const [formEndsAt, setFormEndsAt] = useState('')
  const [formSortWeight, setFormSortWeight] = useState(String(DEFAULT_SORT_WEIGHT))
  const [formPublicReason, setFormPublicReason] = useState('')
  const [formInternalReason, setFormInternalReason] = useState('')
  const [formFieldError, setFormFieldError] = useState<string | null>(null)
  const [formSubmitError, setFormSubmitError] = useState<string | null>(null)
  const [formBusy, setFormBusy] = useState(false)

  // Revoke dialog state.
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<AdminEditorialFeatureDTO | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [revokeFieldError, setRevokeFieldError] = useState<string | null>(null)
  const [revokeSubmitError, setRevokeSubmitError] = useState<string | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)

  // Strictly-increasing request id: a stale list response must never overwrite
  // a newer filter/page result (concurrency guard).
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setLoadError(null)
    const query: AdminEditorialFeatureQuery = {
      status: statusFilter,
      placement: placementFilter,
      page,
      pageSize: PAGE_SIZE,
    }
    try {
      const data = await adapter.listFeatures(query)
      if (seq !== requestSeqRef.current) return
      setItems(data.items)
      setTotal(data.total)
    } catch (e) {
      if (seq !== requestSeqRef.current) return
      setItems([])
      setTotal(0)
      setLoadError(getApiErrorMessage(e, '精选列表加载失败，请稍后重试。'))
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [adapter, statusFilter, placementFilter, page])

  useEffect(() => {
    void load()
  }, [load])

  const handleStatusFilterChange = (value: EditorialStatus | 'all') => {
    setStatusFilter(value)
    setPage(1)
  }

  const handlePlacementFilterChange = (value: EditorialPlacement | 'all') => {
    setPlacementFilter(value)
    setPage(1)
  }

  const openCreateDialog = () => {
    // Fresh form on every open — clears stale values, field errors and
    // previous mutation errors.
    setEditingFeature(null)
    setFormProductId('')
    setFormPlacement('store_editorial')
    setFormStartsAt('')
    setFormEndsAt('')
    setFormSortWeight(String(DEFAULT_SORT_WEIGHT))
    setFormPublicReason('')
    setFormInternalReason('')
    setFormFieldError(null)
    setFormSubmitError(null)
    setFormOpen(true)
  }

  const openEditDialog = (feature: AdminEditorialFeatureDTO) => {
    // Fresh form on every open — clears stale values, field errors and
    // previous mutation errors.
    setEditingFeature(feature)
    setFormProductId(String(feature.productId))
    setFormPlacement(feature.placement)
    // ISO → datetime-local must honor the browser's local timezone; an
    // unparseable date is surfaced immediately and never silently submitted.
    const startsLocal = isoToDatetimeLocal(feature.startsAt)
    const endsLocal = isoToDatetimeLocal(feature.endsAt)
    setFormStartsAt(startsLocal ?? '')
    setFormEndsAt(endsLocal ?? '')
    setFormSortWeight(String(feature.sortWeight))
    setFormPublicReason(feature.publicReason ?? '')
    setFormInternalReason(feature.internalReason)
    const unparseable: string[] = []
    if (startsLocal == null) unparseable.push('开始时间')
    if (endsLocal == null) unparseable.push('结束时间')
    setFormFieldError(
      unparseable.length > 0
        ? `该精选的${unparseable.join('、')}无法解析，请重新选择后再保存。`
        : null,
    )
    setFormSubmitError(null)
    setFormOpen(true)
  }

  const validateForm = (): string | null => {
    if (editingFeature == null && parseSafeProductId(formProductId.trim()) == null) {
      return '请选择商品'
    }
    // placement is a controlled select limited to the two frozen enums.
    const startsIso = datetimeLocalToIso(formStartsAt)
    if (startsIso == null) return '请选择有效的开始时间'
    const endsIso = datetimeLocalToIso(formEndsAt)
    if (endsIso == null) return '请选择有效的结束时间'
    const startsMs = new Date(startsIso).getTime()
    const endsMs = new Date(endsIso).getTime()
    if (endsMs <= startsMs) return '结束时间必须晚于开始时间'
    if (endsMs <= Date.now()) return '结束时间必须晚于当前时间'
    const sortWeight = formSortWeight.trim()
    if (sortWeight !== '') {
      if (!INTEGER.test(sortWeight)) return '权重必须为整数'
      const weight = Number(sortWeight)
      if (!Number.isSafeInteger(weight)) return '权重必须为整数'
      if (weight < MIN_SORT_WEIGHT || weight > MAX_SORT_WEIGHT) {
        return `权重必须在 ${MIN_SORT_WEIGHT} 到 ${MAX_SORT_WEIGHT} 之间`
      }
    }
    if (formPublicReason.trim().length > MAX_PUBLIC_REASON_LENGTH) {
      return `公开理由不能超过 ${MAX_PUBLIC_REASON_LENGTH} 字`
    }
    const internalReason = formInternalReason.trim()
    if (internalReason.length < 1) return '请输入内部原因'
    if (internalReason.length > MAX_INTERNAL_REASON_LENGTH) {
      return `内部原因不能超过 ${MAX_INTERNAL_REASON_LENGTH} 字`
    }
    return null
  }

  const handleFormSubmit = async () => {
    if (formBusy) return
    const fieldError = validateForm()
    if (fieldError) {
      setFormFieldError(fieldError)
      return
    }
    setFormFieldError(null)
    setFormSubmitError(null)
    setFormBusy(true)
    try {
      const startsIso = datetimeLocalToIso(formStartsAt)
      const endsIso = datetimeLocalToIso(formEndsAt)
      if (startsIso == null || endsIso == null) {
        setFormFieldError('请选择有效的开始和结束时间')
        return
      }
      const sortWeightRaw = formSortWeight.trim()
      const sortWeight = sortWeightRaw === '' ? DEFAULT_SORT_WEIGHT : Number(sortWeightRaw)
      const publicReasonTrimmed = formPublicReason.trim()
      const publicReason = publicReasonTrimmed === '' ? null : publicReasonTrimmed
      const internalReason = formInternalReason.trim()
      if (editingFeature == null) {
        const productId = parseSafeProductId(formProductId.trim())
        if (productId == null) {
          setFormFieldError('请选择商品')
          return
        }
        // Exact create payload — productId always present, all fields sent.
        const payload: AdminEditorialCreatePayload = {
          productId,
          placement: formPlacement,
          startsAt: startsIso,
          endsAt: endsIso,
          sortWeight,
          publicReason,
          internalReason,
        }
        await adapter.createFeature(payload)
      } else {
        // Exact update payload — no productId, all editable fields (PATCH ≥1).
        const payload: AdminEditorialUpdatePayload = {
          placement: formPlacement,
          startsAt: startsIso,
          endsAt: endsIso,
          sortWeight,
          publicReason,
          internalReason,
        }
        await adapter.updateFeature(editingFeature.id, payload)
      }
      // Success only: close, report status, refresh the current filter/page.
      setFormOpen(false)
      setEditingFeature(null)
      setFeedback({
        kind: 'success',
        text: editingFeature == null ? '新建精选成功。' : '更新精选成功。',
      })
      void load()
    } catch (e) {
      // Failure: keep the dialog open, surface the server error, no fake success.
      setFormSubmitError(
        getApiErrorMessage(
          e,
          editingFeature == null ? '新建精选失败，请稍后重试。' : '更新精选失败，请稍后重试。',
        ),
      )
    } finally {
      setFormBusy(false)
    }
  }

  const openRevokeDialog = (feature: AdminEditorialFeatureDTO) => {
    // Fresh form on every open — clears stale reason and previous errors.
    setRevokeTarget(feature)
    setRevokeReason('')
    setRevokeFieldError(null)
    setRevokeSubmitError(null)
    setRevokeOpen(true)
  }

  const handleRevokeSubmit = async () => {
    if (revokeBusy || revokeTarget == null) return
    const reason = revokeReason.trim()
    if (reason.length < 1) {
      setRevokeFieldError('请输入撤销原因')
      return
    }
    if (reason.length > MAX_INTERNAL_REASON_LENGTH) {
      setRevokeFieldError(`撤销原因不能超过 ${MAX_INTERNAL_REASON_LENGTH} 字`)
      return
    }
    setRevokeFieldError(null)
    setRevokeSubmitError(null)
    setRevokeBusy(true)
    try {
      await adapter.revokeFeature(revokeTarget.id, reason)
      // Success only: close, report status, refresh the current filter/page.
      setRevokeOpen(false)
      setRevokeTarget(null)
      setFeedback({ kind: 'success', text: `已撤销“${revokeTarget.productName}”的精选。` })
      void load()
    } catch (e) {
      // Failure: keep the dialog open, surface the server error, no fake success.
      setRevokeSubmitError(getApiErrorMessage(e, '撤销失败，请稍后重试。'))
    } finally {
      setRevokeBusy(false)
    }
  }

  const canMutate = (status: EditorialStatus) => status === 'scheduled' || status === 'active'

  return (
    <section
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-5 ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[var(--color-text)]">平台精选管理</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            平台精选是运营独立设置的展示位，与自然热卖和推广相互独立，不代表平台对商品质量的背书；仅在管理后台可配置。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm flex items-center gap-2 shrink-0"
          onClick={openCreateDialog}
        >
          <Plus className="w-4 h-4" />
          新建精选
        </button>
      </div>

      {feedback && (
        <div
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={`mt-3 text-sm ${
            feedback.kind === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor="editorial-filter-status"
            className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
          >
            状态
          </label>
          <select
            id="editorial-filter-status"
            value={statusFilter}
            onChange={(e) => handleStatusFilterChange(e.target.value as EditorialStatus | 'all')}
            className="input py-1.5 pr-8 w-40"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="editorial-filter-placement"
            className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
          >
            展位
          </label>
          <select
            id="editorial-filter-placement"
            value={placementFilter}
            onChange={(e) =>
              handlePlacementFilterChange(e.target.value as EditorialPlacement | 'all')
            }
            className="input py-1.5 pr-8 w-40"
          >
            {PLACEMENT_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
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
        ) : items.length === 0 ? (
          <EmptyState
            icon={Bookmark}
            title="暂无精选记录"
            description="当前筛选条件下没有匹配的平台精选，可调整筛选条件或新建精选。"
            compact
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="平台精选列表">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-muted)]">
                    <th className="px-3 py-2">商品</th>
                    <th className="px-3 py-2">展位</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">起止时间</th>
                    <th className="px-3 py-2">权重</th>
                    <th className="px-3 py-2">公开理由</th>
                    <th className="px-3 py-2">内部原因</th>
                    <th className="px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {items.map((feature) => (
                    <tr key={feature.id}>
                      <td className="px-3 py-3">
                        <span className="font-medium">{feature.productName}</span>
                        <details className="mt-1 text-xs text-[var(--color-text-muted)]">
                          <summary className="cursor-pointer w-fit">技术详情</summary>
                          <div><code>Product ID: {feature.productId}</code></div>
                          <div><code>精选 ID: {feature.id}</code></div>
                        </details>
                      </td>
                      <td className="px-3 py-3">
                        {PLACEMENT_LABEL[feature.placement] ?? feature.placement}
                      </td>
                      <td className="px-3 py-3">{STATUS_LABEL[feature.status] ?? feature.status}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <span>
                            <span className="text-[var(--color-text-muted)]">开始</span>{' '}
                            <time dateTime={feature.startsAt}>{formatDateTime(feature.startsAt)}</time>
                          </span>
                          <span>
                            <span className="text-[var(--color-text-muted)]">结束</span>{' '}
                            <time dateTime={feature.endsAt}>{formatDateTime(feature.endsAt)}</time>
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3">{feature.sortWeight}</td>
                      <td className="px-3 py-3">{feature.publicReason || '—'}</td>
                      <td className="px-3 py-3">{feature.internalReason || '—'}</td>
                      <td className="px-3 py-3">
                        {canMutate(feature.status) ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              aria-label={`编辑“${feature.productName}”的精选`}
                              className="btn-secondary btn-sm"
                              onClick={() => openEditDialog(feature)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              aria-label={`撤销“${feature.productName}”的精选`}
                              className="btn-secondary btn-sm border-[var(--color-danger)] text-[var(--color-danger)]"
                              onClick={() => openRevokeDialog(feature)}
                            >
                              <Ban className="w-3.5 h-3.5" />
                              撤销
                            </button>
                          </div>
                        ) : (
                          <span className="text-[var(--color-text-muted)]">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AdminPagination
              page={page}
              total={total}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
              testId="admin-editorial-pagination"
            />
          </>
        )}
      </div>

      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          if (!open && formBusy) return
          setFormOpen(open)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogTitle>{editingFeature == null ? '新建精选' : '编辑精选'}</DialogTitle>
          <DialogDescription>
            {editingFeature == null
              ? '为指定商品设置一个平台精选展示位，独立于自然热卖与推广。'
              : `正在编辑“${editingFeature.productName}”的平台精选。`}
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
                value={formProductId.trim() ? Number(formProductId) : null}
                onChange={(id) => { setFormProductId(id == null ? '' : String(id)); setFormFieldError(null) }}
                disabled={formBusy}
                readOnly={editingFeature != null}
                inputId="editorial-form-product"
                labelledBy="editorial-form-product-label"
                testId="editorial-form-product"
              />
              {editingFeature != null && (
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
                value={formPlacement}
                onChange={(e) => {
                  setFormPlacement(e.target.value as EditorialPlacement)
                  setFormFieldError(null)
                }}
                className="input py-2 pr-8"
                disabled={formBusy}
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
                  value={formStartsAt}
                  onChange={(e) => {
                    setFormStartsAt(e.target.value)
                    setFormFieldError(null)
                  }}
                  className="input"
                  disabled={formBusy}
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
                  value={formEndsAt}
                  onChange={(e) => {
                    setFormEndsAt(e.target.value)
                    setFormFieldError(null)
                  }}
                  className="input"
                  disabled={formBusy}
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="editorial-form-sort-weight"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                权重
              </label>
              <input
                id="editorial-form-sort-weight"
                type="number"
                step="1"
                min={MIN_SORT_WEIGHT}
                max={MAX_SORT_WEIGHT}
                value={formSortWeight}
                onChange={(e) => {
                  setFormSortWeight(e.target.value)
                  setFormFieldError(null)
                }}
                placeholder={`${MIN_SORT_WEIGHT} 到 ${MAX_SORT_WEIGHT} 的整数`}
                className="input"
                disabled={formBusy}
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
                value={formPublicReason}
                onChange={(e) => {
                  setFormPublicReason(e.target.value)
                  setFormFieldError(null)
                }}
                rows={3}
                maxLength={MAX_PUBLIC_REASON_LENGTH}
                placeholder="请输入对外展示的公开理由（不超过 120 字）"
                className="input resize-y"
                disabled={formBusy}
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
                value={formInternalReason}
                onChange={(e) => {
                  setFormInternalReason(e.target.value)
                  setFormFieldError(null)
                }}
                rows={3}
                maxLength={MAX_INTERNAL_REASON_LENGTH}
                placeholder="请输入内部原因（1 到 500 字）"
                className="input resize-y"
                disabled={formBusy}
              />
            </div>
            {formFieldError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {formFieldError}
              </div>
            )}
            {formSubmitError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {formSubmitError}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm"
                disabled={formBusy}
                onClick={() => setFormOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={formBusy}
                onClick={() => void handleFormSubmit()}
              >
                {formBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : editingFeature == null ? '确认新建' : '确认保存'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeOpen}
        onOpenChange={(open) => {
          if (!open && revokeBusy) return
          setRevokeOpen(open)
        }}
      >
        <DialogContent className="max-w-md">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-[var(--color-danger)]/10 text-[var(--color-danger)] flex items-center justify-center shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle>撤销精选</DialogTitle>
              <DialogDescription>
                确认撤销“{revokeTarget?.productName ?? '该商品'}”的平台精选？撤销后该展示位立即失效。
              </DialogDescription>
            </div>
          </div>
          <div className="space-y-4 mt-4">
            <div>
              <label
                htmlFor="revoke-reason"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                撤销原因
              </label>
              <textarea
                id="revoke-reason"
                value={revokeReason}
                onChange={(e) => {
                  setRevokeReason(e.target.value)
                  setRevokeFieldError(null)
                }}
                rows={3}
                maxLength={MAX_INTERNAL_REASON_LENGTH}
                placeholder="请输入撤销原因（1 到 500 字）"
                className="input resize-y"
                disabled={revokeBusy}
              />
            </div>
            {revokeFieldError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {revokeFieldError}
              </div>
            )}
            {revokeSubmitError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {revokeSubmitError}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm"
                disabled={revokeBusy}
                onClick={() => setRevokeOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm border-[var(--color-danger)] text-[var(--color-danger)]"
                disabled={revokeBusy}
                onClick={() => void handleRevokeSubmit()}
              >
                {revokeBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认撤销'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
