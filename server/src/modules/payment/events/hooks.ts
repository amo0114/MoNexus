/** Test-only write-point injection. Production callers must leave this unset. */
export type ApplyWritePoint =
  | 'after_lock_observation'
  | 'after_lock_order'
  | 'after_cas_paid'
  | 'after_consume_reservation'
  | 'after_credit_task'
  | 'after_mark_processed'

export type CreditWritePoint =
  | 'after_lock'
  | 'after_points_check'
  | 'after_credit_row'
  | 'after_balance'
  | 'after_point_log'
  | 'after_cas_credited'
  | 'after_notification'

export const paymentTestHooks = {
  applyFailAt: null as ApplyWritePoint | null,
  creditFailAt: null as CreditWritePoint | null,
  skipCreditAfterApply: false,
  throwAfterRefundProcessingCas: false,
  onWrite: null as ((point: string) => void) | null,
}

export function resetPaymentTestHooks() {
  paymentTestHooks.applyFailAt = null
  paymentTestHooks.creditFailAt = null
  paymentTestHooks.skipCreditAfterApply = false
  paymentTestHooks.throwAfterRefundProcessingCas = false
  paymentTestHooks.onWrite = null
}

export function tripWriteHook(point: ApplyWritePoint | CreditWritePoint) {
  paymentTestHooks.onWrite?.(point)
  if (paymentTestHooks.applyFailAt === point || paymentTestHooks.creditFailAt === point) {
    throw new Error(`TEST_ROLLBACK:${point}`)
  }
}
