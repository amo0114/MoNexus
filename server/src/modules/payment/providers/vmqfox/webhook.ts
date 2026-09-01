import { createHash } from 'node:crypto'
import { logger } from '../../../../lib/logger.js'
import { yuanStringToAmountMinor } from './amount.js'
import { paymentMethodFromPayType, type VmqfoxAdapterConfig } from './config.js'
import { callbackSignV2, signaturesEqual } from './sign.js'
import { immutableStateVersion, mapVmqfoxState } from './normalize.js'
import type { NormalizedProviderEvent } from '../types.js'

export const VMQFOX_WEBHOOK_SUCCESS_BODY = 'success'
export const VMQFOX_WEBHOOK_FAILURE_BODY = 'failure'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseFormUrlEncoded(raw: Buffer): Record<string, string> {
  const params = new URLSearchParams(raw.toString('utf8'))
  const fields: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    fields[key] = value
  }
  return fields
}

export function vmqfoxPaidDedupeKey(input: {
  accountKey: string
  payId: string
  type: string
  price: string
  reallyPrice: string
}): string {
  const material = `${input.accountKey}|${input.payId}|${input.type}|${input.price}|${input.reallyPrice}`
  return `vmqfox:paid:v1:${createHash('sha256').update(material, 'utf8').digest('hex')}`
}

function unverifiedEvent(
  config: VmqfoxAdapterConfig,
  fields: Record<string, string>,
  reason: string,
): NormalizedProviderEvent {
  logger.warn({
    event: 'payment.vmqfox_notify_ignored',
    provider: 'vmqfox',
    reason,
  }, 'vmqfox notify ignored')
  return {
    eventType: 'payment.failed_verification',
    providerEventId: null,
    providerPaymentId: fields.payId || null,
    providerCaptureId: null,
    providerAccountKey: config.accountKey,
    dedupeKey: vmqfoxPaidDedupeKey({
      accountKey: config.accountKey,
      payId: fields.payId ?? '',
      type: fields.type ?? '',
      price: fields.price ?? '',
      reallyPrice: fields.reallyPrice ?? '',
    }),
    payment: null,
    signatureVerified: false,
  }
}

export function verifyAndNormalizeNotify(
  config: VmqfoxAdapterConfig,
  rawBody: Buffer,
): NormalizedProviderEvent {
  const fields = parseFormUrlEncoded(rawBody)
  const payId = fields.payId ?? ''
  const param = fields.param ?? ''
  const type = fields.type ?? ''
  const price = fields.price ?? ''
  const reallyPrice = fields.reallyPrice ?? ''
  const sign = fields.sign ?? ''

  if (!payId || !type || !price || !reallyPrice || !sign) {
    return unverifiedEvent(config, fields, 'required_field_missing')
  }

  const expected = callbackSignV2({ payId, param, type, price, reallyPrice }, config.merchantKey)
  if (!signaturesEqual(sign, expected)) {
    return unverifiedEvent(config, fields, 'signature_failed')
  }

  const method = paymentMethodFromPayType(type)
  if (!method) {
    logger.warn({ event: 'payment.vmqfox_notify_ignored', provider: 'vmqfox', reason: 'type_invalid' }, 'vmqfox notify ignored')
    return {
      eventType: 'payment.ignored_mismatch',
      providerPaymentId: payId,
      providerAccountKey: config.accountKey,
      dedupeKey: vmqfoxPaidDedupeKey({ accountKey: config.accountKey, payId, type, price, reallyPrice }),
      payment: null,
      signatureVerified: true,
    }
  }

  let quotedAmountMinor: bigint
  let amountMinor: bigint
  try {
    quotedAmountMinor = yuanStringToAmountMinor(price)
    amountMinor = yuanStringToAmountMinor(reallyPrice)
  } catch {
    logger.warn({ event: 'payment.vmqfox_notify_ignored', provider: 'vmqfox', reason: 'amount_unparseable' }, 'vmqfox notify ignored')
    return {
      eventType: 'payment.ignored_mismatch',
      providerPaymentId: payId,
      providerAccountKey: config.accountKey,
      dedupeKey: vmqfoxPaidDedupeKey({ accountKey: config.accountKey, payId, type, price, reallyPrice }),
      payment: null,
      signatureVerified: true,
    }
  }

  if (!UUID_PATTERN.test(payId) || !UUID_PATTERN.test(param)) {
    logger.warn({ event: 'payment.vmqfox_notify_ignored', provider: 'vmqfox', reason: 'identity_unparseable' }, 'vmqfox notify ignored')
    return {
      eventType: 'payment.ignored_mismatch',
      providerPaymentId: payId,
      providerAccountKey: config.accountKey,
      dedupeKey: vmqfoxPaidDedupeKey({ accountKey: config.accountKey, payId, type, price, reallyPrice }),
      payment: null,
      signatureVerified: true,
    }
  }

  const status = mapVmqfoxState(1) ?? 'succeeded'
  return {
    eventType: 'payment.succeeded',
    providerEventId: null,
    providerPaymentId: payId,
    providerCaptureId: null,
    providerAccountKey: config.accountKey,
    dedupeKey: vmqfoxPaidDedupeKey({ accountKey: config.accountKey, payId, type, price, reallyPrice }),
    payment: {
      status,
      providerPaymentId: payId,
      providerCaptureId: null,
      amountMinor,
      quotedAmountMinor,
      quotedOrderId: param,
      quotedPaymentMethod: method,
      currency: 'CNY',
      providerAccountKey: config.accountKey,
      immutableStateVersion: immutableStateVersion(1, payId, reallyPrice),
      rawStatus: '1',
    },
    signatureVerified: true,
  }
}
