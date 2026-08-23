import type { PaymentAttemptStatus, RechargeCurrency } from '../../../recharge/types.js'
import { PaypalAmountError, paypalValueToMinor } from './amounts.js'
import type { NormalizedPayment, NormalizedRefund } from '../types.js'

export type PaypalLink = {
  href?: unknown
  rel?: unknown
  method?: unknown
}

export type PaypalMoney = {
  currency_code?: unknown
  value?: unknown
}

export type PaypalPayee = {
  merchant_id?: unknown
  email_address?: unknown
}

export type PaypalCapture = {
  id?: unknown
  status?: unknown
  amount?: PaypalMoney
  custom_id?: unknown
  invoice_id?: unknown
  create_time?: unknown
  update_time?: unknown
  supplementary_data?: { related_ids?: { order_id?: unknown; capture_id?: unknown; refund_id?: unknown } }
  payee?: PaypalPayee
}

export type PaypalPurchaseUnit = {
  reference_id?: unknown
  custom_id?: unknown
  invoice_id?: unknown
  amount?: PaypalMoney
  payee?: PaypalPayee
  payments?: { captures?: PaypalCapture[] }
}

export type PaypalOrder = {
  id?: unknown
  status?: unknown
  intent?: unknown
  create_time?: unknown
  update_time?: unknown
  links?: PaypalLink[]
  purchase_units?: PaypalPurchaseUnit[]
}

export type PaypalRefundResource = {
  id?: unknown
  status?: unknown
  amount?: PaypalMoney
  update_time?: unknown
  create_time?: unknown
  supplementary_data?: { related_ids?: { order_id?: unknown; capture_id?: unknown; refund_id?: unknown } }
}

export type PaypalWebhookEvent = {
  id?: unknown
  event_type?: unknown
  resource_type?: unknown
  create_time?: unknown
  resource?: PaypalCapture & PaypalOrder & PaypalRefundResource & {
    supplementary_data?: { related_ids?: { order_id?: unknown; capture_id?: unknown; refund_id?: unknown } }
  }
}

export type PaypalMatchContext = {
  providerAccountKey: string
  /** Platform RechargeOrder UUID; compared to custom_id / reference_id / invoice_id. */
  expectedOrderId?: string
  /** PayPal Orders v2 id; compared to order.id only, never to platform UUID fields. */
  expectedPaypalOrderId?: string
  expectedAmountMinor?: bigint
  expectedCurrency?: RechargeCurrency
  merchantId?: string
  payeeEmail?: string
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function paypalString(value: unknown): string | undefined {
  return asString(value)
}

export function mapPaypalCaptureStatus(status: string | undefined): PaymentAttemptStatus {
  switch (status) {
    case 'COMPLETED':
      return 'succeeded'
    case 'PENDING':
      return 'processing'
    case 'DECLINED':
    case 'FAILED':
    case 'DENIED':
      return 'failed'
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'succeeded'
    default:
      return 'unknown'
  }
}

export function mapPaypalOrderStatus(status: string | undefined): PaymentAttemptStatus {
  switch (status) {
    case 'COMPLETED':
      return 'succeeded'
    case 'APPROVED':
    case 'SAVED':
      return 'processing'
    case 'CREATED':
    case 'PAYER_ACTION_REQUIRED':
      return 'requires_action'
    case 'VOIDED':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

export function mapPaypalRefundStatus(status: string | undefined): NormalizedRefund['status'] {
  switch (status) {
    case 'COMPLETED':
      return 'succeeded'
    case 'PENDING':
      return 'processing'
    case 'CANCELLED':
    case 'FAILED':
      return 'failed'
    default:
      return 'unknown'
  }
}

export function selectApproveHref(links: PaypalLink[] | undefined): string | undefined {
  if (!Array.isArray(links)) return undefined
  // Prefer rel=approve (no payment_source). payer-action is the same checkout URL when payment_source is set.
  const approve = links.find(link => asString(link.rel) === 'approve')
    ?? links.find(link => asString(link.rel) === 'payer-action')
  return asString(approve?.href)
}

export function assertHttpsPaypalApproveUrl(href: string, mode: 'sandbox' | 'live'): string {
  const parsed = new URL(href)
  if (parsed.protocol !== 'https:') {
    throw new Error('paypal approve url must be https')
  }
  const host = parsed.hostname.toLowerCase()
  if (mode === 'sandbox') {
    if (host !== 'www.sandbox.paypal.com' && host !== 'sandbox.paypal.com') {
      throw new Error('paypal sandbox approve host is invalid')
    }
  } else if (host !== 'www.paypal.com' && host !== 'paypal.com') {
    throw new Error('paypal live approve host is invalid')
  }
  return href
}

function firstPurchaseUnit(order: PaypalOrder): PaypalPurchaseUnit | undefined {
  return Array.isArray(order.purchase_units) ? order.purchase_units[0] : undefined
}

export function extractPaypalCapture(order: PaypalOrder): PaypalCapture | undefined {
  const unit = firstPurchaseUnit(order)
  const captures = unit?.payments?.captures
  if (!Array.isArray(captures) || captures.length === 0) return undefined
  return captures.find(item => asString(item.status) === 'COMPLETED') ?? captures[0]
}

function identityPresentAndMismatched(
  actual: string | undefined,
  expected: string | undefined,
  caseInsensitive = false,
): boolean {
  if (!actual || !expected) return false
  if (caseInsensitive) return actual.toLowerCase() !== expected.toLowerCase()
  return actual !== expected
}

function orderReferenceMismatched(unit: PaypalPurchaseUnit | undefined, expectedOrderId?: string): boolean {
  if (!expectedOrderId || !unit) return false
  const refs = [asString(unit.custom_id), asString(unit.reference_id), asString(unit.invoice_id)]
    .filter((value): value is string => Boolean(value))
  if (refs.length === 0) return false
  return refs.some(value => value !== expectedOrderId)
}

function paypalOrderIdMismatched(order: PaypalOrder, expectedPaypalOrderId?: string): boolean {
  const actual = asString(order.id)
  if (!expectedPaypalOrderId || !actual) return false
  return actual !== expectedPaypalOrderId
}

function payeeMismatched(payee: PaypalPayee | undefined, ctx: PaypalMatchContext): boolean {
  if (!payee) return false
  const merchantId = asString(payee.merchant_id)
  const email = asString(payee.email_address)
  return identityPresentAndMismatched(merchantId, ctx.merchantId)
    || identityPresentAndMismatched(email, ctx.payeeEmail, true)
}

function captureOrderId(capture: PaypalCapture | undefined, order: PaypalOrder): string | undefined {
  return asString(capture?.supplementary_data?.related_ids?.order_id)
    ?? asString(order.id)
}

export function normalizePaypalOrder(order: PaypalOrder, ctx: PaypalMatchContext): NormalizedPayment {
  const providerPaymentId = asString(order.id) ?? 'unknown'
  const unit = firstPurchaseUnit(order)
  const capture = extractPaypalCapture(order)
  const captureStatus = asString(capture?.status)
  const orderStatus = asString(order.status)
  const payee = capture?.payee ?? unit?.payee
  const money = capture?.amount ?? unit?.amount
  const currency = asString(money?.currency_code) as RechargeCurrency | undefined
  let amountMinor = 0n
  let amountValid = false
  if (currency && typeof money?.value === 'string') {
    try {
      amountMinor = paypalValueToMinor(money.value, currency)
      amountValid = true
    } catch {
      amountValid = false
    }
  }

  const providerCaptureId = asString(capture?.id) ?? null
  const versionTime = asString(capture?.update_time) ?? asString(order.update_time) ?? asString(order.create_time) ?? 'v1'
  const immutableStateVersion = `paypal:${providerPaymentId}:${providerCaptureId ?? 'none'}:${captureStatus ?? orderStatus ?? 'unknown'}:${versionTime}`

  // Only authenticated capture COMPLETED can become succeeded; order COMPLETED is not enough.
  let status: PaymentAttemptStatus
  if (captureStatus === 'COMPLETED') {
    status = 'succeeded'
  } else if (capture) {
    status = mapPaypalCaptureStatus(captureStatus)
  } else {
    status = mapPaypalOrderStatus(orderStatus === 'COMPLETED' ? 'APPROVED' : orderStatus)
  }
  if (status === 'succeeded') {
    const amountMismatch = ctx.expectedAmountMinor !== undefined && (!amountValid || amountMinor !== ctx.expectedAmountMinor)
    const currencyMismatch = ctx.expectedCurrency !== undefined && currency !== ctx.expectedCurrency
    const orderMismatch = orderReferenceMismatched(unit, ctx.expectedOrderId)
      || (ctx.expectedOrderId && asString(capture?.custom_id) && asString(capture?.custom_id) !== ctx.expectedOrderId)
      || paypalOrderIdMismatched(order, ctx.expectedPaypalOrderId)
    const payeeMismatch = payeeMismatched(payee, ctx)
    const missingMoney = !amountValid || !currency
    if (amountMismatch || currencyMismatch || orderMismatch || payeeMismatch || missingMoney) {
      status = 'failed'
    }
  }

  return {
    status,
    providerPaymentId,
    providerOrderId: captureOrderId(capture, order) ?? providerPaymentId,
    providerCaptureId,
    amountMinor,
    currency: currency ?? (ctx.expectedCurrency ?? 'USD'),
    providerAccountKey: ctx.providerAccountKey,
    immutableStateVersion,
    rawStatus: captureStatus ?? orderStatus,
  }
}

export function normalizePaypalCaptureResource(
  resource: PaypalCapture,
  ctx: PaypalMatchContext,
  orderId?: string,
): NormalizedPayment {
  const syntheticOrder: PaypalOrder = {
    id: orderId ?? asString(resource.supplementary_data?.related_ids?.order_id) ?? asString(resource.id),
    status: asString(resource.status) === 'COMPLETED' ? 'COMPLETED' : asString(resource.status),
    update_time: resource.update_time,
    create_time: resource.create_time,
    purchase_units: [{
      custom_id: resource.custom_id,
      invoice_id: resource.invoice_id,
      amount: resource.amount,
      payee: resource.payee,
      payments: { captures: [resource] },
    }],
  }
  return normalizePaypalOrder(syntheticOrder, ctx)
}

export function normalizePaypalRefund(resource: PaypalRefundResource): NormalizedRefund {
  const status = mapPaypalRefundStatus(asString(resource.status))
  const currency = asString(resource.amount?.currency_code) ?? 'USD'
  let amountMinor = 0n
  try {
    if (typeof resource.amount?.value === 'string') {
      amountMinor = paypalValueToMinor(resource.amount.value, currency)
    }
  } catch (err) {
    if (!(err instanceof PaypalAmountError)) throw err
  }
  const related = resource.supplementary_data?.related_ids
  const id = asString(related?.refund_id) ?? asString(resource.id) ?? 'unknown'
  const versionTime = asString(resource.update_time) ?? asString(resource.create_time) ?? 'v1'
  return {
    status,
    providerRefundId: id,
    providerPaymentId: asString(related?.order_id) ?? null,
    providerCaptureId: asString(related?.capture_id) ?? null,
    amountMinor,
    currency: currency as RechargeCurrency,
    immutableStateVersion: `paypal-refund:${id}:${asString(resource.status) ?? 'unknown'}:${versionTime}`,
  }
}

export function unknownPaypalPayment(input: {
  providerPaymentId: string
  providerAccountKey: string
  amountMinor: bigint
  currency: RechargeCurrency
  rawStatus?: string
}): NormalizedPayment {
  return {
    status: 'unknown',
    providerPaymentId: input.providerPaymentId,
    providerOrderId: input.providerPaymentId,
    providerCaptureId: null,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerAccountKey: input.providerAccountKey,
    immutableStateVersion: `paypal:${input.providerPaymentId}:none:unknown:timeout`,
    rawStatus: input.rawStatus ?? 'unknown',
  }
}
