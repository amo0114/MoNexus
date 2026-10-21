// Public recharge use cases. Implementations depend on their specific modules,
// so this entry point never participates in internal orchestration cycles.
import { requestRechargeRefund } from './refund.js'

export { getRechargeConfig, createQuote, QUOTE_TTL_MS } from './quoteService.js'
export { listOrders, getOrder } from './orderQueries.js'
export { createOrder, cancelOrder, expireOrder, recoverProviderCreate, ORDER_TTL_MS, DISCLOSURE_VERSION } from './orderLifecycle.js'
export { completeOrder, applyTerminalPaymentState } from './paymentCompletion.js'

export async function requestRefund(userId: number, orderId: string, idempotencyKey: string) {
  return requestRechargeRefund({ userId, orderId, idempotencyKey })
}
