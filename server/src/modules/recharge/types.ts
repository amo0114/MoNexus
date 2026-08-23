export const RECHARGE_MODES = ['disabled', 'sandbox', 'live'] as const
export type RechargeMode = (typeof RECHARGE_MODES)[number]

export const PAYMENT_PROVIDER_NAMES = [
  'simulator',
  'stripe',
  'paypal',
  'wechat_pay',
  'alipay',
] as const
export type PaymentProviderName = (typeof PAYMENT_PROVIDER_NAMES)[number]

export const RECHARGE_CURRENCIES = ['CNY', 'USD'] as const
export type RechargeCurrency = (typeof RECHARGE_CURRENCIES)[number]

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

export const PAYMENT_INTENT_STATUSES = [
  'requires_method',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'reconcile_required',
] as const
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number]

export const PAYMENT_ATTEMPT_STATUSES = [
  'created',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
] as const
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number]

export const PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES = [
  'created',
  'requires_action',
  'processing',
  'unknown',
] as const satisfies readonly PaymentAttemptStatus[]

export const PAYMENT_ACTION_TYPES = [
  'none',
  'redirect',
  'qr_code',
  'client_secret',
  'form_post',
] as const
export type PaymentActionType = (typeof PAYMENT_ACTION_TYPES)[number]

/** Unified PaymentObservation source. Table name remains PaymentEvent. */
export const PAYMENT_OBSERVATION_SOURCES = [
  'webhook',
  'provider_query',
  'provider_complete',
  'reconciliation',
] as const
export type PaymentObservationSource = (typeof PAYMENT_OBSERVATION_SOURCES)[number]

export const PAYMENT_VERIFICATION_METHODS = [
  'webhook_signature',
  'authenticated_provider_api',
] as const
export type PaymentVerificationMethod = (typeof PAYMENT_VERIFICATION_METHODS)[number]

export const PAYMENT_EVENT_STATUSES = [
  'received',
  'processing',
  'processed',
  'ignored',
  'failed',
  'reconcile_required',
] as const
export type PaymentEventStatus = (typeof PAYMENT_EVENT_STATUSES)[number]

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

export const POINT_HOLD_SOURCE_TYPES = ['recharge_refund', 'payment_dispute'] as const
export type PointHoldSourceType = (typeof POINT_HOLD_SOURCE_TYPES)[number]

export const POINT_HOLD_STATUSES = ['active', 'consumed', 'released'] as const
export type PointHoldStatus = (typeof POINT_HOLD_STATUSES)[number]

export const PAYMENT_DISPUTE_STATUSES = ['open', 'won', 'lost', 'closed'] as const
export type PaymentDisputeStatus = (typeof PAYMENT_DISPUTE_STATUSES)[number]

export const PAYMENT_RECOVERY_CASE_STATUSES = [
  'open',
  'held',
  'recovered',
  'written_off',
  'restored',
] as const
export type PaymentRecoveryCaseStatus = (typeof PAYMENT_RECOVERY_CASE_STATUSES)[number]

export const ACCOUNT_RESTRICTION_SOURCE_TYPES = ['payment_dispute'] as const
export type AccountRestrictionSourceType = (typeof ACCOUNT_RESTRICTION_SOURCE_TYPES)[number]

export const ACCOUNT_RESTRICTION_STATUSES = ['active', 'released'] as const
export type AccountRestrictionStatus = (typeof ACCOUNT_RESTRICTION_STATUSES)[number]

export const RECONCILIATION_ENVIRONMENTS = ['sandbox', 'live'] as const
export type ReconciliationEnvironment = (typeof RECONCILIATION_ENVIRONMENTS)[number]

export const RECONCILIATION_SCOPE_TYPES = ['statement', 'provider_query', 'manual'] as const
export type ReconciliationScopeType = (typeof RECONCILIATION_SCOPE_TYPES)[number]

export const RECONCILIATION_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'completed_with_mismatches',
  'failed',
] as const
export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number]

export const RECONCILIATION_MISMATCH_TYPES = [
  'provider_paid_local_unpaid',
  'local_paid_provider_not_paid',
  'paid_not_credited',
  'refund_mismatch',
  'amount_mismatch',
  'currency_mismatch',
  'duplicate_provider_payment',
  'unknown_provider_transaction',
] as const
export type ReconciliationMismatchType = (typeof RECONCILIATION_MISMATCH_TYPES)[number]

export const RECONCILIATION_ITEM_STATUSES = ['open', 'resolved', 'ignored'] as const
export type ReconciliationItemStatus = (typeof RECONCILIATION_ITEM_STATUSES)[number]

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

export const MONEY_ROUNDING_MODE = 'HALF_EVEN' as const
export type MoneyRoundingMode = typeof MONEY_ROUNDING_MODE

/** JSON money fields are decimal strings of minor units, never JSON numbers. */
export type AmountMinorString = string
