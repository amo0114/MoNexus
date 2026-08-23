import { createHash } from 'node:crypto'
import { logger } from '../../../../lib/logger.js'
import { yuanStringToAmountMinor } from './amount.js'
import type { AlipayAdapterConfig } from './config.js'
import { alipayAccountKey } from './config.js'
import type { AlipaySdkSurface } from './gateway.js'
import { pickString } from './gateway.js'
import type { NormalizedPayment, NormalizedProviderEvent } from '../types.js'

export const ALIPAY_SUCCESS_TRADE_STATUSES = ['TRADE_SUCCESS', 'TRADE_FINISHED'] as const
export const ALIPAY_WAIT_TRADE_STATUS = 'WAIT_BUYER_PAY'
export const ALIPAY_CLOSED_TRADE_STATUS = 'TRADE_CLOSED'

export type AlipayIdentityMatch = {
  appId: string
  sellerId: string
  outTradeNo: string
  tradeNo: string
  totalAmountYuan: string
  tradeStatus: string
}

export function parseFormUrlEncoded(raw: Buffer): Record<string, string> {
  const body = raw.toString('utf8')
  const params = new URLSearchParams(body)
  const fields: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    fields[key] = value
  }
  return fields
}

export function mapAlipayTradeStatus(tradeStatus: string): NormalizedPayment['status'] {
  if ((ALIPAY_SUCCESS_TRADE_STATUSES as readonly string[]).includes(tradeStatus)) return 'succeeded'
  if (tradeStatus === ALIPAY_WAIT_TRADE_STATUS) return 'requires_action'
  if (tradeStatus === ALIPAY_CLOSED_TRADE_STATUS) return 'cancelled'
  return 'unknown'
}

export function notifyDedupeKey(notifyId: string | undefined, fields: Record<string, string>): string {
  if (notifyId && notifyId.length > 0) return `notify:${notifyId}`
  const canonical = JSON.stringify([
    fields.out_trade_no ?? '',
    fields.trade_no ?? '',
    fields.trade_status ?? '',
    fields.total_amount ?? '',
  ])
  return `notify:hash:${createHash('sha256').update(canonical).digest('hex')}`
}

function securityIgnore(reason: string, extra?: Record<string, string>) {
  logger.warn({
    event: 'payment.alipay_notify_ignored',
    provider: 'alipay',
    reason,
    ...extra,
  }, 'alipay notify ignored')
}

export function matchAlipayIdentity(
  config: AlipayAdapterConfig,
  fields: Record<string, unknown>,
  source: 'notify' | 'query',
): AlipayIdentityMatch | null {
  const appId = pickString(fields, 'app_id', 'appId') ?? (source === 'query' ? config.appId : undefined)
  const sellerId = pickString(fields, 'seller_id', 'sellerId')
  const outTradeNo = pickString(fields, 'out_trade_no', 'outTradeNo')
  const tradeNo = pickString(fields, 'trade_no', 'tradeNo')
  const totalAmountYuan = pickString(fields, 'total_amount', 'totalAmount')
  const tradeStatus = pickString(fields, 'trade_status', 'tradeStatus')
  if (!appId || appId !== config.appId) {
    securityIgnore('app_id_mismatch', { source })
    return null
  }
  if (sellerId && sellerId !== config.sellerId) {
    securityIgnore('seller_id_mismatch', { source })
    return null
  }
  if (source === 'notify' && sellerId !== config.sellerId) {
    securityIgnore('seller_id_missing', { source })
    return null
  }
  if (!outTradeNo || !tradeNo || !totalAmountYuan || !tradeStatus) {
    securityIgnore('required_field_missing', { source })
    return null
  }
  try {
    yuanStringToAmountMinor(totalAmountYuan)
  } catch {
    securityIgnore('amount_unparseable', { source })
    return null
  }
  return { appId, sellerId: sellerId ?? config.sellerId, outTradeNo, tradeNo, totalAmountYuan, tradeStatus }
}

export function normalizeMatchedPayment(
  config: AlipayAdapterConfig,
  match: AlipayIdentityMatch,
  extra?: { immutableStateVersion?: string; rawStatus?: string },
): NormalizedPayment | null {
  const mapped = mapAlipayTradeStatus(match.tradeStatus)
  if (mapped !== 'succeeded') {
    return {
      status: mapped,
      providerPaymentId: match.outTradeNo,
      providerOrderId: match.outTradeNo,
      providerCaptureId: match.tradeNo,
      amountMinor: yuanStringToAmountMinor(match.totalAmountYuan),
      currency: 'CNY',
      providerAccountKey: alipayAccountKey(config.mode, config.appId),
      immutableStateVersion: extra?.immutableStateVersion ?? `${match.tradeStatus}:${match.tradeNo}:${match.totalAmountYuan}`,
      rawStatus: extra?.rawStatus ?? match.tradeStatus,
    }
  }
  return {
    status: 'succeeded',
    providerPaymentId: match.outTradeNo,
    providerOrderId: match.outTradeNo,
    providerCaptureId: match.tradeNo,
    amountMinor: yuanStringToAmountMinor(match.totalAmountYuan),
    currency: 'CNY',
    providerAccountKey: alipayAccountKey(config.mode, config.appId),
    immutableStateVersion: extra?.immutableStateVersion ?? `${match.tradeStatus}:${match.tradeNo}:${match.totalAmountYuan}`,
    rawStatus: extra?.rawStatus ?? match.tradeStatus,
  }
}

export function verifyAndNormalizeNotify(
  config: AlipayAdapterConfig,
  sdk: AlipaySdkSurface,
  rawBody: Buffer,
): NormalizedProviderEvent {
  const fields = parseFormUrlEncoded(rawBody)
  const notifyId = fields.notify_id
  const accountKey = alipayAccountKey(config.mode, config.appId)
  const verified = sdk.checkNotifySign(fields, true)
  if (!verified) {
    securityIgnore('signature_failed')
    return {
      eventType: 'payment.failed_verification',
      providerEventId: notifyId ?? null,
      providerPaymentId: fields.out_trade_no ?? null,
      providerCaptureId: fields.trade_no ?? null,
      providerAccountKey: accountKey,
      dedupeKey: notifyDedupeKey(notifyId, fields),
      payment: null,
      signatureVerified: false,
    }
  }

  const match = matchAlipayIdentity(config, fields, 'notify')
  if (!match) {
    return {
      eventType: 'payment.ignored_mismatch',
      providerEventId: notifyId ?? null,
      providerPaymentId: fields.out_trade_no ?? null,
      providerCaptureId: fields.trade_no ?? null,
      providerAccountKey: accountKey,
      dedupeKey: notifyDedupeKey(notifyId, fields),
      payment: null,
      signatureVerified: true,
    }
  }

  const payment = normalizeMatchedPayment(config, match)
  const eventType = payment?.status === 'succeeded'
    ? 'payment.succeeded'
    : `payment.${payment?.status ?? 'updated'}`
  return {
    eventType,
    providerEventId: notifyId ?? null,
    providerPaymentId: match.outTradeNo,
    providerCaptureId: match.tradeNo,
    providerAccountKey: accountKey,
    dedupeKey: notifyDedupeKey(notifyId, fields),
    payment,
    signatureVerified: true,
  }
}
