const ORDER_KEY = 'monexus:recharge:pendingOrderId'
const COMPLETE_PREFIX = 'monexus:recharge:completeKey:'

export function rememberPendingOrder(orderId: string): void {
  sessionStorage.setItem(ORDER_KEY, orderId)
}

export function takePendingOrder(): string | null {
  const value = sessionStorage.getItem(ORDER_KEY)
  if (value) sessionStorage.removeItem(ORDER_KEY)
  return value
}

export function peekPendingOrder(): string | null {
  return sessionStorage.getItem(ORDER_KEY)
}

export function completeIdempotencyKey(orderId: string): string {
  const key = `${COMPLETE_PREFIX}${orderId}`
  const existing = sessionStorage.getItem(key)
  if (existing) return existing
  const next = crypto.randomUUID()
  sessionStorage.setItem(key, next)
  return next
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}
