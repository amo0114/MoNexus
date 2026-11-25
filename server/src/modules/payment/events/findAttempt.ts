import type { Prisma } from '@prisma/client'

export async function findPaymentAttempt(db: Pick<Prisma.TransactionClient, 'paymentAttempt'>, identity: {
  provider: string
  providerAccountKey: string
  providerPaymentId: string
  stripeSessionId?: string
}) {
  const { provider, providerAccountKey, providerPaymentId, stripeSessionId } = identity
  const scope = { provider, providerAccountKey }
  const direct = await db.paymentAttempt.findFirst({ where: { ...scope, providerPaymentId } })
  if (direct || !stripeSessionId || !providerPaymentId.startsWith('pi_')) return direct

  // New Checkout attempts initially use the Session ID until a verified
  // confirmation binds the PaymentIntent.
  return db.paymentAttempt.findFirst({
    where: { ...scope, providerPaymentId: stripeSessionId, providerOrderId: stripeSessionId },
  })
}
