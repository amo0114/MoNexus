import { createHash } from 'node:crypto'
import Stripe from 'stripe'
import { serializeAmountMinor } from '../../../recharge/money.js'
import { RECHARGE_CURRENCIES, type PaymentAttemptStatus, type RechargeCurrency } from '../../../recharge/types.js'
import type { NormalizedPayment, NormalizedRefund } from '../types.js'
import { STRIPE_META, modeFromAccountKey, stripeAccountKey, type StripeMode } from './config.js'

export function asRechargeCurrency(value: string | null | undefined): RechargeCurrency | null {
  if (!value) return null
  const code = value.toUpperCase()
  return (RECHARGE_CURRENCIES as readonly string[]).includes(code) ? code as RechargeCurrency : null
}

export function asAmountMinor(value: number | null | undefined): bigint | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return BigInt(value)
}

export function toStripeUnitAmount(amountMinor: bigint): number {
  if (amountMinor <= 0n || amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('stripe amount is out of range')
  }
  return Number(amountMinor)
}

export function stripeMetadata(input: {
  orderId: string
  paymentIntentId: string
  paymentAttemptId: string
  amountMinor: bigint
  currency: RechargeCurrency
  providerAccountKey: string
}): Stripe.MetadataParam {
  return {
    [STRIPE_META.orderId]: input.orderId,
    [STRIPE_META.paymentIntentId]: input.paymentIntentId,
    [STRIPE_META.paymentAttemptId]: input.paymentAttemptId,
    [STRIPE_META.amountMinor]: serializeAmountMinor(input.amountMinor),
    [STRIPE_META.currency]: input.currency,
    [STRIPE_META.accountKey]: input.providerAccountKey,
  }
}

function meta(obj: { metadata?: Stripe.Metadata | null } | null | undefined, key: string): string | null {
  const value = obj?.metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function mapPaymentIntentStatus(status: string | null | undefined): PaymentAttemptStatus {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return 'requires_action'
    case 'processing':
    case 'requires_capture':
      return 'processing'
    case 'succeeded':
      return 'succeeded'
    case 'canceled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

export function mapCheckoutStatus(session: Pick<Stripe.Checkout.Session, 'status' | 'payment_status'>): PaymentAttemptStatus {
  if (session.status === 'expired') return 'cancelled'
  if (session.status === 'complete' && session.payment_status === 'paid') return 'succeeded'
  if (session.status === 'complete') return 'processing'
  if (session.status === 'open') return 'requires_action'
  return 'unknown'
}

export function mapRefundStatus(status: string | null | undefined): NormalizedRefund['status'] {
  switch (status) {
    case 'pending':
    case 'requires_action':
      return 'processing'
    case 'succeeded':
      return 'succeeded'
    case 'failed':
    case 'canceled':
      return 'failed'
    default:
      return 'unknown'
  }
}

export function mapDisputeEventType(type: string, disputeStatus?: string | null): string {
  if (type === 'charge.dispute.created') return 'dispute.opened'
  if (type === 'charge.dispute.updated') return 'dispute.updated'
  if (type === 'charge.dispute.closed') {
    if (disputeStatus === 'won') return 'dispute.won'
    if (disputeStatus === 'lost') return 'dispute.lost'
    return 'dispute.closed'
  }
  if (type.startsWith('charge.dispute.')) return `dispute.${type.slice('charge.dispute.'.length)}`
  return type
}

function livemodeMatches(mode: StripeMode, livemode: boolean | undefined): boolean {
  if (livemode == null) return true
  return mode === 'live' ? livemode === true : livemode === false
}

function expectedMatches(input: {
  amountMinor: bigint | null
  currency: RechargeCurrency | null
  metadata?: Stripe.Metadata | null
  providerAccountKey: string
  orderId?: string | null
}): boolean {
  if (input.amountMinor == null || input.currency == null) return false
  const orderId = input.metadata?.[STRIPE_META.orderId]
  if (!orderId) return false
  if (input.orderId && input.orderId !== orderId) return false
  const expectedAmount = input.metadata?.[STRIPE_META.amountMinor]
  if (expectedAmount && expectedAmount !== serializeAmountMinor(input.amountMinor)) return false
  const expectedCurrency = input.metadata?.[STRIPE_META.currency]
  if (expectedCurrency && expectedCurrency.toUpperCase() !== input.currency) return false
  const expectedAccount = input.metadata?.[STRIPE_META.accountKey]
  if (expectedAccount && expectedAccount !== input.providerAccountKey) return false
  return true
}

export function paymentFromIntent(
  intent: Stripe.PaymentIntent,
  providerAccountKey: string,
): NormalizedPayment {
  const mode = modeFromAccountKey(providerAccountKey) ?? (intent.livemode ? 'live' : 'test')
  const amountMinor = asAmountMinor(intent.amount_received || intent.amount)
  const currency = asRechargeCurrency(intent.currency)
  const captureId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id ?? null
  let status = mapPaymentIntentStatus(intent.status)
  const matched = expectedMatches({
    amountMinor,
    currency,
    metadata: intent.metadata,
    providerAccountKey,
    orderId: meta(intent, STRIPE_META.orderId),
  })
  const amountConsistent = intent.status !== 'succeeded'
    || (intent.amount_received === intent.amount && intent.amount_received > 0)
  if (status === 'succeeded' && (!matched || !amountConsistent || !livemodeMatches(mode, intent.livemode))) {
    status = 'unknown'
  }
  return {
    status,
    providerPaymentId: intent.id,
    providerOrderId: meta(intent, STRIPE_META.orderId),
    providerCaptureId: captureId,
    amountMinor: amountMinor ?? 0n,
    currency: currency ?? 'USD',
    providerAccountKey,
    immutableStateVersion: `${intent.id}:${intent.status}:${intent.amount}:${intent.currency}:${intent.amount_received}`,
    rawStatus: intent.status,
  }
}

export function paymentFromCheckout(
  session: Stripe.Checkout.Session,
  providerAccountKey: string,
): NormalizedPayment {
  const mode = modeFromAccountKey(providerAccountKey) ?? (session.livemode ? 'live' : 'test')
  const intentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id ?? session.id
  const expandedIntent = typeof session.payment_intent === 'object' && session.payment_intent
    ? session.payment_intent
    : null
  const amountMinor = asAmountMinor(session.amount_total)
  const currency = asRechargeCurrency(session.currency)
  let status = mapCheckoutStatus(session)
  const matched = expectedMatches({
    amountMinor,
    currency,
    metadata: session.metadata,
    providerAccountKey,
    orderId: session.client_reference_id ?? meta(session, STRIPE_META.orderId),
  })
  if (status === 'succeeded' && (!matched || !livemodeMatches(mode, session.livemode))) {
    status = 'unknown'
  }
  const captureId = expandedIntent && typeof expandedIntent.latest_charge === 'string'
    ? expandedIntent.latest_charge
    : null
  return {
    status,
    providerPaymentId: intentId,
    providerOrderId: session.id,
    providerCaptureId: captureId,
    amountMinor: amountMinor ?? 0n,
    currency: currency ?? 'USD',
    providerAccountKey,
    immutableStateVersion: `${session.id}:${session.status}:${session.payment_status}:${session.amount_total}:${session.currency}`,
    rawStatus: `${session.status}:${session.payment_status}`,
  }
}

export function refundFromStripe(refund: Stripe.Refund, fallbackCurrency: RechargeCurrency = 'USD'): NormalizedRefund {
  return {
    status: mapRefundStatus(refund.status),
    providerRefundId: refund.id,
    amountMinor: asAmountMinor(refund.amount) ?? 0n,
    currency: asRechargeCurrency(refund.currency) ?? fallbackCurrency,
    immutableStateVersion: `${refund.id}:${refund.status}:${refund.amount}:${refund.currency}`,
  }
}

export function accountKeyForLivemode(livemode: boolean | undefined, fallback?: string): string {
  if (livemode === true) return stripeAccountKey('live')
  if (livemode === false) return stripeAccountKey('test')
  return fallback ?? stripeAccountKey('test')
}

export function unverifiedDedupeKey(rawBody: Buffer): string {
  return `webhook:unverified:${createHash('sha256').update(rawBody).digest('hex')}`
}

export function stripeEventDedupeKey(eventId: string): string {
  return `webhook:${eventId}`
}

export function isPaymentIntent(value: unknown): value is Stripe.PaymentIntent {
  return Boolean(value && typeof value === 'object' && (value as { object?: string }).object === 'payment_intent')
}

export function isCheckoutSession(value: unknown): value is Stripe.Checkout.Session {
  return Boolean(value && typeof value === 'object' && (value as { object?: string }).object === 'checkout.session')
}

export function isDispute(value: unknown): value is Stripe.Dispute {
  return Boolean(value && typeof value === 'object' && (value as { object?: string }).object === 'dispute')
}

export function isRefund(value: unknown): value is Stripe.Refund {
  return Boolean(value && typeof value === 'object' && (value as { object?: string }).object === 'refund')
}

export function isCharge(value: unknown): value is Stripe.Charge {
  return Boolean(value && typeof value === 'object' && (value as { object?: string }).object === 'charge')
}
