import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import { newIdempotencyKey } from './idempotencyKey'
import type {
  GVAuditOperationState,
  AccountStatus,
  GVExportStatus,
  GVMerchantAction,
  GVRefundStatus,
  GVShopOrderStatus,
  GVUserRole,
  LegacyCompleteness,
  MerchantLifecycleStatus,
} from '../types/governance'

// ── Error classification ────────────────────────────────────────────────

/**
 * How a governance command failed, from the operator's point of view.
 * - forbidden: backend denied the permission; never auto-retry.
 * - conflict: facts changed (409); refetch and let the operator decide again.
 * - unconfirmed: no response (timeout / network); the decision may have committed,
 *   so re-query before showing anything and reuse the same Idempotency-Key.
 * - rejected: any other definitive 4xx/5xx.
 */
export type GovernanceFailure =
  | { kind: 'forbidden'; code: string; message: string }
  | { kind: 'conflict'; code: string; message: string }
  | { kind: 'unconfirmed'; code: null; message: string }
  | { kind: 'rejected'; code: string | null; message: string; status: number | null }

interface MaybeAxiosError {
  response?: { status?: number }
  code?: string
}

export function classifyGovernanceError(error: unknown, fallback: string): GovernanceFailure {
  const status = (error as MaybeAxiosError | undefined)?.response?.status ?? null
  const code = getApiErrorCode(error) ?? null
  const message = getApiErrorMessage(error, fallback)
  if (status === null) {
    return { kind: 'unconfirmed', code: null, message: '网络中断或超时，结果尚未确认。正在重新查询当前状态。' }
  }
  if (status === 403 || code === 'PERMISSION_DENIED') {
    return { kind: 'forbidden', code: code ?? 'PERMISSION_DENIED', message: getApiErrorMessage(error, '没有执行此操作的权限') }
  }
  if (status === 409) return { kind: 'conflict', code: code ?? 'STATE_CONFLICT', message }
  return { kind: 'rejected', code, message, status }
}

export function isNotFoundError(error: unknown): boolean {
  return (error as MaybeAxiosError | undefined)?.response?.status === 404
}

export function isForbiddenError(error: unknown): boolean {
  return (error as MaybeAxiosError | undefined)?.response?.status === 403
}

// ── Idempotency keys ─────────────────────────────────────────────────────

/**
 * One key per operator intent. The same intent (identical fingerprint) — e.g. a
 * retry after a timeout — reuses its key so the backend replays instead of
 * deciding twice; any change to action, target, version or decision content
 * yields a new key. Call reset() after a definitive outcome.
 */
export class IntentKey {
  private fingerprint: string | null = null
  private key = ''

  for(intent: unknown): string {
    const fingerprint = JSON.stringify(intent)
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.key = newIdempotencyKey()
    }
    return this.key
  }

  reset() {
    this.fingerprint = null
    this.key = ''
  }
}

// ── Vocabulary → Chinese labels (single place; components never compare raw strings) ──

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'primary'

export interface StatusLabel {
  label: string
  tone: Tone
}

function lookup<T extends string>(map: Record<T, StatusLabel>, value: string | null | undefined, unknownLabel = '未知'): StatusLabel {
  if (value && value in map) return map[value as T]
  return { label: value || unknownLabel, tone: 'neutral' }
}

const ACCOUNT_STATUS: Record<AccountStatus, StatusLabel> = {
  active: { label: '正常', tone: 'success' },
  banned: { label: '已封禁', tone: 'danger' },
}
export const accountStatusLabel = (v: string | null | undefined) => lookup(ACCOUNT_STATUS, v)

const MERCHANT_STATUS: Record<MerchantLifecycleStatus, StatusLabel> = {
  pending: { label: '待审核', tone: 'warning' },
  active: { label: '营业中', tone: 'success' },
  suspended: { label: '已停用', tone: 'danger' },
  rejected: { label: '已驳回', tone: 'danger' },
}
export const merchantStatusLabel = (v: string | null | undefined) => lookup(MERCHANT_STATUS, v)

const ROLE: Record<GVUserRole, StatusLabel> = {
  user: { label: '用户', tone: 'neutral' },
  merchant: { label: '商家', tone: 'info' },
  admin: { label: '管理员', tone: 'primary' },
}
export const roleLabel = (v: string | null | undefined) => lookup(ROLE, v)

const REFUND_STATUS: Record<GVRefundStatus, StatusLabel> = {
  requested: { label: '已申请', tone: 'warning' },
  manual_review: { label: '待人工审核', tone: 'warning' },
  // points_held after a resume = decision recorded, cash refund not yet executed.
  points_held: { label: '审核通过 · 待执行退款', tone: 'info' },
  processing: { label: '渠道退款处理中', tone: 'info' },
  succeeded: { label: '现金已退回', tone: 'success' },
  failed: { label: '退款失败', tone: 'danger' },
  cancelled: { label: '已拒绝/取消', tone: 'neutral' },
}
export const refundStatusLabel = (v: string | null | undefined) => lookup(REFUND_STATUS, v)

const MERCHANT_ACTION: Record<GVMerchantAction, StatusLabel> = {
  submit: { label: '提交申请', tone: 'info' },
  resubmit: { label: '修改后重提', tone: 'info' },
  approve: { label: '审核通过', tone: 'success' },
  reject: { label: '驳回申请', tone: 'danger' },
  suspend: { label: '停用经营', tone: 'danger' },
  restore: { label: '恢复经营', tone: 'success' },
}
export const merchantActionLabel = (v: string | null | undefined) => lookup(MERCHANT_ACTION, v)

const EXPORT_STATUS: Record<GVExportStatus, StatusLabel> = {
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '生成中', tone: 'info' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  expired: { label: '已过期', tone: 'neutral' },
}
export const exportStatusLabel = (v: string | null | undefined) => lookup(EXPORT_STATUS, v)

const SHOP_ORDER_STATUS: Record<GVShopOrderStatus, StatusLabel> = {
  pending: { label: '待处理', tone: 'warning' },
  processing: { label: '处理中', tone: 'info' },
  delivered: { label: '已交付', tone: 'primary' },
  disputed: { label: '争议中', tone: 'danger' },
  closed: { label: '已完成', tone: 'success' },
  refunded: { label: '已退款', tone: 'neutral' },
}
export const shopOrderStatusLabel = (v: string | null | undefined) => lookup(SHOP_ORDER_STATUS, v)

const COMPLETENESS: Record<LegacyCompleteness, StatusLabel> = {
  complete: { label: '统计完整', tone: 'success' },
  partial: { label: '含历史缺口', tone: 'warning' },
  unknown: { label: '历史口径未知', tone: 'warning' },
}
export const completenessLabel = (v: string | null | undefined) => lookup(COMPLETENESS, v)

const POINT_ORIGIN: Record<string, StatusLabel> = {
  recharge: { label: '充值', tone: 'primary' },
  reward: { label: '奖励', tone: 'success' },
  merchant_settlement: { label: '商家结算', tone: 'info' },
  admin_adjustment: { label: '后台调整', tone: 'warning' },
  legacy_unknown: { label: '历史未知来源', tone: 'neutral' },
}
export const pointOriginLabel = (v: string | null | undefined) => lookup(POINT_ORIGIN, v, '未标记')

// committed is a local decision only — never shown as cash returned or a finished job.
const AUDIT_OPERATION_STATE: Record<GVAuditOperationState, StatusLabel & { hint: string }> = {
  attempt: { label: '仅发起请求', tone: 'warning', hint: '只证明请求已发起，不代表已执行完成。' },
  committed: { label: '决定已提交', tone: 'success', hint: '本地决定已提交（含拒绝决定）；不代表现金已退回或任务已完成。' },
  sent: { label: '本地已发送', tone: 'info', hint: '本地发送调用已提交，不证明收件人已收到。' },
  failed: { label: '本地发送报错', tone: 'danger', hint: '包括超时，不能证明远端未接受；请勿据此重复发送。' },
  rejected: { label: '本地已拒绝', tone: 'neutral', hint: '请求在本地被拒绝，未执行。' },
  rate_limited: { label: '因限流拒绝', tone: 'neutral', hint: '请求触发限流，在本地被拒绝。' },
  unknown: { label: '结果未知', tone: 'neutral', hint: '该记录未标记执行阶段，不能当作成功或失败。' },
}
export const auditOperationStateLabel = (v: string | null | undefined) =>
  (v && v in AUDIT_OPERATION_STATE ? AUDIT_OPERATION_STATE[v as GVAuditOperationState] : AUDIT_OPERATION_STATE.unknown)

// ── Display helpers ──────────────────────────────────────────────────────

/** Business number when present; numeric id only as the migration-window fallback. */
export function formatOrderRef(orderNo: string | null | undefined, id: number): string {
  return orderNo || `#${id}`
}

/** Timestamps from the contract; null means unknown, never "never". */
export function formatDateTime(value: string | null | undefined, unknown = '未知'): string {
  if (!value) return unknown
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return unknown
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/**
 * `YYYY-MM-DD` from a date input → Asia/Shanghai day boundary as ISO.
 * Contract ranges are from-inclusive / to-exclusive, so an inclusive end day
 * maps to the start of the following day.
 */
export function shanghaiDayStart(day: string, offsetDays = 0): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const t = Date.parse(`${day}T00:00:00+08:00`)
  if (Number.isNaN(t)) return undefined
  return new Date(t + offsetDays * 86_400_000).toISOString()
}
