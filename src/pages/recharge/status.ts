export const RECHARGE_ORDER_STATUSES = [
  'created',
  'pending_payment',
  'closure_pending',
  'paid',
  'credited',
  'failed',
  'expired',
  'cancelled',
  'refund_pending',
  'refunded',
  'reconcile_required',
] as const

export type RechargeOrderStatus = (typeof RECHARGE_ORDER_STATUSES)[number]

export const PAYMENT_EVENT_STATUSES = [
  'received',
  'processing',
  'processed',
  'ignored',
  'failed',
  'reconcile_required',
] as const

export const PAYMENT_DISPUTE_STATUSES = ['open', 'won', 'lost', 'closed'] as const

export const RECHARGE_REFUND_STATUSES = [
  'requested',
  'points_held',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'manual_review',
] as const

export const RECONCILIATION_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'completed_with_mismatches',
  'failed',
] as const

export const PAYMENT_PROVIDERS = [
  'simulator',
  'stripe',
  'paypal',
  'wechat_pay',
  'alipay',
  'vmqfox',
] as const

export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number]

/** Spec §10 user-facing result states; keys are PR-C/PR-B API statuses. */
export const ORDER_STATUS_LABEL: Record<RechargeOrderStatus, string> = {
  created: '等待支付',
  pending_payment: '等待支付',
  closure_pending: '确认中',
  paid: '确认中',
  credited: '已到账',
  failed: '失败',
  expired: '已过期',
  cancelled: '已过期',
  refund_pending: '退款处理中',
  refunded: '已退款',
  reconcile_required: '需要处理',
}

export const ORDER_STATUS_TONE: Record<RechargeOrderStatus, 'info' | 'warning' | 'success' | 'danger' | 'neutral'> = {
  created: 'info',
  pending_payment: 'info',
  closure_pending: 'warning',
  paid: 'warning',
  credited: 'success',
  failed: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
  refund_pending: 'warning',
  refunded: 'neutral',
  reconcile_required: 'danger',
}

export function isRechargeOrderStatus(value: string): value is RechargeOrderStatus {
  return (RECHARGE_ORDER_STATUSES as readonly string[]).includes(value)
}

export function orderStatusLabel(status: string): string {
  return isRechargeOrderStatus(status) ? ORDER_STATUS_LABEL[status] : status
}

export function isTerminalOrderStatus(status: string): boolean {
  return status === 'credited'
    || status === 'failed'
    || status === 'expired'
    || status === 'cancelled'
    || status === 'refunded'
    || status === 'reconcile_required'
}

export function isConfirmingOrderStatus(status: string): boolean {
  return status === 'paid' || status === 'closure_pending'
}

export const PROVIDER_LABEL: Record<string, string> = {
  simulator: '模拟支付',
  stripe: 'Stripe',
  paypal: 'PayPal',
  wechat_pay: '微信支付',
  alipay: '支付宝',
  vmqfox: 'VMQFox',
}

export const METHOD_LABEL: Record<string, string> = {
  card: '银行卡',
  redirect: '跳转支付',
  qr_code: '扫码支付',
  form_post: '表单支付',
}

export const EVENT_STATUS_LABEL: Record<string, string> = {
  received: '已接收',
  processing: '处理中',
  processed: '已处理',
  ignored: '已忽略',
  failed: '失败',
  reconcile_required: '需要对账',
}

export const REFUND_STATUS_LABEL: Record<string, string> = {
  requested: '已申请',
  points_held: '积分已冻结',
  processing: '处理中',
  succeeded: '已退款',
  failed: '退款失败',
  cancelled: '已取消',
  manual_review: '待人工审核',
}

export const DISPUTE_STATUS_LABEL: Record<string, string> = {
  open: '进行中',
  won: '已胜诉',
  lost: '已败诉',
  closed: '已关闭',
}

export const RECON_STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  completed_with_mismatches: '完成（有差异）',
  failed: '失败',
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider
}

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method
}

export type PaymentLabelAudience = 'user' | 'admin'

const USER_CHANNEL_LABEL: Record<string, string> = {
  'vmqfox:wechat': '微信支付',
  'vmqfox:alipay': '支付宝支付',
}

const ADMIN_CHANNEL_LABEL: Record<string, string> = {
  'vmqfox:wechat': '微信支付（VMQFox）',
  'vmqfox:alipay': '支付宝支付（VMQFox）',
}

function channelKey(provider: string, method: string): string {
  return `${provider}:${method}`
}

/**
 * Channel-aware checkout/result/history/admin label.
 * Known VMQFox pairs hide the implementation name from buyers.
 * Unknown pairs keep the existing provider · method concatenation.
 */
export function paymentChannelLabel(
  provider: string,
  method: string,
  audience: PaymentLabelAudience = 'user',
): string {
  const key = channelKey(provider, method)
  if (audience === 'admin') {
    return ADMIN_CHANNEL_LABEL[key] ?? `${providerLabel(provider)} · ${methodLabel(method)}`
  }
  if (USER_CHANNEL_LABEL[key]) return USER_CHANNEL_LABEL[key]
  if (provider === 'vmqfox') {
    const methodText = methodLabel(method)
    return methodText === method ? '扫码支付' : methodText
  }
  return `${providerLabel(provider)} · ${methodLabel(method)}`
}

export function paymentQrAriaLabel(provider: string, method: string): string {
  if ((provider === 'vmqfox' && method === 'wechat') || provider === 'wechat_pay') {
    return '微信支付二维码'
  }
  if ((provider === 'vmqfox' && method === 'alipay') || provider === 'alipay') {
    return '支付宝支付二维码'
  }
  return '支付二维码'
}
