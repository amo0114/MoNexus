import Stripe from 'stripe'

export const STRIPE_TEST_WEBHOOK_SECRET = 'whsec_test_secret'

export function signStripeFixture(payload: unknown, secret = STRIPE_TEST_WEBHOOK_SECRET): {
  rawBody: Buffer
  header: string
  payloadString: string
} {
  const payloadString = JSON.stringify(payload)
  const header = Stripe.webhooks.generateTestHeaderString({
    payload: payloadString,
    secret,
  })
  return {
    rawBody: Buffer.from(payloadString, 'utf8'),
    header,
    payloadString,
  }
}

export function stripeEventFixture(input: {
  id?: string
  type: string
  livemode?: boolean
  object: Record<string, unknown>
}): Stripe.Event {
  return {
    id: input.id ?? `evt_${input.type.replace(/[^a-z0-9]+/gi, '_')}`,
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: 1_700_000_000,
    livemode: input.livemode ?? false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: input.type as Stripe.Event['type'],
    data: {
      object: input.object as Stripe.Event.Data['object'],
    },
  } as Stripe.Event
}
