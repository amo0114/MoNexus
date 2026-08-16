// settlementCopy.ts — frozen 资金/结算 copy projection
// (SPEC-CMI-UX-001 §6.1; D-UX-18/19; AC-UX-020; T-UX-007 DoD).

/** Frozen business terms (spec §6.1). */
export const SETTLEMENT_TERM = {
  PLATFORM_FEE: '平台服务费',
  ORDER_AMOUNT: '订单金额',
  SETTLEMENT_AMOUNT: '结算金额',
  SETTLEMENT_RECORD: '结算记录',
} as const

/** Frozen user phrase replacing the internal "SLA 超时" (D-UX-19). */
export const PROCESSING_TIMEOUT_LABEL = '已超过处理时限'

/**
 * Raw blockReason allowlist → stable user copy (D-UX-19, AC-UX-020).
 * Only these known server reasons are shown verbatim; anything else falls back
 * to the safe "contact platform" message so an internal code can never leak
 * into the merchant UI.
 */
const BLOCK_REASON_ALLOWLIST: Record<string, string> = {
  '订单待处理，暂不可结算': '订单待处理，暂不可结算',
  '订单履约中，暂不可结算': '订单履约中，暂不可结算',
  '订单争议中，暂不可结算': '订单争议中，暂不可结算',
  '订单已退款，不可结算': '订单已退款，不可结算',
  '订单状态不可结算': '暂时无法结算，请联系平台处理',
}

const UNKNOWN_BLOCK_REASON = '暂时无法结算，请联系平台处理'

/** Project a raw blockReason to a limited set of user reasons. */
export function blockReasonToUserMessage(reason: string | null | undefined): string | null {
  if (reason == null || reason.trim() === '') return null
  return BLOCK_REASON_ALLOWLIST[reason] ?? UNKNOWN_BLOCK_REASON
}

/** Format a processing deadline for display; unparseable input is shown verbatim. */
export function formatProcessingDeadline(iso: string | null | undefined): string | null {
  if (iso == null || iso === '') return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}
