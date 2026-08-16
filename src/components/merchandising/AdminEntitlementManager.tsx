// T-MERCH-FE-003 — AdminEntitlementManager: admin-only view of merchant
// partner entitlements (SPEC-MERCH-001 §5.6 admin lane).
//
// The frozen label 平台合作伙伴 is a *limited-time commercial cooperation*
// signal — never a certification or guarantee. This admin view is the only
// place the internal `reason` is surfaced; the internal audit fields
// (sourceRef / grantedByUserId / revokedByUserId) are never rendered here.
//
// The server remains authoritative: the client only applies UX-level
// validation on top (positive merchant id, validUntil strictly in the
// next 365 days, trimmed reason 1..500) before submitting the frozen payload
// { merchantId, validUntil (ISO), reason }.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Ban, ClipboardList, Loader2, Plus, ShieldAlert } from 'lucide-react'
import { getApiErrorMessage } from '../../api/error'
import {
  grantAdminMerchantEntitlement,
  listAdminMerchantEntitlements,
  revokeAdminMerchantEntitlement,
  type AdminMerchantEntitlementQuery,
} from '../../api/merchandising'
import type {
  AdminMerchantEntitlementDTO,
  AdminMerchantEntitlementGrantPayload,
  EntitlementSource,
  EntitlementStatus,
} from '../../types/merchandising'
import AdminPagination from '../admin/AdminPagination'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'

const PAGE_SIZE = 10
const MAX_REASON_LENGTH = 500
const MAX_GRANT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000

/** Positive integer (no sign, no decimals, no leading zeros). */
const POSITIVE_INTEGER = /^[1-9]\d*$/

/**
 * Parse a merchant id that is safe to send as a JS number: must be a
 * positive integer (POSITIVE_INTEGER) whose numeric value stays within
 * the JS safe-integer range. Returns null instead of a distorted number
 * so callers can surface their existing “必须为空或正整数” / “必须为正整数” errors.
 */
function parseSafeMerchantId(trimmed: string): number | null {
  if (!POSITIVE_INTEGER.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) return null
  return value
}

export interface AdminEntitlementAdapter {
  listEntitlements: typeof listAdminMerchantEntitlements
  grantEntitlement: typeof grantAdminMerchantEntitlement
  revokeEntitlement: typeof revokeAdminMerchantEntitlement
}

const DEFAULT_ADAPTER: AdminEntitlementAdapter = {
  listEntitlements: listAdminMerchantEntitlements,
  grantEntitlement: grantAdminMerchantEntitlement,
  revokeEntitlement: revokeAdminMerchantEntitlement,
}

const STATUS_LABEL: Record<EntitlementStatus, string> = {
  active: '有效',
  expired: '已到期',
  revoked: '已撤销',
}

const SOURCE_LABEL: Record<EntitlementSource, string> = {
  promotion_spend: '推广消费自动授予',
  admin_grant: '管理员手工授予',
}

const STATUS_OPTIONS: ReadonlyArray<{ value: EntitlementStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '有效' },
  { value: 'expired', label: '已到期' },
  { value: 'revoked', label: '已撤销' },
]

/** Safe date formatting: unparseable input is shown verbatim. */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

export interface AdminEntitlementManagerProps {
  adapter?: AdminEntitlementAdapter
  className?: string
}

export default function AdminEntitlementManager({
  adapter = DEFAULT_ADAPTER,
  className = '',
}: AdminEntitlementManagerProps) {
  const [items, setItems] = useState<AdminMerchantEntitlementDTO[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Draft filter values — editable, applied only on 查询.
  const [draftMerchantId, setDraftMerchantId] = useState('')
  const [draftStatus, setDraftStatus] = useState<EntitlementStatus | 'all'>('all')
  const [filterError, setFilterError] = useState<string | null>(null)

  // Applied filter values — the only ones used to build list queries.
  const [appliedMerchantId, setAppliedMerchantId] = useState<number | null>(null)
  const [appliedStatus, setAppliedStatus] = useState<EntitlementStatus | 'all'>('all')

  // Non-error feedback (grant/revoke success) — rendered with role=status.
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // Grant dialog state.
  const [grantOpen, setGrantOpen] = useState(false)
  const [grantMerchantId, setGrantMerchantId] = useState('')
  const [grantValidUntil, setGrantValidUntil] = useState('')
  const [grantReason, setGrantReason] = useState('')
  const [grantFieldError, setGrantFieldError] = useState<string | null>(null)
  const [grantSubmitError, setGrantSubmitError] = useState<string | null>(null)
  const [grantBusy, setGrantBusy] = useState(false)

  // Revoke dialog state.
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<AdminMerchantEntitlementDTO | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [revokeFieldError, setRevokeFieldError] = useState<string | null>(null)
  const [revokeSubmitError, setRevokeSubmitError] = useState<string | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)

  // Strictly-increasing request id: a stale list response must never
  // overwrite a newer filter/page result (concurrency guard).
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setLoadError(null)
    const query: AdminMerchantEntitlementQuery = {
      status: appliedStatus,
      page,
      pageSize: PAGE_SIZE,
    }
    if (appliedMerchantId != null) query.merchantId = appliedMerchantId
    try {
      const data = await adapter.listEntitlements(query)
      if (seq !== requestSeqRef.current) return
      setItems(data.items)
      setTotal(data.total)
    } catch (e) {
      if (seq !== requestSeqRef.current) return
      setItems([])
      setTotal(0)
      setLoadError(getApiErrorMessage(e, '权益列表加载失败，请稍后重试。'))
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [adapter, appliedMerchantId, appliedStatus, page])

  useEffect(() => {
    void load()
  }, [load])

  const handleApplyFilter = () => {
    const trimmed = draftMerchantId.trim()
    const merchantId = trimmed === '' ? null : parseSafeMerchantId(trimmed)
    if (trimmed !== '' && merchantId == null) {
      setFilterError('商家 ID 必须为空或正整数')
      return
    }
    setFilterError(null)
    setAppliedMerchantId(merchantId)
    setAppliedStatus(draftStatus)
    setPage(1)
  }

  const handleResetFilter = () => {
    setDraftMerchantId('')
    setDraftStatus('all')
    setFilterError(null)
    setAppliedMerchantId(null)
    setAppliedStatus('all')
    setPage(1)
  }

  const openGrantDialog = () => {
    // Fresh form on every open — clears stale fields, field errors and
    // previous mutation errors (requirement: clear on each open).
    setGrantMerchantId('')
    setGrantValidUntil('')
    setGrantReason('')
    setGrantFieldError(null)
    setGrantSubmitError(null)
    setGrantOpen(true)
  }

  const validateGrant = (): string | null => {
    if (parseSafeMerchantId(grantMerchantId.trim()) == null) return '商家 ID 必须为正整数'
    const until = new Date(grantValidUntil).getTime()
    if (Number.isNaN(until)) return '请选择有效的到期时间'
    const now = Date.now()
    if (until <= now) return '到期时间必须晚于当前时间'
    if (until > now + MAX_GRANT_WINDOW_MS) return '到期时间不能超过当前时间后的 365 天'
    const reason = grantReason.trim()
    if (reason.length < 1) return '请输入授权原因'
    if (reason.length > MAX_REASON_LENGTH) return `授权原因不能超过 ${MAX_REASON_LENGTH} 字`
    return null
  }

  const handleGrantSubmit = async () => {
    if (grantBusy) return
    const fieldError = validateGrant()
    if (fieldError) {
      setGrantFieldError(fieldError)
      return
    }
    setGrantFieldError(null)
    setGrantSubmitError(null)
    setGrantBusy(true)
    try {
      const payload: AdminMerchantEntitlementGrantPayload = {
        merchantId: Number(grantMerchantId.trim()),
        validUntil: new Date(grantValidUntil).toISOString(),
        reason: grantReason.trim(),
      }
      await adapter.grantEntitlement(payload)
      // Success only: close, report status, refresh current filter/page.
      setGrantOpen(false)
      setFeedback({ kind: 'success', text: '手工授予成功。' })
      void load()
    } catch (e) {
      // Failure: keep the dialog open, surface the server error, no fake success.
      setGrantSubmitError(getApiErrorMessage(e, '手工授予失败，请稍后重试。'))
    } finally {
      setGrantBusy(false)
    }
  }

  const openRevokeDialog = (entitlement: AdminMerchantEntitlementDTO) => {
    // Fresh form on every open — clears stale fields, field errors and
    // previous mutation errors.
    setRevokeTarget(entitlement)
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
    if (reason.length > MAX_REASON_LENGTH) {
      setRevokeFieldError(`撤销原因不能超过 ${MAX_REASON_LENGTH} 字`)
      return
    }
    setRevokeFieldError(null)
    setRevokeSubmitError(null)
    setRevokeBusy(true)
    try {
      await adapter.revokeEntitlement(revokeTarget.id, reason)
      // Success only: close, report status, refresh current filter/page.
      setRevokeOpen(false)
      setFeedback({ kind: 'success', text: `已撤销商家 ${revokeTarget.merchantId} 的权益。` })
      void load()
    } catch (e) {
      // Failure: keep the dialog open, surface the server error, no fake success.
      setRevokeSubmitError(getApiErrorMessage(e, '撤销失败，请稍后重试。'))
    } finally {
      setRevokeBusy(false)
    }
  }

  return (
    <section
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-5 ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[var(--color-text)]">平台合作伙伴权益</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            权益为限时商业合作权益，仅用于标识平台与商家的合作关系，不代表平台对商品质量作出背书；到期或被撤销后自动失效。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm flex items-center gap-2 shrink-0"
          onClick={openGrantDialog}
        >
          <Plus className="w-4 h-4" />
          手工授予
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
            htmlFor="ent-filter-merchant-id"
            className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
          >
            商家 ID
          </label>
          <input
            id="ent-filter-merchant-id"
            type="text"
            inputMode="numeric"
            value={draftMerchantId}
            onChange={(e) => {
              setDraftMerchantId(e.target.value)
              setFilterError(null)
            }}
            placeholder="为空表示全部商家"
            className="input py-1.5 w-40"
          />
        </div>
        <div>
          <label
            htmlFor="ent-filter-status"
            className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
          >
            状态
          </label>
          <select
            id="ent-filter-status"
            value={draftStatus}
            onChange={(e) => setDraftStatus(e.target.value as EntitlementStatus | 'all')}
            className="input py-1.5 w-36"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn-primary btn-sm" onClick={handleApplyFilter}>
          查询
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={handleResetFilter}>
          重置
        </button>
      </div>

      {filterError && (
        <div role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
          {filterError}
        </div>
      )}

      <div className="mt-4">
        {loading ? (
          <TableSkeleton rows={5} />
        ) : loadError ? (
          <div role="alert" className="flex flex-col items-center py-10">
            <p className="text-sm text-[var(--color-danger)]">{loadError}</p>
            <button type="button" className="btn-secondary mt-4" onClick={() => void load()}>
              重新加载
            </button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="暂无权益记录"
            description="当前筛选条件下没有匹配的商家权益，可尝试调整筛选条件。"
            compact
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="商家权益列表">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-muted)]">
                    <th className="px-3 py-2">商家 ID</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">来源</th>
                    <th className="px-3 py-2">有效期</th>
                    <th className="px-3 py-2">授权原因</th>
                    <th className="px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {items.map((ent) => (
                    <tr key={ent.id}>
                      <td className="px-3 py-3">{ent.merchantId}</td>
                      <td className="px-3 py-3">{STATUS_LABEL[ent.status] ?? ent.status}</td>
                      <td className="px-3 py-3">{SOURCE_LABEL[ent.source] ?? ent.source}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <span>
                            <span className="text-[var(--color-text-muted)]">开始</span>{' '}
                            <time dateTime={ent.validFrom}>{formatDateTime(ent.validFrom)}</time>
                          </span>
                          <span>
                            <span className="text-[var(--color-text-muted)]">到期</span>{' '}
                            <time dateTime={ent.validUntil}>{formatDateTime(ent.validUntil)}</time>
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3">{ent.reason || '—'}</td>
                      <td className="px-3 py-3">
                        {ent.status === 'active' ? (
                          <button
                            type="button"
                            aria-label={`撤销商家 ${ent.merchantId} 的权益`}
                            className="btn-secondary btn-sm"
                            onClick={() => openRevokeDialog(ent)}
                          >
                            <Ban className="w-3.5 h-3.5" />
                            撤销
                          </button>
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
              testId="admin-entitlement-pagination"
            />
          </>
        )}
      </div>

      <Dialog
        open={grantOpen}
        onOpenChange={(open) => {
          if (!open && grantBusy) return
          setGrantOpen(open)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>手工授予合作伙伴权益</DialogTitle>
          <DialogDescription>
            为商家授予平台合作伙伴权益（限时商业合作标识）。到期时间需在未来的 365 天内。
          </DialogDescription>
          <div className="space-y-4 mt-4">
            <div>
              <label
                htmlFor="grant-merchant-id"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                商家 ID
              </label>
              <input
                id="grant-merchant-id"
                type="text"
                inputMode="numeric"
                value={grantMerchantId}
                onChange={(e) => {
                  setGrantMerchantId(e.target.value)
                  setGrantFieldError(null)
                }}
                placeholder="请输入商家 ID"
                className="input"
                disabled={grantBusy}
              />
            </div>
            <div>
              <label
                htmlFor="grant-valid-until"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                到期时间
              </label>
              <input
                id="grant-valid-until"
                type="datetime-local"
                value={grantValidUntil}
                onChange={(e) => {
                  setGrantValidUntil(e.target.value)
                  setGrantFieldError(null)
                }}
                className="input"
                disabled={grantBusy}
              />
            </div>
            <div>
              <label
                htmlFor="grant-reason"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                授权原因
              </label>
              <textarea
                id="grant-reason"
                value={grantReason}
                onChange={(e) => {
                  setGrantReason(e.target.value)
                  setGrantFieldError(null)
                }}
                rows={3}
                maxLength={MAX_REASON_LENGTH}
                placeholder="请输入授权原因"
                className="input resize-y"
                disabled={grantBusy}
              />
            </div>
            {grantFieldError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {grantFieldError}
              </div>
            )}
            {grantSubmitError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {grantSubmitError}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm"
                disabled={grantBusy}
                onClick={() => setGrantOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={grantBusy}
                onClick={() => void handleGrantSubmit()}
              >
                {grantBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认授予'}
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
              <DialogTitle>撤销合作伙伴权益</DialogTitle>
              <DialogDescription>
                确认撤销商家 ID {revokeTarget?.merchantId ?? '—'} 的平台合作伙伴权益？撤销后该标识立即失效。
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
                maxLength={MAX_REASON_LENGTH}
                placeholder="请输入撤销原因"
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
