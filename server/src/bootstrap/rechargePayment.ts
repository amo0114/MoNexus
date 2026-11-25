// Payment events and workers invoke recharge use cases through composition.
// Lazy resolution keeps the transaction caller in control and avoids file initialization cycles.

export async function executeRechargeCredit(...args: Parameters<typeof import('../modules/recharge/credit.js').executeRechargeCredit>) {
  const handler = await import('../modules/recharge/credit.js')
  return handler.executeRechargeCredit(...args)
}

export async function applyRefundObservation(...args: Parameters<typeof import('../modules/recharge/refund.js').applyRefundObservation>) {
  const handler = await import('../modules/recharge/refund.js')
  return handler.applyRefundObservation(...args)
}

export async function queryProviderRefund(...args: Parameters<typeof import('../modules/recharge/refund.js').queryProviderRefund>) {
  const handler = await import('../modules/recharge/refund.js')
  return handler.queryProviderRefund(...args)
}

export async function submitProviderRefund(...args: Parameters<typeof import('../modules/recharge/refund.js').submitProviderRefund>) {
  const handler = await import('../modules/recharge/refund.js')
  return handler.submitProviderRefund(...args)
}

export async function providerSupportsRefunds(...args: Parameters<typeof import('../modules/recharge/refund.js').providerSupportsRefunds>) {
  const handler = await import('../modules/recharge/refund.js')
  return handler.providerSupportsRefunds(...args)
}

export async function applyTerminalPaymentState(...args: Parameters<typeof import('../modules/recharge/paymentCompletion.js').applyTerminalPaymentState>) {
  const handler = await import('../modules/recharge/paymentCompletion.js')
  return handler.applyTerminalPaymentState(...args)
}

export async function expireOrder(...args: Parameters<typeof import('../modules/recharge/orderLifecycle.js').expireOrder>) {
  const handler = await import('../modules/recharge/orderLifecycle.js')
  return handler.expireOrder(...args)
}

export async function recoverProviderCreate(...args: Parameters<typeof import('../modules/recharge/orderLifecycle.js').recoverProviderCreate>) {
  const handler = await import('../modules/recharge/orderLifecycle.js')
  return handler.recoverProviderCreate(...args)
}

export async function consumeLimitReservations(...args: Parameters<typeof import('../modules/recharge/limits.js').consumeLimitReservations>) {
  const handler = await import('../modules/recharge/limits.js')
  return handler.consumeLimitReservations(...args)
}
