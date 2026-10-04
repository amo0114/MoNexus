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
// This module owns the list lane: filters, pagination, the request/refresh
// cycle, the adapter, the status mapping, failure handling and the
// success feedback. The two dialogs live in ./editorialManager/ and own their
// own form state, validation and date conversion.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Ban, Bookmark, Plus } from 'lucide-react'
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
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'
import EditorialFormDialog from './editorialManager/EditorialFormDialog'
import RevokeEditorialDialog from './editorialManager/RevokeEditorialDialog'

const PAGE_SIZE = 10

/** Safe date formatting: unparseable input is shown verbatim. */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
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

  // Create/edit dialog identity (one shared form; edit pre-fills it). The form
  // fields themselves live inside EditorialFormDialog.
  const [formOpen, setFormOpen] = useState(false)
  const [editingFeature, setEditingFeature] = useState<AdminEditorialFeatureDTO | null>(null)

  // Revoke dialog identity; the reason field lives inside RevokeEditorialDialog.
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<AdminEditorialFeatureDTO | null>(null)

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

  // Opening a dialog only publishes the target; the dialog builds a fresh form.
  const openCreateDialog = () => {
    setEditingFeature(null)
    setFormOpen(true)
  }

  const openEditDialog = (feature: AdminEditorialFeatureDTO) => {
    setEditingFeature(feature)
    setFormOpen(true)
  }

  /**
   * Create/update submitted from the dialog. Errors propagate to the dialog so
   * it can render the server message and stay open; success closes the dialog,
   * reports status and refreshes the current filter/page.
   */
  const handleFormCreate = async (payload: AdminEditorialCreatePayload) => {
    await adapter.createFeature(payload)
    setFormOpen(false)
    setEditingFeature(null)
    setFeedback({ kind: 'success', text: '新建精选成功。' })
    void load()
  }

  const handleFormUpdate = async (id: number, payload: AdminEditorialUpdatePayload) => {
    await adapter.updateFeature(id, payload)
    setFormOpen(false)
    setEditingFeature(null)
    setFeedback({ kind: 'success', text: '更新精选成功。' })
    void load()
  }

  const openRevokeDialog = (feature: AdminEditorialFeatureDTO) => {
    setRevokeTarget(feature)
    setRevokeOpen(true)
  }

  /**
   * Revoke submitted from the dialog. Errors propagate to the dialog so it can
   * render the server message and stay open; success closes the dialog,
   * reports status and refreshes the current filter/page.
   */
  const handleRevokeConfirm = async (reason: string) => {
    const target = revokeTarget
    if (target == null) return
    await adapter.revokeFeature(target.id, reason)
    setRevokeOpen(false)
    setRevokeTarget(null)
    setFeedback({ kind: 'success', text: `已撤销“${target.productName}”的精选。` })
    void load()
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
                    <th className="px-3 py-2">
                      排序权重
                      <span className="text-[11px] font-normal text-[var(--color-text-muted)] ml-1">（越大越前）</span>
                    </th>
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

      <EditorialFormDialog
        open={formOpen}
        feature={editingFeature}
        onOpenChange={setFormOpen}
        submit={{
          onCreate: handleFormCreate,
          onUpdate: handleFormUpdate,
          onFailure: (error, feature) =>
            getApiErrorMessage(
              error,
              feature == null ? '新建精选失败，请稍后重试。' : '更新精选失败，请稍后重试。',
            ),
        }}
      />

      <RevokeEditorialDialog
        open={revokeOpen}
        target={revokeTarget}
        onOpenChange={setRevokeOpen}
        submit={{
          onConfirm: handleRevokeConfirm,
          onFailure: (error) => getApiErrorMessage(error, '撤销失败，请稍后重试。'),
        }}
      />
    </section>
  )
}
