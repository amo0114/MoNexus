/**
 * CategoryApplicationPanel (T-CAT-FE-003) — merchant category application UI
 * (SPEC-CATALOG-OPS-001 §7.3; D-CAT-10; REQ-CAT-F-008).
 *
 * The merchant can:
 *   - create a new pending application (proposedLabel / proposedCode /
 *     description / exampleProducts — ownership is derived server-side from
 *     auth, never sent in the body);
 *   - view the status of every own application (pagination + status filter);
 *   - withdraw a pending application (CAS, D-CAT-10 → AC-CAT-012).
 *
 * UX/contract guarantees:
 *   - double-submit disabled via a single busy flag (CHK-UI-005);
 *   - conflicts surface the stable CATEGORY_APPLICATION_PENDING_DUPLICATE /
 *     CATEGORY_APPLICATION_ALREADY_REVIEWED codes with stable copy
 *     (never prose), and the list refreshes after a race;
 *   - pagination + filter state is preserved across mutations;
 *   - no internal fields rendered (normalizedLabel/reviewedByUserId are not
 *     part of the DTO allowlist — REQ-CAT-NF-005);
 *   - no notification event is emitted on this flow (D-CAT-24).
 *
 * Host wiring is deferred (T-CAT-INT-001): this panel is self-contained and
 * takes an injectable adapter.
 */
import { useEffect, useState } from 'react'
import { FilePlus2, Loader2, Send, Undo2, Inbox } from 'lucide-react'
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
} from '../../types/catalogGovernance'
import {
  CATEGORY_APPLICATION_STATUS,
  type CategoryApplicationDto,
  type CategoryApplicationStatus,
} from '../../types/catalog'

const PAGE_SIZE = 10

/* ------------------------------------------------------------------ *
 * Create-application dialog
 * ------------------------------------------------------------------ */

interface ApplicationFormState {
  proposedLabel: string
  proposedCode: string
  description: string
  exampleProducts: string
}

const EMPTY_APPLICATION_FORM: ApplicationFormState = {
  proposedLabel: '',
  proposedCode: '',
  description: '',
  exampleProducts: '',
}

function validateApplicationForm(form: ApplicationFormState): Partial<Record<keyof ApplicationFormState, string>> {
  const errors: Partial<Record<keyof ApplicationFormState, string>> = {}
  if (!form.proposedLabel.trim()) errors.proposedLabel = '分类名称不能为空'
  else if (form.proposedLabel.trim().length > 50) errors.proposedLabel = '分类名称最多 50 字'
  if (form.proposedCode.trim().length > 64) errors.proposedCode = '建议编码最多 64 个字符'
  else if (form.proposedCode.trim() && !/^[A-Za-z0-9_-]+$/.test(form.proposedCode.trim())) {
    errors.proposedCode = '建议编码只能包含字母、数字、- 或 _'
  }
  const desc = form.description.trim()
  if (!desc) errors.description = '分类描述不能为空'
  else if (desc.length < 20) errors.description = '分类描述至少 20 字'
  else if (desc.length > 1000) errors.description = '分类描述最多 1000 字'
  if (form.exampleProducts.trim().length > 1000) errors.exampleProducts = '示例商品最多 1000 字'
  return errors
}

export interface CategoryApplicationPanelProps {
  /** Injectable governance adapter (production default = shared client). */
  adapter?: CatalogGovernanceAdapter
}

export default function CategoryApplicationPanel({ adapter = catalogGovernanceApi }: CategoryApplicationPanelProps) {
  const showToast = useAppStore((s) => s.showToast)

  const [items, setItems] = useState<CategoryApplicationDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<CategoryApplicationStatus | ''>('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState<ApplicationFormState>(EMPTY_APPLICATION_FORM)
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof ApplicationFormState, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const [withdrawTarget, setWithdrawTarget] = useState<CategoryApplicationDto | null>(null)

  /** Single busy flag — double-submit disabled for every mutation (CHK-UI-005). */
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    adapter
      .listMyApplications({ status: status || undefined, page, pageSize: PAGE_SIZE })
      .then((data) => {
        if (cancelled) return
        setItems(data.items)
        setTotal(data.total)
        if (data.items.length === 0 && data.page > 1) {
          setPage((p) => Math.max(1, p - 1))
          return
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        showToast(getApiErrorMessage(err, '加载申请列表失败'), 'error')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [adapter, status, page, reload, showToast])

  function refresh() {
    setReload((x) => x + 1)
  }

  function openCreate() {
    setForm(EMPTY_APPLICATION_FORM)
    setFormErrors({})
    setFormError(null)
    setCreateOpen(true)
  }

  async function handleCreate() {
    if (busy) return
    const errors = validateApplicationForm(form)
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return
    setBusy('create')
    setFormError(null)
    try {
      await adapter.createApplication({
        proposedLabel: form.proposedLabel.trim(),
        proposedCode: form.proposedCode.trim() || undefined,
        description: form.description.trim(),
        exampleProducts: form.exampleProducts.trim() || undefined,
      })
      showToast('分类申请已提交，等待平台审核')
      setCreateOpen(false)
      refresh()
    } catch (err: unknown) {
      // Pending duplicate / any other stable code shown as-is; dialog stays open.
      setFormError(getCatalogGovernanceErrorMessage(err, '提交申请失败'))
      showToast(getCatalogGovernanceErrorMessage(err, '提交申请失败'), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function handleWithdraw(target: CategoryApplicationDto) {
    if (busy) return
    setBusy(`withdraw-${target.id}`)
    try {
      await adapter.withdrawApplication(target.id)
      showToast('申请已撤回')
      setWithdrawTarget(null)
      refresh()
    } catch (err: unknown) {
      if (isCategoryApplicationAlreadyReviewed(err)) {
        showToast('该申请已被审核或已撤回，无法撤回', 'error')
        setWithdrawTarget(null)
        refresh()
      } else {
        showToast(getCatalogGovernanceErrorMessage(err, '撤回申请失败'), 'error')
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="category-application-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Inbox className="w-5 h-5 text-[var(--color-primary)]" />
          <h2 className="font-heading text-lg font-semibold text-[var(--color-text)]" id="merchant-application-heading">
            我的分类申请
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="merchant-app-filter" className="text-sm text-[var(--color-text-muted)] whitespace-nowrap">
              状态筛选
            </label>
            <select
              id="merchant-app-filter"
              data-testid="merchant-application-status-filter"
              className="input py-2 pr-8 cursor-pointer"
              value={status}
              onChange={(e) => { setStatus(e.target.value as CategoryApplicationStatus | ''); setPage(1) }}
            >
              <option value="">全部</option>
              {(Object.values(CATEGORY_APPLICATION_STATUS) as CategoryApplicationStatus[]).map((s) => (
                <option key={s} value={s}>{CATEGORY_APPLICATION_STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            data-testid="merchant-application-create"
            disabled={busy !== null}
            onClick={openCreate}
          >
            <FilePlus2 className="w-4 h-4 inline-block mr-1" />
            申请新分类
          </button>
        </div>
      </div>

      <p className="text-sm text-[var(--color-text-muted)]">
        申请新分类前，请先确认现有分类中没有等价分类；申请审核通过后平台会新建或映射到现有分类。
      </p>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] overflow-hidden">
        {loading ? (
          <div className="p-4"><TableSkeleton rows={5} /></div>
        ) : items.length === 0 ? (
          <EmptyState icon={Inbox} title="暂无申请" description="点击右上角「申请新分类」提交你的第一个分类申请。" compact />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">申请名称</th>
                <th scope="col">状态</th>
                <th scope="col">审核结果</th>
                <th scope="col" className="w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} data-testid={`application-row-${a.id}`} data-status={a.status}>
                  <td>
                    <div className="font-semibold text-[var(--color-text)]">
                      {a.proposedLabel}
                      {a.proposedCode && <span className="font-mono text-xs text-[var(--color-text-muted)] ml-2">（{a.proposedCode}）</span>}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5 line-clamp-2">{a.description}</div>
                  </td>
                  <td>
                    <span
                      data-testid={`application-status-${a.status}`}
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                        a.status === CATEGORY_APPLICATION_STATUS.PENDING
                          ? 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]'
                          : a.status === CATEGORY_APPLICATION_STATUS.APPROVED
                            ? 'bg-[var(--color-success)]/10 text-[var(--color-success)]'
                            : 'bg-[var(--color-muted)]/20 text-[var(--color-text-muted)]'
                      }`}
                    >
                      {CATEGORY_APPLICATION_STATUS_LABEL[a.status]}
                    </span>
                  </td>
                  <td>
                    {a.status === CATEGORY_APPLICATION_STATUS.PENDING ? (
                      <span className="text-sm text-[var(--color-text-muted)]">等待平台审核</span>
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
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        data-testid={`application-withdraw-${a.id}`}
                        disabled={busy !== null}
                        onClick={() => setWithdrawTarget(a)}
                      >
                        <Undo2 className="w-3.5 h-3.5 inline-block mr-1" />
                        撤回
                      </button>
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
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        testId="merchant-application-pagination"
      />

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!busy) setCreateOpen(o) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>申请新分类</DialogTitle>
          <DialogDescription>
            申请需平台审核；提交前请确认现有分类中没有等价分类。申请不会自动创建分类。
          </DialogDescription>
          <div className="grid gap-4 mt-4">
            <div>
              <label htmlFor="app-label" className="block text-sm font-semibold mb-1">分类名称 *</label>
              <input
                id="app-label"
                data-testid="application-form-label"
                className="input"
                value={form.proposedLabel}
                onChange={(e) => setForm((f) => ({ ...f, proposedLabel: e.target.value }))}
                disabled={busy !== null}
                aria-invalid={formErrors.proposedLabel ? true : undefined}
              />
              {formErrors.proposedLabel && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{formErrors.proposedLabel}</p>}
            </div>
            <div>
              <label htmlFor="app-code" className="block text-sm font-semibold mb-1">建议编码（可选）</label>
              <input
                id="app-code"
                data-testid="application-form-code"
                className="input font-mono"
                value={form.proposedCode}
                onChange={(e) => setForm((f) => ({ ...f, proposedCode: e.target.value }))}
                placeholder="如 cloud-tool（仅建议，平台可调整）"
                disabled={busy !== null}
              />
              {formErrors.proposedCode && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{formErrors.proposedCode}</p>}
            </div>
            <div>
              <label htmlFor="app-desc" className="block text-sm font-semibold mb-1">分类描述 *（至少 20 字）</label>
              <textarea
                id="app-desc"
                data-testid="application-form-description"
                className="input min-h-[80px] resize-y"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                disabled={busy !== null}
                aria-invalid={formErrors.description ? true : undefined}
              />
              {formErrors.description && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{formErrors.description}</p>}
            </div>
            <div>
              <label htmlFor="app-example" className="block text-sm font-semibold mb-1">示例商品（可选）</label>
              <textarea
                id="app-example"
                data-testid="application-form-example"
                className="input min-h-[60px] resize-y"
                value={form.exampleProducts}
                onChange={(e) => setForm((f) => ({ ...f, exampleProducts: e.target.value }))}
                disabled={busy !== null}
              />
              {formErrors.exampleProducts && <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">{formErrors.exampleProducts}</p>}
            </div>
            {formError && (
              <p role="alert" data-testid="application-form-error" className="text-sm text-[var(--color-danger)]">{formError}</p>
            )}
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button type="button" className="btn-secondary px-4 py-2 text-sm" disabled={busy !== null} onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary px-4 py-2 text-sm min-w-[120px]"
              data-testid="application-form-submit"
              disabled={busy !== null}
              onClick={() => void handleCreate()}
            >
              {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : (
                <>
                  <Send className="w-4 h-4 inline-block mr-1" />
                  提交申请
                </>
              )}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Withdraw confirm */}
      <ConfirmDialog
        open={withdrawTarget !== null}
        onOpenChange={(o) => { if (!busy) setWithdrawTarget(o ? withdrawTarget : null) }}
        title="撤回分类申请"
        description={`确定撤回「${withdrawTarget?.proposedLabel ?? ''}」的申请？撤回后管理员不能再审核该申请。`}
        confirmLabel="撤回"
        tone="danger"
        loading={busy !== null}
        onConfirm={() => { if (withdrawTarget) void handleWithdraw(withdrawTarget) }}
      />
    </div>
  )
}
