import { createHash } from 'node:crypto'
import { logger } from '../../../../lib/logger.js'
import { paymentMethodUnavailable, paymentProviderUnavailable } from '../../../../lib/httpError.js'
import { getIsoCurrencyMetadata, getPlatformCurrencyLimits, serializeAmountMinor } from '../../../recharge/money.js'
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
  ALIPAY_YUAN_SCALE,
  amountMinorToYuanString,
  isFullRefundAmount,
  yuanStringToAmountMinor,
} from './amount.js'
import {
  ALIPAY_CAPABILITY_VERSION,
  ALIPAY_PAYMENT_METHODS,
  ALIPAY_PROVIDER_NAME,
  alipayAccountKey,
  assertAlipayConfigSelfConsistent,
  assertAlipayEnvironmentIsolation,
  isAlipayPaymentMethod,
  type AlipayAdapterConfig,
  type AlipayPaymentMethod,
} from './config.js'
import {
  createOfficialAlipaySdk,
  pickString,
  structuredFormPostFromSignedUrl,
  type AlipaySdkSurface,
} from './gateway.js'
import {
  ALIPAY_CLOSED_TRADE_STATUS,
  matchAlipayIdentity,
  normalizeMatchedPayment,
  verifyAndNormalizeNotify,
} from './notify.js'

export type AlipayProviderOptions = {
  sdk?: AlipaySdkSurface
}

const WAP_API = 'alipay.trade.wap.pay'
const PAGE_API = 'alipay.trade.page.pay'
const QUERY_API = 'alipay.trade.query'
const CLOSE_API = 'alipay.trade.close'
const REFUND_API = 'alipay.trade.refund'
const REFUND_QUERY_API = 'alipay.trade.fastpay.refund.query'

const PRODUCT_CODE: Record<AlipayPaymentMethod, string> = {
  wap: 'QUICK_WAP_WAY',
  page: 'FAST_INSTANT_TRADE_PAY',
}

function digestCapabilities(input: {
  accountKey: string
  environment: string
  currency: string
  paymentMethod: string
  version: string
  minimumAmountMinor: bigint
  maximumAmountMinor: bigint | null
}): string {
  return createHash('sha256').update(JSON.stringify({
    accountKey: input.accountKey,
    environment: input.environment,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
    version: input.version,
    minimumAmountMinor: serializeAmountMinor(input.minimumAmountMinor),
    maximumAmountMinor: input.maximumAmountMinor == null ? null : serializeAmountMinor(input.maximumAmountMinor),
    methods: [...ALIPAY_PAYMENT_METHODS],
  })).digest('hex')
}

function apiMethodFor(paymentMethod: AlipayPaymentMethod): string {
  return paymentMethod === 'wap' ? WAP_API : PAGE_API
}

const ALIPAY_OUT_NO_CHARSET = /^[A-Za-z0-9_-]+$/
const REFUND_ID_SEP = '/'

/** Alipay out_trade_no / out_request_no: letters, digits, underscore, hyphen only. */
export function toAlipayOutRequestNo(requestIdempotencyKey: string): string {
  const mapped = requestIdempotencyKey.replace(/[^A-Za-z0-9_-]/g, '_')
  if (mapped.length > 0 && mapped.length <= 64 && ALIPAY_OUT_NO_CHARSET.test(mapped)) {
    return mapped
  }
  return createHash('sha256').update(requestIdempotencyKey).digest('hex').slice(0, 64)
}

/** Composite so queryRefund can send both out_trade_no and out_request_no. */
export function encodeAlipayRefundId(outTradeNo: string, outRequestNo: string): string {
  return `${outTradeNo}${REFUND_ID_SEP}${outRequestNo}`
}

export function parseAlipayRefundId(providerRefundId: string): { outTradeNo: string; outRequestNo: string } | null {
  const sep = providerRefundId.indexOf(REFUND_ID_SEP)
  if (sep <= 0 || sep === providerRefundId.length - 1) return null
  const outTradeNo = providerRefundId.slice(0, sep)
  const outRequestNo = providerRefundId.slice(sep + 1)
  if (!ALIPAY_OUT_NO_CHARSET.test(outTradeNo) || !ALIPAY_OUT_NO_CHARSET.test(outRequestNo)) return null
  return { outTradeNo, outRequestNo }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function alipayCode(result: Record<string, unknown>): string | undefined {
  return pickString(result, 'code')
}

function alipaySubCode(result: Record<string, unknown>): string | undefined {
  return pickString(result, 'sub_code', 'subCode')
}

async function execApi(
  sdk: AlipaySdkSurface,
  method: string,
  bizContent: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return asRecord(await sdk.exec(method, { bizContent }, { validateSign: true }))
  } catch (error) {
    logger.warn({
      event: 'payment.alipay_api_failed',
      provider: 'alipay',
      method,
      err: error instanceof Error ? error.name : 'alipay_api',
    }, 'alipay api failed')
    throw paymentProviderUnavailable('alipay request failed')
  }
}

function refundStatusFrom(result: Record<string, unknown>): NormalizedRefund['status'] {
  const code = alipayCode(result)
  const refundStatus = pickString(result, 'refund_status', 'refundStatus')
  if (refundStatus === 'REFUND_SUCCESS') return 'succeeded'
  if (code === '10000') {
    const fundChange = pickString(result, 'fund_change', 'fundChange')
    if (fundChange === 'Y' || fundChange === 'N') return 'succeeded'
    return 'processing'
  }
  if (code === '10003' || code === '20000') return 'processing'
  return 'failed'
}

export function createAlipayProvider(
  config: AlipayAdapterConfig,
  options: AlipayProviderOptions = {},
): PaymentProvider {
  assertAlipayConfigSelfConsistent(config)
  const sdk = options.sdk ?? createOfficialAlipaySdk(config)
  const accountKey = alipayAccountKey(config.mode, config.appId)

  function assertAccount(providerAccountKey: string, environment?: ProviderEnvironment) {
    if (environment) assertAlipayEnvironmentIsolation(config, environment)
    if (providerAccountKey !== accountKey) {
      throw paymentMethodUnavailable('alipay account is not available')
    }
  }

  const provider: PaymentProvider = {
    name: ALIPAY_PROVIDER_NAME,

    async selectAccount(input: {
      environment: ProviderEnvironment
      currency: RechargeCurrency
      paymentMethod: string
    }) {
      assertAlipayEnvironmentIsolation(config, input.environment)
      if (!isAlipayPaymentMethod(input.paymentMethod)) throw paymentMethodUnavailable()
      if (getIsoCurrencyMetadata(input.currency).scale !== ALIPAY_YUAN_SCALE) {
        throw paymentMethodUnavailable()
      }
      if (input.currency !== 'CNY') throw paymentMethodUnavailable()
      return { providerAccountKey: accountKey }
    },

    async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
      assertAccount(context.providerAccountKey, context.environment)
      if (!isAlipayPaymentMethod(context.paymentMethod)) throw paymentMethodUnavailable()
      if (getIsoCurrencyMetadata(context.currency).scale !== ALIPAY_YUAN_SCALE) {
        throw paymentMethodUnavailable()
      }
      if (context.currency !== 'CNY') throw paymentMethodUnavailable()
      const platform = getPlatformCurrencyLimits(context.currency)
      return {
        supportedCurrencies: ['CNY'],
        paymentMethods: ALIPAY_PAYMENT_METHODS,
        actionTypes: ['form_post'],
        supportsRefunds: true,
        supportsPartialRefund: true,
        supportsDisputes: false,
        supportsReconciliation: true,
        supportsBuyerApprovalCapture: false,
        minimumAmountMinor: platform.minAmountMinor,
        maximumAmountMinor: platform.maxAmountMinor,
        capabilityVersion: ALIPAY_CAPABILITY_VERSION,
        capabilityDigest: digestCapabilities({
          accountKey: context.providerAccountKey,
          environment: context.environment,
          currency: context.currency,
          paymentMethod: context.paymentMethod,
          version: ALIPAY_CAPABILITY_VERSION,
          minimumAmountMinor: platform.minAmountMinor,
          maximumAmountMinor: platform.maxAmountMinor,
        }),
      }
    },

    async createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentAction> {
      assertAccount(input.providerAccountKey)
      if (!isAlipayPaymentMethod(input.paymentMethod)) throw paymentMethodUnavailable()
      if (input.currency !== 'CNY') throw paymentMethodUnavailable()
      const outTradeNo = input.paymentAttemptId
      const totalAmount = amountMinorToYuanString(input.amountMinor)
      const api = apiMethodFor(input.paymentMethod)
      const pageParams: Record<string, unknown> = {
        bizContent: {
          out_trade_no: outTradeNo,
          product_code: PRODUCT_CODE[input.paymentMethod],
          total_amount: totalAmount,
          subject: 'MoNexus recharge',
          timeout_express: '30m',
        },
      }
      // Official sign uses Array.prototype.toString.call(value); undefined fields throw.
      if (config.notifyUrl) pageParams.notifyUrl = config.notifyUrl
      if (input.returnUrl) pageParams.returnUrl = input.returnUrl
      const signed = sdk.pageExecute(api, 'GET', pageParams)
      const form = structuredFormPostFromSignedUrl(signed, config)
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
      return {
        status: 'requires_action',
        providerPaymentId: outTradeNo,
        providerOrderId: outTradeNo,
        action: {
          type: 'form_post',
          actionUrl: form.actionUrl,
          method: 'POST',
          fields: form.fields,
          expiresAt,
        },
        requestIdempotencyKey: input.requestIdempotencyKey,
        amountMinor: input.amountMinor,
      }
    },

    async queryPayment(input: QueryProviderPaymentInput): Promise<NormalizedPayment> {
      assertAccount(input.providerAccountKey)
      const bizContent: Record<string, unknown> = { out_trade_no: input.providerPaymentId }
      if (input.providerOrderId && input.providerOrderId !== input.providerPaymentId) {
        bizContent.trade_no = input.providerOrderId
      }
      const result = await execApi(sdk, QUERY_API, bizContent)
      const code = alipayCode(result)
      if (code !== '10000') {
        const sub = alipaySubCode(result)
        if (sub === 'ACQ.TRADE_NOT_EXIST') {
          return {
            status: 'unknown',
            providerPaymentId: input.providerPaymentId,
            providerOrderId: input.providerPaymentId,
            providerCaptureId: null,
            amountMinor: 0n,
            currency: 'CNY',
            providerAccountKey: accountKey,
            immutableStateVersion: `missing:${input.providerPaymentId}`,
            rawStatus: sub,
          }
        }
        return {
          status: 'unknown',
          providerPaymentId: input.providerPaymentId,
          providerOrderId: input.providerPaymentId,
          providerCaptureId: null,
          amountMinor: 0n,
          currency: 'CNY',
          providerAccountKey: accountKey,
          immutableStateVersion: `query:${code ?? 'unknown'}`,
          rawStatus: sub ?? code,
        }
      }

      const match = matchAlipayIdentity(config, result, 'query')
      if (!match) {
        return {
          status: 'unknown',
          providerPaymentId: input.providerPaymentId,
          providerOrderId: input.providerPaymentId,
          providerCaptureId: pickString(result, 'trade_no', 'tradeNo') ?? null,
          amountMinor: 0n,
          currency: 'CNY',
          providerAccountKey: accountKey,
          immutableStateVersion: `mismatch:${input.providerPaymentId}`,
          rawStatus: pickString(result, 'trade_status', 'tradeStatus'),
        }
      }
      if (match.outTradeNo !== input.providerPaymentId) {
        logger.warn({
          event: 'payment.alipay_notify_ignored',
          provider: 'alipay',
          reason: 'out_trade_no_mismatch',
        }, 'alipay query identity mismatch')
        return {
          status: 'unknown',
          providerPaymentId: input.providerPaymentId,
          providerOrderId: input.providerPaymentId,
          providerCaptureId: match.tradeNo,
          amountMinor: 0n,
          currency: 'CNY',
          providerAccountKey: accountKey,
          immutableStateVersion: `mismatch:${input.providerPaymentId}`,
          rawStatus: match.tradeStatus,
        }
      }
      const payment = normalizeMatchedPayment(config, match)
      if (!payment) {
        return {
          status: 'unknown',
          providerPaymentId: match.outTradeNo,
          providerOrderId: match.outTradeNo,
          providerCaptureId: match.tradeNo,
          amountMinor: yuanStringToAmountMinor(match.totalAmountYuan),
          currency: 'CNY',
          providerAccountKey: accountKey,
          immutableStateVersion: `unknown:${match.tradeNo}`,
          rawStatus: match.tradeStatus,
        }
      }
      return payment
    },

    async closePayment(input: CloseProviderPaymentInput): Promise<CloseResult> {
      assertAccount(input.providerAccountKey)
      const result = await execApi(sdk, CLOSE_API, {
        out_trade_no: input.providerPaymentId,
      })
      const code = alipayCode(result)
      const sub = alipaySubCode(result)
      if (code === '10000') {
        return {
          status: 'cancelled',
          providerPaymentId: input.providerPaymentId,
          immutableStateVersion: `${ALIPAY_CLOSED_TRADE_STATUS}:${input.providerPaymentId}`,
        }
      }
      if (sub === 'ACQ.TRADE_NOT_EXIST') {
        // Signed form is still payable until timeout; not-found is not a terminal close.
        return {
          status: 'unknown',
          providerPaymentId: input.providerPaymentId,
          immutableStateVersion: `missing:${input.providerPaymentId}`,
        }
      }
      const queried = await provider.queryPayment({
        providerPaymentId: input.providerPaymentId,
        providerAccountKey: input.providerAccountKey,
      })
      if (queried.status === 'succeeded') {
        return {
          status: 'succeeded',
          providerPaymentId: queried.providerPaymentId,
          immutableStateVersion: queried.immutableStateVersion,
        }
      }
      if (queried.status === 'cancelled' || queried.status === 'failed') {
        return {
          status: queried.status,
          providerPaymentId: queried.providerPaymentId,
          immutableStateVersion: queried.immutableStateVersion,
        }
      }
      return {
        status: 'unknown',
        providerPaymentId: input.providerPaymentId,
        immutableStateVersion: queried.immutableStateVersion,
      }
    },

    async verifyAndNormalizeWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent> {
      return verifyAndNormalizeNotify(config, sdk, input.rawBody)
    },

    async createRefund(input: CreateProviderRefundInput): Promise<NormalizedRefund> {
      assertAccount(input.providerAccountKey)
      if (input.currency !== 'CNY') throw paymentMethodUnavailable()
      const outRequestNo = toAlipayOutRequestNo(input.requestIdempotencyKey)
      const refundAmount = amountMinorToYuanString(input.amountMinor)
      const result = await execApi(sdk, REFUND_API, {
        out_trade_no: input.providerPaymentId,
        out_request_no: outRequestNo,
        refund_amount: refundAmount,
      })
      let amountMinor = input.amountMinor
      const refundFee = pickString(result, 'refund_fee', 'refundFee', 'refund_amount', 'refundAmount')
      if (refundFee) {
        try {
          amountMinor = yuanStringToAmountMinor(refundFee)
        } catch {
          amountMinor = input.amountMinor
        }
      }
      const totalAmount = pickString(result, 'total_amount', 'totalAmount')
      // Partial refund keeps the original trade succeeded; only refund_amount == total is full.
      if (totalAmount && !isFullRefundAmount(totalAmount, refundAmount) && amountMinor !== input.amountMinor) {
        amountMinor = input.amountMinor
      }
      const status = refundStatusFrom(result)
      const providerRefundId = encodeAlipayRefundId(input.providerPaymentId, outRequestNo)
      return {
        status,
        providerRefundId,
        amountMinor,
        currency: 'CNY',
        immutableStateVersion: `${status}:${outRequestNo}:${amountMinorToYuanString(amountMinor)}`,
      }
    },

    async queryRefund(input: QueryProviderRefundInput): Promise<NormalizedRefund> {
      assertAccount(input.providerAccountKey)
      const parsed = parseAlipayRefundId(input.providerRefundId)
      if (!parsed) {
        return {
          status: 'unknown',
          providerRefundId: input.providerRefundId,
          amountMinor: 0n,
          currency: 'CNY',
          immutableStateVersion: `refund:${input.providerRefundId}:missing_trade_id`,
        }
      }
      const result = await execApi(sdk, REFUND_QUERY_API, {
        out_trade_no: parsed.outTradeNo,
        out_request_no: parsed.outRequestNo,
      })
      const refundAmount = pickString(result, 'refund_amount', 'refundAmount', 'refund_fee', 'refundFee')
      if (!refundAmount) {
        return {
          status: refundStatusFrom(result) === 'failed' ? 'failed' : 'unknown',
          providerRefundId: input.providerRefundId,
          amountMinor: 0n,
          currency: 'CNY',
          immutableStateVersion: `refund:${input.providerRefundId}:unknown`,
        }
      }
      const amountMinor = yuanStringToAmountMinor(refundAmount)
      const totalAmount = pickString(result, 'total_amount', 'totalAmount')
      const status = refundStatusFrom(result)
      if (totalAmount && !isFullRefundAmount(totalAmount, refundAmount) && status === 'succeeded') {
        return {
          status: 'succeeded',
          providerRefundId: input.providerRefundId,
          amountMinor,
          currency: 'CNY',
          immutableStateVersion: `partial:${input.providerRefundId}:${refundAmount}`,
        }
      }
      return {
        status,
        providerRefundId: input.providerRefundId,
        amountMinor,
        currency: 'CNY',
        immutableStateVersion: `${status}:${input.providerRefundId}:${refundAmount}`,
      }
    },
  }

  return provider
}

export function createDisabledAlipayProvider(): PaymentProvider {
  const unavailable = () => {
    throw paymentProviderUnavailable('alipay is not configured')
  }
  return {
    name: ALIPAY_PROVIDER_NAME,
    selectAccount: unavailable,
    getCapabilities: unavailable,
    createPayment: unavailable,
    queryPayment: unavailable,
    closePayment: unavailable,
    verifyAndNormalizeWebhook: unavailable,
    createRefund: unavailable,
    queryRefund: unavailable,
  }
}
