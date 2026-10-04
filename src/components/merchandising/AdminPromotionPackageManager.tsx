// T-MERCH-FE-003 — AdminPromotionPackageManager: admin-only view of promotion
// packages (SPEC-MERCH-001 §11 admin lane): a list shell with the “包含停用套餐”
// includeInactive toggle and a per-row “编辑” action.
//
// Structure: this component keeps the list lane only — the package list, the
// strictly-increasing request-id guard, the includeInactive filter and its
// request orchestration, the loading / error / empty rendering, the row
// 编辑 trigger and the shared success feedback. The two dialogs live in
// ./packageManager and own their own forms:
//   - CreatePackageDialog submits the frozen AdminPromotionPackageCreatePayload
//     (code / label / placement / durationDays / pricePoints / description /
//     sortOrder) and never sends status / id / timestamps.
//   - EditPackageDialog prefills from the DTO, shows the immutable code
//     read-only and submits the frozen AdminPromotionPackageUpdatePayload
//     (label / placement / durationDays / pricePoints / description /
//     sortOrder / status) — active/inactive status is managed inside that
//     dialog only, with no separate quick toggle, so there is a single
//     mutation owner. The update payload never contains code / id /
//     createdAt / updatedAt.
// The parent reaches both dialogs through imperative refs, so opening either
// one still resets its form synchronously and never remounts it.
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
// and edit are guarded against double-submit inside their dialogs, which keep
// the dialog open on failure for retry, and only close + refresh the current
// query on real success.


import { useCallback, useEffect, useRef, useState } from 'react'
import { PackageSearch, Plus } from 'lucide-react'
import { getApiErrorMessage } from '../../api/error'
import {
  createAdminPromotionPackage,
  listAdminPromotionPackages,
  updateAdminPromotionPackage,
} from '../../api/merchandising'
import type { AdminPromotionPackageDTO, PackageStatus } from '../../types/merchandising'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'
import CreatePackageDialog, {
  type CreatePackageDialogHandle,
} from './packageManager/CreatePackageDialog'
import EditPackageDialog, {
  type EditPackageDialogHandle,
} from './packageManager/EditPackageDialog'
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
export default function AdminPromotionPackageManager({
  adapter = DEFAULT_ADAPTER,
  className = '',
}: AdminPromotionPackageManagerProps) {
  const [packages, setPackages] = useState<AdminPromotionPackageDTO[]>([])
  const [includeInactive, setIncludeInactive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Non-error feedback (create / edit success) — rendered with role=status.
  const [feedback, setFeedback] = useState<string | null>(null)

  // Both dialogs own their form state; opening them through these handles keeps
  // the previous synchronous reset-and-prefill behavior without a remount.
  const createDialogRef = useRef<CreatePackageDialogHandle>(null)
  const editDialogRef = useRef<EditPackageDialogHandle>(null)

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
    createDialogRef.current?.open()
  }

  const openEditDialog = (pkg: AdminPromotionPackageDTO) => {
    editDialogRef.current?.open(pkg)
  }

  // Success callbacks only: report the status and refresh the current query.
  // The dialogs close themselves before calling these.
  const handleCreated = () => {
    setFeedback('套餐创建成功。')
    void load()
  }

  const handleUpdated = () => {
    setFeedback('套餐更新成功。')
    void load()
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
                  <th className="px-3 py-2">套餐名称</th>
                  <th className="px-3 py-2">展位与时长</th>
                  <th className="px-3 py-2">价格（积分）</th>
                  <th className="px-3 py-2">
                    展示顺序
                    <span className="text-[11px] font-normal text-[var(--color-text-muted)] ml-1">（越小越前）</span>
                  </th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {packages.map((pkg) => (
                  <tr key={pkg.id}>
                    <td className="px-3 py-3">
                      <div className="font-medium">{pkg.label}</div>
                      <div className="font-mono text-xs text-[var(--color-text-muted)] mt-0.5">{pkg.code}</div>
                      <details className="mt-1 text-xs text-[var(--color-text-muted)]">
                        <summary className="cursor-pointer select-none text-[var(--color-primary)] hover:underline">详情与时间</summary>
                        <div className="mt-1 space-y-1">
                          <div>说明：<span>{pkg.description || '—'}</span></div>
                          <div>
                            <span className="text-[var(--color-text-muted)]">创建</span>{' '}
                            <time dateTime={pkg.createdAt}>{formatDateTime(pkg.createdAt)}</time>
                          </div>
                          <div>
                            <span className="text-[var(--color-text-muted)]">更新</span>{' '}
                            <time dateTime={pkg.updatedAt}>{formatDateTime(pkg.updatedAt)}</time>
                          </div>
                        </div>
                      </details>
                    </td>
                    <td className="px-3 py-3">
                      <div>{PLACEMENT_LABEL[pkg.placement] ?? pkg.placement}</div>
                      <div className="text-xs text-[var(--color-text-muted)]">{pkg.durationDays} 天</div>
                    </td>
                    <td className="px-3 py-3">{pkg.pricePoints}</td>
                    <td className="px-3 py-3">{pkg.sortOrder}</td>
                    <td className="px-3 py-3">{PACKAGE_STATUS_LABEL[pkg.status] ?? pkg.status}</td>
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

      <CreatePackageDialog
        ref={createDialogRef}
        createPackage={adapter.createPackage}
        onCreated={handleCreated}
      />

      <EditPackageDialog
        ref={editDialogRef}
        updatePackage={adapter.updatePackage}
        onUpdated={handleUpdated}
      />
    </section>
  )
}
