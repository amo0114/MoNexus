import { createHash } from 'node:crypto'
import {
  paymentMethodUnavailable,
  paymentProviderUnavailable,
  paymentStateUnknown,
} from '../../../../lib/httpError.js'
import { serializeAmountMinor } from '../../../recharge/money.js'
import type { RechargeCurrency } from '../../../recharge/types.js'
import type {
  CloseProviderPaymentInput,
  CloseResult,
  CreateProviderPaymentInput,
  CreateProviderRefundInput,
  NormalizedPayment,
  NormalizedProviderEvent,
  NormalizedRefund,
  PaymentProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderEnvironment,
  ProviderPaymentAction,
  QueryProviderPaymentInput,
  QueryProviderRefundInput,
  RawWebhookInput,
} from '../types.js'
import {
  isWechatPayConfigured,
  loadWechatPayCredentials,
  requireWechatPayCredentials,
  wechatPayAccountKey,
  type WechatPayCredentials,
} from './credentials.js'
import {
  buildResponseSignMessage,
  decryptAesGcm,
  headerValue,
  isTimestampFresh,
  rsaSha256Verify,
} from './crypto.js'
import { WECHAT_PAY_NOTIFY_MAX_ATTEMPTS } from './fixtures.js'
import {
  assertNativeCnyAmount,
  fenToAmountMinor,
  identityMatches,
  mapRefundStatus,
  refundStatusOf,
  toNormalizedPayment,
  toOutTradeNo,
  WECHAT_PAY_CNY,
  WECHAT_PAY_NATIVE_METHOD,
  type WechatRefund,
  type WechatTransaction,
} from './mapping.js'
import {
  defaultWechatPayHttp,
  wechatErrorCode,
  wechatPayRequest,
  WechatPayUnknownResultError,
  type WechatPayHttp,
} from './client.js'

export const WECHAT_PAY_PROVIDER_NAME = 'wechat_pay' as const
export const WECHAT_PAY_CAPABILITY_VERSION = 'wechat-pay-native-v1'
export const WECHAT_PAY_CODE_URL_TTL_MS = 2 * 60 * 60 * 1000

export {
  isWechatPayConfigured,
  loadWechatPayCredentials,
  toOutTradeNo,
  WECHAT_PAY_NOTIFY_MAX_ATTEMPTS,
}

export type WechatPayProviderOptions = {
  credentials?: WechatPayCredentials | null
  http?: WechatPayHttp
  now?: () => Date
}

export function wechatPayWebhookSuccessAck(): { status: 200 } {
  return { status: 200 }
}

export function wechatPayWebhookFailureAck(): { status: 400; body: { code: 'FAIL'; message: string } } {
  return { status: 400, body: { code: 'FAIL', message: '失败' } }
}

function digestCapabilities(input: {
  accountKey: string
  environment: string
  currency: string
  paymentMethod: string
  version: string
  minimumAmountMinor: bigint
}): string {
  return createHash('sha256').update(JSON.stringify({
    accountKey: input.accountKey,
    environment: input.environment,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
    version: input.version,
    minimumAmountMinor: serializeAmountMinor(input.minimumAmountMinor),
    maximumAmountMinor: null,
    methods: [WECHAT_PAY_NATIVE_METHOD],
  })).digest('hex')
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function requestOpts(
  credentials: WechatPayCredentials,
  http: WechatPayHttp,
  now: () => Date,
) {
  return { credentials, http, now }
}

async function queryRefundById(
  credentials: WechatPayCredentials,
  http: WechatPayHttp,
  now: () => Date,
  outRefundNo: string,
  fallbackAmountMinor: bigint,
): Promise<NormalizedRefund> {
  const result = await wechatPayRequest({
    ...requestOpts(credentials, http, now),
    method: 'GET',
    pathAndQuery: `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
  })
  if (result.status < 200 || result.status >= 300) throw paymentStateUnknown()
  const row = result.json as WechatRefund
  const status = mapRefundStatus(refundStatusOf(row))
  const amountMinor = fenToAmountMinor(row.amount?.refund) ?? fallbackAmountMinor
  return {
    status,
    providerRefundId: row.out_refund_no ?? outRefundNo,
    amountMinor,
    currency: WECHAT_PAY_CNY,
    immutableStateVersion: `${refundStatusOf(row) ?? 'UNKNOWN'}:${row.out_refund_no ?? outRefundNo}`,
  }
}

async function queryTransaction(
  credentials: WechatPayCredentials,
  http: WechatPayHttp,
  now: () => Date,
  outTradeNo: string,
): Promise<NormalizedPayment> {
  const result = await wechatPayRequest({
    ...requestOpts(credentials, http, now),
    method: 'GET',
    pathAndQuery: `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(credentials.mchid)}`,
  })
  if (result.status === 404) throw paymentStateUnknown()
  if (result.status < 200 || result.status >= 300) throw paymentStateUnknown()
  const transaction = result.json as WechatTransaction
  return toNormalizedPayment({
    providerAccountKey: wechatPayAccountKey(credentials.mchid),
    transaction,
    expectedMchid: credentials.mchid,
    expectedAppid: credentials.appid,
  })
}

function encryptResourcePayload(input: {
  credentials: WechatPayCredentials
  rawBody: Buffer
}): { eventType: string; id: string; resource: Record<string, unknown> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.rawBody.toString('utf8')) as unknown
  } catch {
    return null
  }
  const obj = asObject(parsed)
  if (!obj) return null
  const resource = asObject(obj.resource)
  if (!resource) return null
  return {
    eventType: typeof obj.event_type === 'string' ? obj.event_type : '',
    id: typeof obj.id === 'string' ? obj.id : '',
    resource,
  }
}

export function createWechatPayProvider(options: WechatPayProviderOptions = {}): PaymentProvider {
  const http = options.http ?? defaultWechatPayHttp
  const now = options.now ?? (() => new Date())
  const credentialsOverride = options.credentials

  const credentialsOf = (): WechatPayCredentials => {
    const credentials = credentialsOverride === undefined
      ? loadWechatPayCredentials()
      : credentialsOverride
    return requireWechatPayCredentials(credentials)
  }

  return {
    name: WECHAT_PAY_PROVIDER_NAME,

    async selectAccount(input: {
      environment: ProviderEnvironment
      currency: RechargeCurrency
      paymentMethod: string
    }) {
      if (input.environment !== 'live') throw paymentProviderUnavailable()
      if (input.currency !== WECHAT_PAY_CNY) throw paymentMethodUnavailable()
      if (input.paymentMethod !== WECHAT_PAY_NATIVE_METHOD) throw paymentMethodUnavailable()
      const credentials = credentialsOf()
      return { providerAccountKey: wechatPayAccountKey(credentials.mchid) }
    },

    async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
      const credentials = credentialsOf()
      const expectedKey = wechatPayAccountKey(credentials.mchid)
      if (context.providerAccountKey !== expectedKey) throw paymentMethodUnavailable()
      if (context.environment !== 'live') throw paymentProviderUnavailable()
      if (context.currency !== WECHAT_PAY_CNY) throw paymentMethodUnavailable()
      if (context.paymentMethod !== WECHAT_PAY_NATIVE_METHOD) throw paymentMethodUnavailable()
      const minimumAmountMinor = 1n
      return {
        supportedCurrencies: [WECHAT_PAY_CNY],
        paymentMethods: [WECHAT_PAY_NATIVE_METHOD],
        actionTypes: ['qr_code'],
        supportsRefunds: true,
        supportsPartialRefund: false,
        supportsDisputes: false,
        supportsReconciliation: false,
        supportsBuyerApprovalCapture: false,
        minimumAmountMinor,
        maximumAmountMinor: null,
        capabilityVersion: WECHAT_PAY_CAPABILITY_VERSION,
        capabilityDigest: digestCapabilities({
          accountKey: context.providerAccountKey,
          environment: context.environment,
          currency: context.currency,
          paymentMethod: context.paymentMethod,
          version: WECHAT_PAY_CAPABILITY_VERSION,
          minimumAmountMinor,
        }),
      }
    },

    async createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentAction> {
      const credentials = credentialsOf()
      if (input.providerAccountKey !== wechatPayAccountKey(credentials.mchid)) {
        throw paymentProviderUnavailable()
      }
      if (input.paymentMethod !== WECHAT_PAY_NATIVE_METHOD) throw paymentMethodUnavailable()
      let total: number
      try {
        total = assertNativeCnyAmount(input.amountMinor, input.currency)
      } catch {
        throw paymentMethodUnavailable()
      }
      const outTradeNo = toOutTradeNo(input.requestIdempotencyKey)
      const body = JSON.stringify({
        appid: credentials.appid,
        mchid: credentials.mchid,
        description: '账户充值',
        out_trade_no: outTradeNo,
        notify_url: credentials.notifyUrl,
        attach: input.orderId,
        amount: { total, currency: WECHAT_PAY_CNY },
      })

      const recover = async (): Promise<ProviderPaymentAction> => {
        try {
          const queried = await queryTransaction(credentials, http, now, outTradeNo)
          const status = queried.status === 'succeeded'
            ? 'succeeded'
            : queried.status === 'failed'
              ? 'failed'
              : 'unknown'
          return {
            status,
            providerPaymentId: outTradeNo,
            providerOrderId: queried.providerOrderId,
            action: { type: 'none' },
            requestIdempotencyKey: input.requestIdempotencyKey,
            amountMinor: input.amountMinor,
          }
        } catch {
          return {
            status: 'unknown',
            providerPaymentId: outTradeNo,
            action: { type: 'none' },
            requestIdempotencyKey: input.requestIdempotencyKey,
            amountMinor: input.amountMinor,
          }
        }
      }

      try {
        const result = await wechatPayRequest({
          ...requestOpts(credentials, http, now),
          method: 'POST',
          pathAndQuery: '/v3/pay/transactions/native',
          body,
        })
        const code = wechatErrorCode(result.json)
        if (result.status === 403 && code === 'OUT_TRADE_NO_USED') return recover()
        if (result.status === 400 && (code === 'ORDER_CLOSED' || code === 'INVALID_REQUEST')) {
          return recover()
        }
        if (result.status < 200 || result.status >= 300) throw paymentProviderUnavailable()
        const payload = asObject(result.json)
        const codeUrl = typeof payload?.code_url === 'string' ? payload.code_url : ''
        if (!codeUrl.startsWith('weixin://')) throw paymentStateUnknown()
        return {
          status: 'requires_action',
          providerPaymentId: outTradeNo,
          action: {
            type: 'qr_code',
            content: codeUrl,
            display: 'text',
            expiresAt: new Date(now().getTime() + WECHAT_PAY_CODE_URL_TTL_MS).toISOString(),
          },
          requestIdempotencyKey: input.requestIdempotencyKey,
          amountMinor: input.amountMinor,
        }
      } catch (err) {
        if (err instanceof WechatPayUnknownResultError) return recover()
        throw err
      }
    },

    async queryPayment(input: QueryProviderPaymentInput): Promise<NormalizedPayment> {
      const credentials = credentialsOf()
      if (input.providerAccountKey !== wechatPayAccountKey(credentials.mchid)) {
        throw paymentProviderUnavailable()
      }
      try {
        return await queryTransaction(credentials, http, now, input.providerPaymentId)
      } catch (err) {
        if (err instanceof WechatPayUnknownResultError) throw paymentStateUnknown()
        throw err
      }
    },

    async closePayment(input: CloseProviderPaymentInput): Promise<CloseResult> {
      const credentials = credentialsOf()
      if (input.providerAccountKey !== wechatPayAccountKey(credentials.mchid)) {
        throw paymentProviderUnavailable()
      }
      const outTradeNo = input.providerPaymentId
      try {
        const result = await wechatPayRequest({
          ...requestOpts(credentials, http, now),
          method: 'POST',
          pathAndQuery: `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`,
          body: JSON.stringify({ mchid: credentials.mchid }),
        })
        if (result.status === 204 || (result.status >= 200 && result.status < 300)) {
          return {
            status: 'cancelled',
            providerPaymentId: outTradeNo,
            immutableStateVersion: `CLOSED:${outTradeNo}`,
          }
        }
        const code = wechatErrorCode(result.json)
        if (code === 'ORDER_PAID' || code === 'ORDERPAID') {
          const queried = await queryTransaction(credentials, http, now, outTradeNo)
          return {
            status: queried.status === 'succeeded' ? 'succeeded' : queried.status === 'cancelled' ? 'cancelled' : 'unknown',
            providerPaymentId: outTradeNo,
            immutableStateVersion: queried.immutableStateVersion,
          }
        }
        if (code === 'ORDER_CLOSED') {
          return { status: 'cancelled', providerPaymentId: outTradeNo, immutableStateVersion: `CLOSED:${outTradeNo}` }
        }
        return { status: 'unknown', providerPaymentId: outTradeNo, immutableStateVersion: `unknown:${outTradeNo}` }
      } catch (err) {
        if (err instanceof WechatPayUnknownResultError) {
          return { status: 'unknown', providerPaymentId: outTradeNo, immutableStateVersion: `unknown:${outTradeNo}` }
        }
        throw err
      }
    },

    async verifyAndNormalizeWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent> {
      const credentials = credentialsOverride === undefined
        ? loadWechatPayCredentials()
        : credentialsOverride
      const unverified = (eventType: string, dedupeKey: string): NormalizedProviderEvent => ({
        eventType,
        providerEventId: null,
        providerPaymentId: null,
        providerCaptureId: null,
        providerAccountKey: credentials ? wechatPayAccountKey(credentials.mchid) : 'wechat_pay:unconfigured',
        dedupeKey,
        payment: null,
        signatureVerified: false,
      })
      const raw = input.rawBody
      const fallbackDedupe = `webhook:unverified:${createHash('sha256').update(raw).digest('hex')}`
      if (!credentials) return unverified('payment.failed_verification', fallbackDedupe)

      const timestamp = headerValue(input.headers, 'Wechatpay-Timestamp')
      const nonce = headerValue(input.headers, 'Wechatpay-Nonce')
      const signature = headerValue(input.headers, 'Wechatpay-Signature')
      const serial = headerValue(input.headers, 'Wechatpay-Serial')
      const body = raw.toString('utf8')
      if (!isTimestampFresh(timestamp, now()) || serial !== credentials.platformSerialNo) {
        return unverified('payment.failed_verification', fallbackDedupe)
      }
      const message = buildResponseSignMessage(timestamp, nonce, body)
      if (!rsaSha256Verify(credentials.platformPublicKeyPem, message, signature)) {
        return unverified('payment.failed_verification', fallbackDedupe)
      }

      const envelope = encryptResourcePayload({ credentials, rawBody: raw })
      if (!envelope) return unverified('payment.failed_verification', fallbackDedupe)
      const algorithm = envelope.resource.algorithm
      const ciphertext = envelope.resource.ciphertext
      const resourceNonce = envelope.resource.nonce
      const associatedData = typeof envelope.resource.associated_data === 'string'
        ? envelope.resource.associated_data
        : ''
      if (algorithm !== 'AEAD_AES_256_GCM' || typeof ciphertext !== 'string' || typeof resourceNonce !== 'string') {
        return unverified(envelope.eventType || 'payment.failed_verification', fallbackDedupe)
      }

      let plaintext: string
      try {
        plaintext = decryptAesGcm({
          apiV3Key: credentials.apiV3Key,
          nonce: resourceNonce,
          ciphertextB64: ciphertext,
          associatedData,
        })
      } catch {
        return unverified(envelope.eventType || 'payment.failed_verification', fallbackDedupe)
      }

      const accountKey = wechatPayAccountKey(credentials.mchid)
      const dedupeKey = envelope.id ? `webhook:${envelope.id}` : fallbackDedupe
      const originalType = envelope.resource.original_type

      if (envelope.eventType.startsWith('REFUND.') || originalType === 'refund') {
        let refund: WechatRefund
        try {
          refund = JSON.parse(plaintext) as WechatRefund
        } catch {
          return unverified(envelope.eventType, dedupeKey)
        }
        const status = mapRefundStatus(refundStatusOf(refund))
        const amountMinor = fenToAmountMinor(refund.amount?.refund ?? refund.amount?.total) ?? 0n
        const mchidOk = refund.mchid === credentials.mchid
        const currencyOk = refund.amount?.currency === WECHAT_PAY_CNY
        return {
          eventType: `refund.${status}`,
          providerEventId: envelope.id || null,
          providerPaymentId: refund.out_trade_no ?? null,
          providerCaptureId: refund.transaction_id ?? null,
          providerAccountKey: accountKey,
          dedupeKey,
          payment: mchidOk && currencyOk && refund.out_trade_no
            ? {
                status: status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : 'processing',
                providerPaymentId: refund.out_trade_no,
                providerOrderId: refund.transaction_id ?? null,
                providerCaptureId: refund.out_refund_no ?? refund.refund_id ?? null,
                amountMinor,
                currency: WECHAT_PAY_CNY,
                providerAccountKey: accountKey,
                immutableStateVersion: `${refundStatusOf(refund) ?? 'UNKNOWN'}:${refund.out_refund_no ?? ''}`,
                rawStatus: refundStatusOf(refund),
              }
            : null,
          signatureVerified: true,
        }
      }

      let transaction: WechatTransaction
      try {
        transaction = JSON.parse(plaintext) as WechatTransaction
      } catch {
        return unverified(envelope.eventType, dedupeKey)
      }
      const payment = toNormalizedPayment({
        providerAccountKey: accountKey,
        transaction,
        expectedMchid: credentials.mchid,
        expectedAppid: credentials.appid,
      })
      const matched = identityMatches({
        mchid: credentials.mchid,
        appid: credentials.appid,
        transaction,
      })
      return {
        eventType: envelope.eventType || 'TRANSACTION.SUCCESS',
        providerEventId: envelope.id || null,
        providerPaymentId: transaction.out_trade_no ?? null,
        providerCaptureId: matched && payment.status === 'succeeded' ? transaction.transaction_id ?? null : null,
        providerAccountKey: accountKey,
        dedupeKey,
        payment,
        signatureVerified: true,
      }
    },

    async createRefund(input: CreateProviderRefundInput): Promise<NormalizedRefund> {
      const credentials = credentialsOf()
      if (input.providerAccountKey !== wechatPayAccountKey(credentials.mchid)) {
        throw paymentProviderUnavailable()
      }
      let total: number
      try {
        total = assertNativeCnyAmount(input.amountMinor, input.currency)
      } catch {
        throw paymentMethodUnavailable()
      }
      const outRefundNo = toOutTradeNo(input.requestIdempotencyKey)
      const body = JSON.stringify({
        out_trade_no: input.providerPaymentId,
        out_refund_no: outRefundNo,
        amount: { refund: total, total, currency: WECHAT_PAY_CNY },
      })

      const recover = async (): Promise<NormalizedRefund> => {
        try {
          return await queryRefundById(credentials, http, now, outRefundNo, input.amountMinor)
        } catch {
          return {
            status: 'unknown',
            providerRefundId: outRefundNo,
            amountMinor: input.amountMinor,
            currency: WECHAT_PAY_CNY,
            immutableStateVersion: `unknown:${outRefundNo}`,
          }
        }
      }

      try {
        const result = await wechatPayRequest({
          ...requestOpts(credentials, http, now),
          method: 'POST',
          pathAndQuery: '/v3/refund/domestic/refunds',
          body,
        })
        if (result.status < 200 || result.status >= 300) {
          const code = wechatErrorCode(result.json)
          if (code === 'INVALID_REQUEST' || code === 'FREQUENCY_LIMITED' || result.status >= 500) {
            return recover()
          }
          throw paymentProviderUnavailable()
        }
        const row = result.json as WechatRefund
        const status = mapRefundStatus(refundStatusOf(row))
        const amountMinor = fenToAmountMinor(row.amount?.refund) ?? input.amountMinor
        return {
          status,
          providerRefundId: row.out_refund_no ?? outRefundNo,
          amountMinor,
          currency: WECHAT_PAY_CNY,
          immutableStateVersion: `${refundStatusOf(row) ?? 'UNKNOWN'}:${row.out_refund_no ?? outRefundNo}`,
        }
      } catch (err) {
        if (err instanceof WechatPayUnknownResultError) return recover()
        throw err
      }
    },

    async queryRefund(input: QueryProviderRefundInput): Promise<NormalizedRefund> {
      const credentials = credentialsOf()
      if (input.providerAccountKey !== wechatPayAccountKey(credentials.mchid)) {
        throw paymentProviderUnavailable()
      }
      try {
        return await queryRefundById(credentials, http, now, input.providerRefundId, 0n)
      } catch (err) {
        if (err instanceof WechatPayUnknownResultError) throw paymentStateUnknown()
        throw err
      }
    },
  }
}

export const wechatPayProvider: PaymentProvider = createWechatPayProvider()
