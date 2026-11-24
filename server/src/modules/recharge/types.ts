export * from '../../lib/paymentTypes.js'

export const RECHARGE_MODES = ['disabled', 'sandbox', 'admin_sandbox', 'live'] as const
export type RechargeMode = (typeof RECHARGE_MODES)[number]

export const AMOUNT_SOURCES = ['suggested', 'custom'] as const
export type AmountSource = (typeof AMOUNT_SOURCES)[number]

export const RECHARGE_PRICE_POLICY_STATUSES = ['draft', 'active', 'retired'] as const
export type RechargePricePolicyStatus = (typeof RECHARGE_PRICE_POLICY_STATUSES)[number]

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

export const RECHARGE_IDEMPOTENCY_SCOPES = [
  'create_order',
  'complete_payment',
  'cancel_order',
  'request_refund',
] as const
export type RechargeIdempotencyScope = (typeof RECHARGE_IDEMPOTENCY_SCOPES)[number]

export const RECHARGE_IDEMPOTENCY_STATUSES = ['processing', 'completed'] as const
export type RechargeIdempotencyStatus = (typeof RECHARGE_IDEMPOTENCY_STATUSES)[number]

export const RECHARGE_REFUND_STATUSES = [
  'requested',
  'points_held',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'manual_review',
] as const
export type RechargeRefundStatus = (typeof RECHARGE_REFUND_STATUSES)[number]

export const RECHARGE_LIMIT_PERIOD_TYPES = ['day', 'month'] as const
export type RechargeLimitPeriodType = (typeof RECHARGE_LIMIT_PERIOD_TYPES)[number]

export const RECHARGE_LIMIT_RESERVATION_STATUSES = ['reserved', 'consumed', 'released'] as const
export type RechargeLimitReservationStatus = (typeof RECHARGE_LIMIT_RESERVATION_STATUSES)[number]

export const RECHARGE_CREDIT_TASK_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'reconcile_required',
] as const
export type RechargeCreditTaskStatus = (typeof RECHARGE_CREDIT_TASK_STATUSES)[number]
