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
import { useEffect, useState, useRef } from 'react'
import { ChevronDown, ChevronUp, FolderTree, Inbox, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import ConfirmDialog from '../ui/ConfirmDialog'
import AdminPagination from '../admin/AdminPagination'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'
import CategoryFormDialog from './categoryManager/CategoryFormDialog'
import ReviewDialog from './categoryManager/ReviewDialog'
import ReorderList from './categoryManager/ReorderList'
import CategoryStatusBadge from './categoryManager/CategoryStatusBadge'
import type { CategoryFormState, ReviewMode } from './categoryManager/types'
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
} from '../../types/catalog'

const PAGE_SIZE = 10
const MAX_REORDER_IDS = 500


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
                  <th scope="col">展示顺序</th>
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
