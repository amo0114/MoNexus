export const PAYPAL_FIXTURE_ORDER_ID = '5O190127TN364715T'
export const PAYPAL_FIXTURE_CAPTURE_ID = '3C679366HH908993F'
export const PAYPAL_FIXTURE_REFUND_ID = '1JU08902781691411'
export const PAYPAL_FIXTURE_WEBHOOK_ID = 'WH-2W4268K3AW0585242-67976317FL4543714'
export const PAYPAL_FIXTURE_MERCHANT_ID = 'QDGTZ7B92B9QT'
export const PAYPAL_FIXTURE_ORDER_UUID = '11111111-2222-4333-8444-555555555555'
export const PAYPAL_FIXTURE_AMOUNT_VALUE = '10.00'
export const PAYPAL_FIXTURE_AMOUNT_MINOR = 1000n

export const PAYPAL_SANDBOX_CREDENTIALS = {
  mode: 'sandbox' as const,
  clientId: 'sandbox-client-id',
  clientSecret: 'sandbox-client-secret',
  webhookId: '0NH55953DH663215D',
  apiBaseUrl: 'https://api-m.sandbox.paypal.com',
  merchantId: PAYPAL_FIXTURE_MERCHANT_ID,
  payeeEmail: 'merchant@example.com',
}

export const PAYPAL_LIVE_CREDENTIALS = {
  mode: 'live' as const,
  clientId: 'live-client-id',
  clientSecret: 'live-client-secret',
  webhookId: 'LIVEWEBHOOKID123',
  apiBaseUrl: 'https://api-m.paypal.com',
  merchantId: PAYPAL_FIXTURE_MERCHANT_ID,
}

export function paypalApproveLinks(mode: 'sandbox' | 'live' = 'sandbox', rel: 'approve' | 'payer-action' = 'approve') {
  const host = mode === 'live' ? 'www.paypal.com' : 'www.sandbox.paypal.com'
  const apiHost = mode === 'live' ? 'api-m.paypal.com' : 'api-m.sandbox.paypal.com'
  return [
    { href: `https://${apiHost}/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`, rel: 'self', method: 'GET' },
    { href: `https://${host}/checkoutnow?token=${PAYPAL_FIXTURE_ORDER_ID}`, rel, method: 'GET' },
  ]
}

export function paypalMinimalCompletedCaptureFixture() {
  return {
    id: PAYPAL_FIXTURE_ORDER_ID,
    status: 'COMPLETED',
    links: [
      { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`, rel: 'self', method: 'GET' },
    ],
  }
}

export function paypalCreatedOrderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYPAL_FIXTURE_ORDER_ID,
    status: 'PAYER_ACTION_REQUIRED',
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: PAYPAL_FIXTURE_ORDER_UUID,
      custom_id: PAYPAL_FIXTURE_ORDER_UUID,
      invoice_id: PAYPAL_FIXTURE_ORDER_UUID,
      amount: { currency_code: 'USD', value: PAYPAL_FIXTURE_AMOUNT_VALUE },
      payee: { merchant_id: PAYPAL_FIXTURE_MERCHANT_ID, email_address: 'merchant@example.com' },
    }],
    links: paypalApproveLinks(),
    ...overrides,
  }
}

export function paypalCompletedOrderFixture(overrides: {
  captureStatus?: string
  amountValue?: string
  currency?: string
  customId?: string
  merchantId?: string
  orderId?: string
  captureId?: string
} = {}) {
  const orderId = overrides.orderId ?? PAYPAL_FIXTURE_ORDER_ID
  const captureStatus = overrides.captureStatus ?? 'COMPLETED'
  return {
    id: orderId,
    status: captureStatus === 'COMPLETED' ? 'COMPLETED' : 'APPROVED',
    intent: 'CAPTURE',
    create_time: '2026-08-19T10:00:00Z',
    update_time: '2026-08-19T10:00:01Z',
    purchase_units: [{
      reference_id: overrides.customId ?? PAYPAL_FIXTURE_ORDER_UUID,
      custom_id: overrides.customId ?? PAYPAL_FIXTURE_ORDER_UUID,
      invoice_id: overrides.customId ?? PAYPAL_FIXTURE_ORDER_UUID,
      amount: {
        currency_code: overrides.currency ?? 'USD',
        value: overrides.amountValue ?? PAYPAL_FIXTURE_AMOUNT_VALUE,
      },
      payee: {
        merchant_id: overrides.merchantId ?? PAYPAL_FIXTURE_MERCHANT_ID,
        email_address: 'merchant@example.com',
      },
      payments: {
        captures: [{
          id: overrides.captureId ?? PAYPAL_FIXTURE_CAPTURE_ID,
          status: captureStatus,
          amount: {
            currency_code: overrides.currency ?? 'USD',
            value: overrides.amountValue ?? PAYPAL_FIXTURE_AMOUNT_VALUE,
          },
          custom_id: overrides.customId ?? PAYPAL_FIXTURE_ORDER_UUID,
          final_capture: true,
          create_time: '2026-08-19T10:00:00Z',
          update_time: '2026-08-19T10:00:01Z',
        }],
      },
    }],
  }
}

export function paypalCaptureCompletedWebhookFixture(overrides: {
  eventId?: string
  captureStatus?: string
  amountValue?: string
  currency?: string
  merchantId?: string
  orderId?: string
} = {}) {
  const captureStatus = overrides.captureStatus ?? 'COMPLETED'
  return {
    id: overrides.eventId ?? PAYPAL_FIXTURE_WEBHOOK_ID,
    event_version: '1.0',
    create_time: '2026-08-19T10:00:02Z',
    resource_type: 'capture',
    resource_version: '2.0',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    summary: 'Payment completed for $ 10.00 USD',
    resource: {
      id: PAYPAL_FIXTURE_CAPTURE_ID,
      status: captureStatus,
      amount: {
        currency_code: overrides.currency ?? 'USD',
        value: overrides.amountValue ?? PAYPAL_FIXTURE_AMOUNT_VALUE,
      },
      custom_id: PAYPAL_FIXTURE_ORDER_UUID,
      final_capture: true,
      create_time: '2026-08-19T10:00:00Z',
      update_time: '2026-08-19T10:00:01Z',
      payee: {
        email_address: 'merchant@example.com',
        merchant_id: overrides.merchantId ?? PAYPAL_FIXTURE_MERCHANT_ID,
      },
      supplementary_data: {
        related_ids: { order_id: overrides.orderId ?? PAYPAL_FIXTURE_ORDER_ID },
      },
    },
  }
}

export function paypalApprovedOrderWebhookFixture() {
  return {
    id: 'WH-ORDER-APPROVED-1',
    event_type: 'CHECKOUT.ORDER.APPROVED',
    resource_type: 'checkout-order',
    resource: paypalCreatedOrderFixture({ status: 'APPROVED' }),
  }
}

export function paypalRefundFixture(status = 'COMPLETED') {
  return {
    id: PAYPAL_FIXTURE_REFUND_ID,
    status,
    amount: { currency_code: 'USD', value: PAYPAL_FIXTURE_AMOUNT_VALUE },
    create_time: '2026-08-19T11:00:00Z',
    update_time: '2026-08-19T11:00:01Z',
  }
}

export function paypalWebhookHeaders(overrides: Record<string, string> = {}) {
  return {
    'paypal-transmission-id': 'db49fb10-1343-11ef-ac58-e32457403f67',
    'paypal-transmission-time': '2026-08-19T10:00:02Z',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'dGVzdC1zaWduYXR1cmU=',
    ...overrides,
  }
}
