type PaymentIdentity = {
  providerPaymentId: string | null
  providerOrderId?: string | null
}

export function stripeCheckoutSessionId(provider: string, providerOrderId?: string | null): string | undefined {
  return provider === 'stripe' && providerOrderId?.startsWith('cs_') ? providerOrderId : undefined
}

export function matchesStripePaymentIdentity(attempt: PaymentIdentity, payment: PaymentIdentity): boolean {
  const sessionId = stripeCheckoutSessionId('stripe', payment.providerOrderId)
  if (sessionId && attempt.providerOrderId !== sessionId) return false
  return attempt.providerPaymentId === payment.providerPaymentId
    || Boolean(sessionId && attempt.providerPaymentId === sessionId && payment.providerPaymentId?.startsWith('pi_'))
}
