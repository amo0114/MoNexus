const KNOWN_BLOCK_REASONS: Record<string, string> = {
  '订单待处理，暂不可结算': '订单待处理，暂不可结算',
  '订单履约中，暂不可结算': '订单履约中，暂不可结算',
  '订单争议中，暂不可结算': '订单争议中，暂不可结算',
  '订单已退款，不可结算': '订单已退款，不可结算',
  '订单状态不可结算': '订单状态不可结算',
}

/**
 * Maps a backend blockReason to a safe, user-facing explanation.
 * Unknown backend texts fall back to a safe localized message, never blindly pass raw backend text.
 */
export function blockReasonToUserMessage(reason: string | null | undefined): string {
  if (!reason) return ''
  return KNOWN_BLOCK_REASONS[reason] ?? '订单尚未满足结算条件'
}
