// T-MERCH-FE-003 — AdminPromotionCampaignManager: admin-only management of
// promotion campaigns (SPEC-MERCH-001 §11 admin lane): query / status filter /
// pagination plus the approve / reject / pause / resume / cancel /
// refund-adjustment mutations.
//
// Every mutation goes through ONE controlled confirm Dialog — never a
// direct-click mutation. The action union is strictly typed; validation is
// exact (no untyped escape hatches mask data):
//  - reject: trimmed reason required, ≤500 chars;
//  - approve / pause / resume: confirm only, no input;
//  - cancel: optional trimmed reason ≤500; only active/paused show the refund
//    points input (default 0, strict decimal non-negative safe integer within
//    0..chargedPoints) and the payload carries points (reason only when set);
//    other statuses never send points (reason only when set);
//  - refund-adjustment: points default 0 within 0..chargedPoints, trimmed
//    reason required ≤500, payload is exactly { points, reason }.
//
// Idempotency (SPEC-MERCH-001 §11): refund-adjustment and active/paused cancel
// MUST carry an adapter.createIdempotencyKey() key. A strongly typed ref holds
// { fingerprint, key }; the fingerprint binds action + campaign id + the
// normalized payload. A same-payload failure retry reuses the same key, a
// changed payload gets a fresh key, and success (or opening another action)
// clears it. The key is never displayed or logged.
//
// Feedback: success is reported once via role=status at the top; failures stay
// inside the Dialog with role=alert. Approve that resolves to payment_failed is
// a SUCCESS (审核已通过，但商家积分余额不足，活动进入支付失败状态。) — never a
// fabricated HTTP error. A replayed DTO is a normal success (close + refresh);
// a 409 is never reported as success.
//
// The admin DTO is consumed as-is; it is never projected onto the public/
// merchant PromotionCampaignDTO. Internal audit fields (reviewedByUserId /
// cancelledByUserId), idempotency keys/hashes, PointLog ids and balance history
// are never rendered (MERCH-015 / CHK-SEC-001 / CHK-PROMO-013).
//
// Concurrency: a strictly-increasing request id guards against a stale list
// response (or error) overwriting a newer filter/page result. On a list failure
// we surface getApiErrorMessage and clear the list — never fabricate old data.
//
// Timezone: ISO timestamps are rendered through a safe local-time formatter;
// unparseable input is shown verbatim and null is shown as —.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Megaphone } from 'lucide-react'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import {
  adjustAdminPromotionCampaignRefund,
  approveAdminPromotionCampaign,
  cancelAdminPromotionCampaign,
  listAdminPromotionCampaigns,
  newPromotionIdempotencyKey,
  pauseAdminPromotionCampaign,
  rejectAdminPromotionCampaign,
  resumeAdminPromotionCampaign,
  type AdminPromotionCampaignQuery,
} from '../../api/merchandising'
import type {
  AdminPromotionCampaignCancelPayload,
  AdminPromotionCampaignDTO,
  AdminPromotionRefundAdjustmentPayload,
  CampaignStatus,
  CampaignStatusFilter,
} from '../../types/merchandising'
import AdminPagination from '../admin/AdminPagination'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_ORDER,
  isKnownCampaignStatus,
  PLACEMENT_LABEL,
} from './promotionCopy'

/**
 * Real adapter — passthrough to the frozen admin promotion campaign API.
 * Every mutation in the confirm Dialog dispatches through this adapter;
 * createIdempotencyKey backs the keyed refund-adjustment / active+paused
 * cancel calls.
 */
export interface AdminPromotionCampaignAdapter {
  listCampaigns: typeof listAdminPromotionCampaigns
  approveCampaign: typeof approveAdminPromotionCampaign
  rejectCampaign: typeof rejectAdminPromotionCampaign
  pauseCampaign: typeof pauseAdminPromotionCampaign
  resumeCampaign: typeof resumeAdminPromotionCampaign
  cancelCampaign: typeof cancelAdminPromotionCampaign
  adjustRefund: typeof adjustAdminPromotionCampaignRefund
  createIdempotencyKey: typeof newPromotionIdempotencyKey
}

const DEFAULT_ADAPTER: AdminPromotionCampaignAdapter = {
  listCampaigns: listAdminPromotionCampaigns,
  approveCampaign: approveAdminPromotionCampaign,
  rejectCampaign: rejectAdminPromotionCampaign,
  pauseCampaign: pauseAdminPromotionCampaign,
  resumeCampaign: resumeAdminPromotionCampaign,
  cancelCampaign: cancelAdminPromotionCampaign,
  adjustRefund: adjustAdminPromotionCampaignRefund,
  createIdempotencyKey: newPromotionIdempotencyKey,
}

export interface AdminPromotionCampaignManagerProps {
  adapter?: AdminPromotionCampaignAdapter
  className?: string
}

const PAGE_SIZE = 20

/** Max length for admin-entered reasons (mirrors the frozen server cap). */
const MAX_REASON_LENGTH = 500

/**
 * Strictly-typed mutation action union. Every entry-button maps to exactly one
 * kind; no type assertion is used to smuggle a value through.
 */
export type AdminCampaignDialogAction =
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'cancel' }
  | { kind: 'refund-adjustment' }

type AdminCampaignActionKind = AdminCampaignDialogAction['kind']

/** Buttons available per frozen CampaignStatus (expired / cancelled → none). */
const ACTIONS_BY_STATUS: Record<CampaignStatus, readonly AdminCampaignActionKind[]> = {
  pending_review: ['approve', 'reject', 'cancel'],
  payment_failed: ['cancel'],
  scheduled: ['cancel'],
  active: ['pause', 'cancel', 'refund-adjustment'],
  paused: ['resume', 'cancel', 'refund-adjustment'],
  expired: [],
  rejected: ['cancel'],
  cancelled: [],
}

/** Fail-closed: an unknown status renders with no operations at all. */
function availableActions(
  campaign: AdminPromotionCampaignDTO,
): readonly AdminCampaignActionKind[] {
  return isKnownCampaignStatus(campaign.status) ? ACTIONS_BY_STATUS[campaign.status] : []
}

const ACTION_BUTTON_LABEL: Record<AdminCampaignActionKind, string> = {
  approve: '批准',
  reject: '拒绝',
  pause: '暂停',
  resume: '恢复',
  cancel: '取消',
  'refund-adjustment': '退款调整',
}

/** Every operation button carries an aria-label that includes the campaign id. */
function actionButtonAriaLabel(
  kind: AdminCampaignActionKind,
  campaign: AdminPromotionCampaignDTO,
): string {
  switch (kind) {
    case 'approve':
      return `批准推广活动（活动 ID ${campaign.id}）`
    case 'reject':
      return `拒绝推广活动（活动 ID ${campaign.id}）`
    case 'pause':
      return `暂停推广活动（活动 ID ${campaign.id}）`
    case 'resume':
      return `恢复推广活动（活动 ID ${campaign.id}）`
    case 'cancel':
      return `取消推广活动（活动 ID ${campaign.id}）`
    case 'refund-adjustment':
      return `退款调整（活动 ID ${campaign.id}）`
  }
}

/** Strict decimal non-negative integer (no sign, decimals, exponent or empty). */
const DECIMAL_NON_NEGATIVE_INTEGER = /^\d+$/

/**
 * Parse a refund-points input into a JS number that is safe to send: strictly
 * decimal, non-negative, an integer, within the safe-integer range and within
 * 0..chargedPoints. Returns null (caller surfaces the precise local error).
 */
function parseRefundPoints(raw: string, chargedPoints: number): number | null {
  if (!DECIMAL_NON_NEGATIVE_INTEGER.test(raw)) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) return null
  if (value < 0 || value > chargedPoints) return null
  return value
}

const ACTION_ERROR_FALLBACK: Record<AdminCampaignActionKind, string> = {
  approve: '批准失败，请稍后重试。',
  reject: '拒绝失败，请稍后重试。',
  pause: '暂停失败，请稍后重试。',
  resume: '恢复失败，请稍后重试。',
  cancel: '取消失败，请稍后重试。',
  'refund-adjustment': '退款调整失败，请稍后重试。',
}

/**
 * Stable server error-code mapping via getApiErrorCode/getApiErrorMessage;
 * anything else falls back to the server message or the per-action fallback.
 * A 409 conflict is never surfaced as success.
 */
function mapCampaignActionError(e: unknown, kind: AdminCampaignActionKind): string {
  const code = getApiErrorCode(e)
  switch (code) {
    case 'CAMPAIGN_TRANSITION_INVALID':
      return '活动状态已变化，当前操作无法完成，请刷新后重试。'
    case 'PLACEMENT_OCCUPIED':
      return '该商品在所选展位已有进行中的推广活动。'
    case 'IDEMPOTENCY_KEY_REUSED':
      return '幂等请求内容冲突，请重新确认后再试。'
    case 'CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED':
      return '该推广活动已完成退款调整，不能再次调整。'
    case 'IDEMPOTENCY_KEY_REQUIRED':
    case 'IDEMPOTENCY_KEY_INVALID':
      return '退款操作请求标识无效，请重新打开窗口后再试。'
    default:
      return getApiErrorMessage(e, ACTION_ERROR_FALLBACK[kind])
  }
}

const ACTION_SUCCESS_COPY: Record<AdminCampaignActionKind, string> = {
  approve: '推广活动已批准。',
  reject: '推广活动已拒绝。',
  pause: '推广活动已暂停。',
  resume: '推广活动已恢复。',
  cancel: '推广活动已取消。',
  'refund-adjustment': '退款调整已完成。',
}

const ACTION_DIALOG_TITLE: Record<AdminCampaignActionKind, string> = {
  approve: '批准推广活动',
  reject: '拒绝推广活动',
  pause: '暂停推广活动',
  resume: '恢复推广活动',
  cancel: '取消推广活动',
  'refund-adjustment': '退款调整',
}

/**
 * Per-action confirm description. Cancel copy reflects the frozen server
 * semantics: scheduled → full auto-refund; active/paused → one-time explicit
 * adjustment decision; other statuses → free (no charge).
 */
function buildDialogDescription(
  action: AdminCampaignDialogAction,
  campaign: AdminPromotionCampaignDTO,
): string {
  switch (action.kind) {
    case 'approve':
      return `确认批准活动 ${campaign.id} 的推广申请？批准后将按套餐价格扣款。`
    case 'reject':
      return `确认拒绝活动 ${campaign.id} 的推广申请？拒绝不会扣积分。`
    case 'pause':
      return `确认暂停活动 ${campaign.id} 的推广？暂停期间仍占用该展位，暂停时间不顺延。`
    case 'resume':
      return `确认恢复活动 ${campaign.id} 的推广？`
    case 'cancel':
      if (campaign.status === 'scheduled') {
        return `确认取消活动 ${campaign.id}？取消将全额自动退回已扣积分。`
      }
      if (campaign.status === 'active' || campaign.status === 'paused') {
        return `确认取消活动 ${campaign.id} 的推广？取消将按下方退款积分进行一次退款调整，不可再次调整。`
      }
      return `确认取消活动 ${campaign.id} 的推广申请？取消不会扣积分。`
    case 'refund-adjustment':
      return `为活动 ${campaign.id} 设置一次性退款调整决定，提交后不可修改。`
  }
}

/**
 * Frozen status filter options: “全部” + the eight frozen CampaignStatus values
 * in display order (promotionCopy is the single source of truth for the labels).
 */
const STATUS_OPTIONS: ReadonlyArray<{ value: CampaignStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  ...CAMPAIGN_STATUS_ORDER.map((status) => ({
    value: status,
    label: CAMPAIGN_STATUS_LABEL[status],
  })),
]

/**
 * Fail-closed runtime guard for the status select: only “all” or one of the
 * eight frozen CampaignStatus values is accepted. A type assertion never masks
 * an out-of-enum select value.
 */
function parseStatusFilter(value: string): CampaignStatusFilter | null {
  if (value === 'all') return 'all'
  return isKnownCampaignStatus(value) ? value : null
}

/** Safe date formatting: unparseable input is shown verbatim. */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/** Nullable timestamps render as — when absent; else safe local formatting. */
function formatMaybeDate(iso: string | null): string {
  return iso == null ? '—' : formatDateTime(iso)
}

export default function AdminPromotionCampaignManager({
  adapter = DEFAULT_ADAPTER,
  className = '',
}: AdminPromotionCampaignManagerProps) {
  const [campaigns, setCampaigns] = useState<AdminPromotionCampaignDTO[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<CampaignStatusFilter>('all')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Success feedback (role=status) at the top; failures stay in the Dialog.
  const [feedback, setFeedback] = useState<{ kind: 'success'; text: string } | null>(null)

  // ONE controlled confirm Dialog for every mutation.
  const [dialog, setDialog] = useState<{
    action: AdminCampaignDialogAction
    campaign: AdminPromotionCampaignDTO
  } | null>(null)
  const [dialogReason, setDialogReason] = useState('')
  const [dialogPoints, setDialogPoints] = useState('0')
  const [dialogFieldError, setDialogFieldError] = useState<string | null>(null)
  const [dialogSubmitError, setDialogSubmitError] = useState<string | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)

  // Synchronous mutation-in-flight ref. React state updates are asynchronous, so
  // the ref is flipped true synchronously right before the adapter call to close
  // the double-submit window. It is kept in lock-step with the dialogBusy state
  // (both set true together before the call, both false in finally).
  const dialogBusyRef = useRef(false)

  // Strictly-increasing request id: a stale list response (or error) from an
  // older status/page request must never overwrite a newer result.
  const requestSeqRef = useRef(0)

  // Strongly-typed idempotency state for refund-adjustment / active+paused
  // cancel: { fingerprint, key }. The fingerprint binds action + campaign id +
  // the normalized payload so a same-payload retry reuses the same key while a
  // changed payload or a fresh open gets a new key. Never rendered / logged.
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setLoadError(null)
    // The query always carries the current status/page/pageSize exactly.
    // ('all' is a valid UI filter but the real API omits it — allowed.)
    const query: AdminPromotionCampaignQuery = {
      status: statusFilter,
      page,
      pageSize: PAGE_SIZE,
    }
    try {
      const data = await adapter.listCampaigns(query)
      if (seq !== requestSeqRef.current) return
      setCampaigns(data.campaigns)
      setTotal(data.total)
    } catch (e) {
      if (seq !== requestSeqRef.current) return
      // Failure never fabricates old data — clear the list and surface the error.
      setCampaigns([])
      setTotal(0)
      setLoadError(getApiErrorMessage(e, '推广活动列表加载失败，请稍后重试。'))
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [adapter, statusFilter, page])

  // Initial load calls listCampaigns({ status: 'all', page: 1, pageSize: 20 });
  // changing the filter or page re-runs this effect with the exact new query.
  useEffect(() => {
    void load()
  }, [load])

  const handleStatusFilterChange = (value: string) => {
    // Runtime guard: an out-of-enum select value is ignored, never coerced.
    const parsed = parseStatusFilter(value)
    if (parsed == null) return
    setStatusFilter(parsed)
    setPage(1)
  }

  const openDialog = (campaign: AdminPromotionCampaignDTO, action: AdminCampaignDialogAction) => {
    // While a mutation is in flight (busy ref), never reset/overwrite the active
    // action: an in-flight submit keeps its dialog, target, inputs and errors.
    if (dialogBusyRef.current) return
    // Opening ANY action clears feedback, the previous key, inputs and errors.
    setFeedback(null)
    idempotencyRef.current = null
    setDialogReason('')
    setDialogPoints('0')
    setDialogFieldError(null)
    setDialogSubmitError(null)
    setDialogBusy(false)
    setDialog({ action, campaign })
  }

  const handleDialogSubmit = async () => {
    // Entry busy guard: the sync ref AND the state must both be clear — a
    // pending mutation must never be re-entered (double submit). The ref closes
    // the window that state alone leaves open across the same sync trigger burst.
    if (dialog == null || dialogBusyRef.current || dialogBusy) return
    const { action, campaign } = dialog
    const reason = dialogReason.trim()

    // Idempotency: reuse the stored key only when the fingerprint (action +
    // campaign id + normalized payload) matches; otherwise generate a fresh key.
    const keyFor = (
      kind: 'cancel' | 'refund-adjustment',
      payload: AdminPromotionCampaignCancelPayload | AdminPromotionRefundAdjustmentPayload,
    ): string => {
      const fingerprint = `${kind}:${campaign.id}:${JSON.stringify(payload)}`
      const existing = idempotencyRef.current
      if (existing != null && existing.fingerprint === fingerprint) return existing.key
      const key = adapter.createIdempotencyKey()
      idempotencyRef.current = { fingerprint, key }
      return key
    }

    // Build the adapter call as a runner closure — the adapter is NOT invoked
    // here. All client-side validation completes first; the runner only executes
    // once the busy slot has been claimed synchronously below.
    let run: (() => Promise<AdminPromotionCampaignDTO>) | null = null
    switch (action.kind) {
      case 'approve':
        run = () => adapter.approveCampaign(campaign.id)
        break
      case 'reject':
        if (reason.length < 1) {
          setDialogFieldError('请输入拒绝原因')
          return
        }
        if (reason.length > MAX_REASON_LENGTH) {
          setDialogFieldError(`拒绝原因不能超过 ${MAX_REASON_LENGTH} 字`)
          return
        }
        run = () => adapter.rejectCampaign(campaign.id, reason)
        break
      case 'pause':
        run = () => adapter.pauseCampaign(campaign.id)
        break
      case 'resume':
        run = () => adapter.resumeCampaign(campaign.id)
        break
      case 'cancel':
        if (reason.length > MAX_REASON_LENGTH) {
          setDialogFieldError(`取消原因不能超过 ${MAX_REASON_LENGTH} 字`)
          return
        }
        if (campaign.status === 'active' || campaign.status === 'paused') {
          const points = parseRefundPoints(dialogPoints, campaign.chargedPoints)
          if (points == null) {
            setDialogFieldError(`退款积分必须是 0 到 ${campaign.chargedPoints} 之间的非负整数`)
            return
          }
          // active/paused cancel is a one-time explicit adjustment decision:
          // payload always carries points, reason only when set, and a key.
          const payload: AdminPromotionCampaignCancelPayload = {
            points,
            ...(reason !== '' ? { reason } : {}),
          }
          run = () => adapter.cancelCampaign(campaign.id, payload, keyFor('cancel', payload))
        } else {
          // Other statuses never send points; reason sent only when non-empty.
          const payload: AdminPromotionCampaignCancelPayload =
            reason !== '' ? { reason } : {}
          run = () => adapter.cancelCampaign(campaign.id, payload)
        }
        break
      case 'refund-adjustment':
        if (reason.length < 1) {
          setDialogFieldError('请输入调整理由')
          return
        }
        if (reason.length > MAX_REASON_LENGTH) {
          setDialogFieldError(`调整理由不能超过 ${MAX_REASON_LENGTH} 字`)
          return
        }
        {
          const points = parseRefundPoints(dialogPoints, campaign.chargedPoints)
          if (points == null) {
            setDialogFieldError(`退款积分必须是 0 到 ${campaign.chargedPoints} 之间的非负整数`)
            return
          }
          // Refund-adjustment payload is exactly { points, reason }, always keyed.
          const payload: AdminPromotionRefundAdjustmentPayload = { points, reason }
          run = () => adapter.adjustRefund(campaign.id, payload, keyFor('refund-adjustment', payload))
        }
        break
    }

    // Exhaustive action union guarantees run is set here; fail-closed if not.
    if (run == null) return

    setDialogFieldError(null)
    setDialogSubmitError(null)
    // Synchronously claim the mutation slot BEFORE the adapter call: state alone
    // is asynchronous, so the ref is what blocks a second sync trigger from ever
    // reaching the adapter. Consecutive sync triggers invoke the adapter once.
    dialogBusyRef.current = true
    setDialogBusy(true)
    try {
      const result = await run()
      // Success only: clear the key, close/reset, report status, refresh the
      // current status/page query. A replay is a normal success DTO — never a
      // failure. Approve that lands in payment_failed is still a success with
      // explicit copy, not a fabricated HTTP error.
      idempotencyRef.current = null
      setDialog(null)
      if (action.kind === 'approve' && result.status === 'payment_failed') {
        setFeedback({
          kind: 'success',
          text: '审核已通过，但商家积分余额不足，活动进入支付失败状态。',
        })
      } else {
        setFeedback({ kind: 'success', text: ACTION_SUCCESS_COPY[action.kind] })
      }
      void load()
    } catch (e) {
      // Failure: keep the dialog + target + inputs for retry, surface the error.
      setDialogSubmitError(mapCampaignActionError(e, action.kind))
    } finally {
      dialogBusyRef.current = false
      setDialogBusy(false)
    }
  }
  return (
    <section
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-5 ${className}`}
    >
      <div>
        <h2 className="text-lg font-bold text-[var(--color-text)]">推广活动管理</h2>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          在此审核、控制推广活动并处理退款。
        </p>
      </div>

      {feedback && (
        <div
          role="status"
          className="mt-3 text-sm text-[var(--color-success)]"
        >
          {feedback.text}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label
          htmlFor="admin-promotion-campaign-status-filter"
          className="text-sm text-[var(--color-text-muted)]"
        >
          状态
        </label>
        <select
          id="admin-promotion-campaign-status-filter"
          value={statusFilter}
          onChange={(e) => handleStatusFilterChange(e.target.value)}
          className="input py-2 pr-8"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-[var(--color-text-muted)]">
          {statusFilter === 'all'
            ? '当前显示全部状态的推广活动'
            : `当前筛选状态：${CAMPAIGN_STATUS_LABEL[statusFilter]}`}
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
        ) : campaigns.length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="暂无推广活动"
            description="当前筛选条件下没有推广活动记录。"
            compact
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="推广活动列表">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-muted)]">
                    <th className="px-3 py-2">活动 ID</th>
                    <th className="px-3 py-2">商家 ID</th>
                    <th className="px-3 py-2">商品 ID</th>
                    <th className="px-3 py-2">套餐</th>
                    <th className="px-3 py-2">展位</th>
                    <th className="px-3 py-2">时长（天）</th>
                    <th className="px-3 py-2">价格（积分）</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">申请开始</th>
                    <th className="px-3 py-2">开始</th>
                    <th className="px-3 py-2">结束</th>
                    <th className="px-3 py-2">已扣积分</th>
                    <th className="px-3 py-2">已退积分</th>
                    <th className="px-3 py-2">审核意见</th>
                    <th className="px-3 py-2">取消原因</th>
                    <th className="px-3 py-2">创建 / 更新</th>
                    <th className="px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {campaigns.map((campaign) => (
                    <tr key={campaign.id}>
                      <td className="px-3 py-3 font-mono text-xs">{campaign.id}</td>
                      <td className="px-3 py-3 font-mono text-xs">{campaign.merchantId}</td>
                      <td className="px-3 py-3 font-mono text-xs">{campaign.productId}</td>
                      <td className="px-3 py-3">
                        <div className="font-mono text-xs">{campaign.packageCodeSnapshot}</div>
                        <div className="text-xs text-[var(--color-text-muted)]">ID {campaign.packageId}</div>
                      </td>
                      <td className="px-3 py-3">
                        {PLACEMENT_LABEL[campaign.placementSnapshot] ?? campaign.placementSnapshot}
                      </td>
                      <td className="px-3 py-3">{campaign.durationDaysSnapshot}</td>
                      <td className="px-3 py-3">{campaign.pricePointsSnapshot}</td>
                      <td className="px-3 py-3">
                        {CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status}
                      </td>
                      <td className="px-3 py-3">{formatMaybeDate(campaign.requestedStartAt)}</td>
                      <td className="px-3 py-3">{formatMaybeDate(campaign.startsAt)}</td>
                      <td className="px-3 py-3">{formatMaybeDate(campaign.endsAt)}</td>
                      <td className="px-3 py-3">{campaign.chargedPoints}</td>
                      <td className="px-3 py-3">{campaign.refundedPoints}</td>
                      <td className="px-3 py-3">{campaign.reviewReason ?? '—'}</td>
                      <td className="px-3 py-3">{campaign.cancellationReason ?? '—'}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <span>
                            <span className="text-[var(--color-text-muted)]">创建</span>{' '}
                            <time dateTime={campaign.createdAt}>{formatDateTime(campaign.createdAt)}</time>
                          </span>
                          <span>
                            <span className="text-[var(--color-text-muted)]">更新</span>{' '}
                            <time dateTime={campaign.updatedAt}>{formatDateTime(campaign.updatedAt)}</time>
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {availableActions(campaign).length > 0 ? (
                          <div className="flex flex-wrap items-center gap-2">
                            {availableActions(campaign).map((kind) => (
                              <button
                                key={kind}
                                type="button"
                                aria-label={actionButtonAriaLabel(kind, campaign)}
                                className={
                                  kind === 'reject' || kind === 'cancel' || kind === 'refund-adjustment'
                                    ? 'btn-secondary btn-sm border-[var(--color-danger)] text-[var(--color-danger)]'
                                    : 'btn-secondary btn-sm'
                                }
                                onClick={() => openDialog(campaign, { kind })}
                              >
                                {ACTION_BUTTON_LABEL[kind]}
                              </button>
                            ))}
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
              testId="admin-promotion-campaign-pagination"
            />
          </>
        )}
      </div>

      <Dialog
        open={dialog != null}
        onOpenChange={(open) => {
          // Never allow closing while a mutation is in flight (ref OR state).
          if (!open && (dialogBusyRef.current || dialogBusy)) return
          // Normal close clears the dialog and the idempotency key.
          if (!open) {
            setDialog(null)
            idempotencyRef.current = null
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>{dialog == null ? '' : ACTION_DIALOG_TITLE[dialog.action.kind]}</DialogTitle>
          <DialogDescription>
            {dialog == null
              ? ''
              : buildDialogDescription(dialog.action, dialog.campaign)}
          </DialogDescription>
          <div className="space-y-4 mt-4">
            {(dialog?.action.kind === 'reject' ||
              dialog?.action.kind === 'cancel' ||
              dialog?.action.kind === 'refund-adjustment') && (
              <div>
                <label
                  htmlFor="admin-campaign-action-reason"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  {dialog?.action.kind === 'cancel' ? '取消原因（可选）' : '原因'}
                </label>
                <textarea
                  id="admin-campaign-action-reason"
                  value={dialogReason}
                  onChange={(e) => {
                    setDialogReason(e.target.value)
                    setDialogFieldError(null)
                    setDialogSubmitError(null)
                  }}
                  rows={3}
                  maxLength={MAX_REASON_LENGTH}
                  placeholder={
                    dialog?.action.kind === 'cancel'
                      ? '请输入取消原因（可选，不超过 500 字）'
                      : dialog?.action.kind === 'reject'
                        ? '请输入拒绝原因（不超过 500 字）'
                        : '请输入调整理由（不超过 500 字）'
                  }
                  className="input resize-y"
                  disabled={dialogBusy}
                />
              </div>
            )}
            {(dialog?.action.kind === 'refund-adjustment' ||
              (dialog?.action.kind === 'cancel' &&
                (dialog?.campaign.status === 'active' ||
                  dialog?.campaign.status === 'paused'))) && (
              <div>
                <label
                  htmlFor="admin-campaign-action-points"
                  className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
                >
                  退款积分
                </label>
                <input
                  id="admin-campaign-action-points"
                  type="text"
                  inputMode="numeric"
                  value={dialogPoints}
                  onChange={(e) => {
                    setDialogPoints(e.target.value)
                    setDialogFieldError(null)
                    setDialogSubmitError(null)
                  }}
                  placeholder="0"
                  className="input"
                  disabled={dialogBusy}
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  {dialog != null
                    ? `已扣积分 ${dialog.campaign.chargedPoints}，退款积分必须在 0 到 ${dialog.campaign.chargedPoints} 之间。`
                    : ''}
                </p>
              </div>
            )}
            {dialogFieldError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {dialogFieldError}
              </div>
            )}
            {dialogSubmitError && (
              <div
                role="alert"
                className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
              >
                {dialogSubmitError}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm"
                disabled={dialogBusy}
                onClick={() => {
                  // Never allow closing while a mutation is in flight.
                  if (dialogBusyRef.current || dialogBusy) return
                  setDialog(null)
                  idempotencyRef.current = null
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={dialogBusy}
                onClick={() => void handleDialogSubmit()}
              >
                {dialogBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
