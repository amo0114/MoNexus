import { createHash } from 'node:crypto'
import { HttpError, paymentMethodUnavailable, paymentProviderUnavailable, paymentRefundNotSupported, paymentStateUnknown } from '../../../../lib/httpError.js'
import { logger } from '../../../../lib/logger.js'
import { getPlatformCurrencyLimits, serializeAmountMinor } from '../../../recharge/money.js'
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
import { amountMinorToYuanString, yuanStringToAmountMinor, VmqfoxAmountError } from './amount.js'
import {
  createVmqfoxApi,
  defaultVmqfoxHttp,
  isDeterministicFailKind,
  isRetryableUnknownKind,
  VmqfoxClientError,
  type VmqfoxApi,
  type VmqfoxCreateData,
  type VmqfoxGetData,
  type VmqfoxHttp,
  type VmqfoxQueryByPayIdData,
} from './client.js'
import {
  assertVmqfoxEnvironmentIsolation,
  isValidPublicToken,
  isVmqfoxPaymentMethod,
  VMQFOX_CAPABILITY_VERSION,
  VMQFOX_PAY_TYPE,
  VMQFOX_PAYMENT_METHODS,
  VMQFOX_PROVIDER_NAME,
  type VmqfoxAdapterConfig,
  type VmqfoxPaymentMethod,
} from './config.js'
import { validateVmqfoxPayUrl } from './payUrl.js'
import { paymentFromGet, paymentFromQuery } from './normalize.js'
import { verifyAndNormalizeNotify } from './webhook.js'
import { recordMonitorOffline, recordQueryByPayIdRecovery } from '../../metrics.js'

const ORDER_TTL_MS = 5 * 60 * 1000

export type VmqfoxProviderOptions = {
  http?: VmqfoxHttp
  api?: VmqfoxApi
  now?: () => Date
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
    methods: [...VMQFOX_PAYMENT_METHODS],
  })).digest('hex')
}

function deterministicFail(message: string): HttpError {
  return new HttpError(409, 'PAYMENT_PROVIDER_UNAVAILABLE', message)
}

function mapCreateError(err: unknown): never {
  if (err instanceof VmqfoxClientError && isDeterministicFailKind(err.kind)) {
    if (err.kind === 'monitor_offline') recordMonitorOffline(VMQFOX_PROVIDER_NAME)
    throw deterministicFail(err.kind === 'monitor_offline' ? '监控端离线，支付渠道暂不可用' : '支付渠道配置不可用')
  }
  throw paymentStateUnknown()
}

/** Local create-response validation failed after the remote order already exists. */
class VmqfoxCreateUnusableError extends Error {
  constructor(readonly data: VmqfoxCreateData) {
    super('vmqfox create response failed local validation')
    this.name = 'VmqfoxCreateUnusableError'
  }
}

function nativeQrAction(payUrl: string, now: Date): Extract<ProviderPaymentAction['action'], { type: 'qr_code' }> {
  return {
    type: 'qr_code',
    content: payUrl,
    display: 'text',
    expiresAt: new Date(now.getTime() + ORDER_TTL_MS).toISOString(),
  }
}

function actionFromCreate(
  input: CreateProviderPaymentInput,
  method: VmqfoxPaymentMethod,
  data: VmqfoxCreateData,
  now: Date,
): ProviderPaymentAction {
  if (data.payId !== input.paymentAttemptId) {
    throw new VmqfoxCreateUnusableError(data)
  }
  if (data.payType !== Number(VMQFOX_PAY_TYPE[method])) {
    throw new VmqfoxCreateUnusableError(data)
  }
  let quotedMinor: bigint
  let payableMinor: bigint
  try {
    quotedMinor = yuanStringToAmountMinor(data.price)
    payableMinor = yuanStringToAmountMinor(data.reallyPrice)
  } catch (err) {
    if (err instanceof VmqfoxAmountError) throw new VmqfoxCreateUnusableError(data)
    throw err
  }
  if (quotedMinor !== input.amountMinor || payableMinor <= 0n) {
    logger.error({
      event: 'payment.vmqfox_amount_mismatch',
      provider: 'vmqfox',
      payId: input.paymentAttemptId,
    }, 'vmqfox create amount mismatch')
    throw new VmqfoxCreateUnusableError(data)
  }
  if (!isValidPublicToken(data.publicToken)) {
    throw new VmqfoxCreateUnusableError(data)
  }
  const payUrl = data.payUrl == null ? null : validateVmqfoxPayUrl(method, data.payUrl)
  if (!payUrl) {
    logger.error({
      event: 'payment.vmqfox_payurl_rejected',
      provider: 'vmqfox',
    }, 'vmqfox payUrl failed allowlist')
    throw new VmqfoxCreateUnusableError(data)
  }
  return {
    status: 'requires_action',
    providerPaymentId: data.payId,
    providerOrderId: data.publicToken,
    action: nativeQrAction(payUrl, now),
    requestIdempotencyKey: input.requestIdempotencyKey,
    amountMinor: payableMinor,
  }
}

function queryMatchesAttempt(
  input: CreateProviderPaymentInput,
  method: VmqfoxPaymentMethod,
  data: VmqfoxQueryByPayIdData,
): boolean {
  if (data.type !== Number(VMQFOX_PAY_TYPE[method])) return false
  if (!isValidPublicToken(data.publicToken)) return false
  try {
    const quotedMinor = yuanStringToAmountMinor(data.price)
    const payableMinor = yuanStringToAmountMinor(data.reallyPrice)
    return quotedMinor === input.amountMinor && payableMinor > 0n
  } catch {
    return false
  }
}

/**
 * Create recovery binds the original payId/publicToken and emits a QR action
 * only after GET payUrl is allowlisted. It never stamps local succeeded/failed
 * and never falls back to a VMQFox checkout redirect.
 */
function actionFromRecoveredGet(
  input: CreateProviderPaymentInput,
  method: VmqfoxPaymentMethod,
  queried: VmqfoxQueryByPayIdData,
  got: VmqfoxGetData,
  now: Date,
): ProviderPaymentAction | null {
  if (got.payId !== input.paymentAttemptId) return null
  if (got.payType !== queried.type) return null
  if (got.payType !== Number(VMQFOX_PAY_TYPE[method])) return null
  if (got.price !== queried.price || got.reallyPrice !== queried.reallyPrice) return null
  try {
    const quotedMinor = yuanStringToAmountMinor(got.price)
    const payableMinor = yuanStringToAmountMinor(got.reallyPrice)
    if (quotedMinor !== input.amountMinor || payableMinor <= 0n) return null
    const payUrl = validateVmqfoxPayUrl(method, got.payUrl)
    if (!payUrl) return null
    return {
      status: 'requires_action',
      providerPaymentId: input.paymentAttemptId,
      providerOrderId: queried.publicToken,
      action: nativeQrAction(payUrl, now),
      requestIdempotencyKey: input.requestIdempotencyKey,
      amountMinor: payableMinor,
    }
  } catch {
    return null
  }
}

function bindCreateIdentity(
  input: CreateProviderPaymentInput,
  data: VmqfoxCreateData,
): ProviderPaymentAction | null {
  let payableMinor = 0n
  try {
    payableMinor = yuanStringToAmountMinor(data.reallyPrice)
  } catch {
    payableMinor = 0n
  }
  const token = isValidPublicToken(data.publicToken) ? data.publicToken : null
  if (data.payId !== input.paymentAttemptId && !token && payableMinor <= 0n) return null
  return {
    status: 'unknown',
    providerPaymentId: input.paymentAttemptId,
    providerOrderId: token,
    action: { type: 'none' },
    requestIdempotencyKey: input.requestIdempotencyKey,
    amountMinor: payableMinor,
  }
}

export function createVmqfoxProvider(
  config: VmqfoxAdapterConfig,
  options: VmqfoxProviderOptions = {},
): PaymentProvider {
  const http = options.http ?? defaultVmqfoxHttp
  const api = options.api ?? createVmqfoxApi(config, http)
  const now = options.now ?? (() => new Date())
  const accountKey = config.accountKey

  function assertAccount(providerAccountKey: string, environment?: ProviderEnvironment) {
    if (environment) assertVmqfoxEnvironmentIsolation(config, environment)
    if (providerAccountKey !== accountKey) {
      throw paymentMethodUnavailable('vmqfox account is not available')
    }
  }

  async function recoverCreate(
    input: CreateProviderPaymentInput,
    method: VmqfoxPaymentMethod,
  ): Promise<ProviderPaymentAction | null> {
    try {
      const queried = await api.queryByPayId(input.paymentAttemptId, now())
      if (!queryMatchesAttempt(input, method, queried)) {
        recordQueryByPayIdRecovery(VMQFOX_PROVIDER_NAME, 'unusable')
        return null
      }
      let got: VmqfoxGetData
      try {
        got = await api.get(queried.publicToken)
      } catch {
        recordQueryByPayIdRecovery(VMQFOX_PROVIDER_NAME, 'failed')
        return null
      }
      const action = actionFromRecoveredGet(input, method, queried, got, now())
      if (action) {
        recordQueryByPayIdRecovery(VMQFOX_PROVIDER_NAME, 'recovered')
        return action
      }
      recordQueryByPayIdRecovery(VMQFOX_PROVIDER_NAME, 'unusable')
      return null
    } catch (err) {
      if (err instanceof VmqfoxClientError && err.kind === 'not_found') {
        recordQueryByPayIdRecovery(VMQFOX_PROVIDER_NAME, 'missed')
        return null
      }
      recordQueryByPayIdRecovery(VMQFOX_PROVIDER_NAME, 'failed')
      return null
    }
  }

  const provider: PaymentProvider = {
    name: VMQFOX_PROVIDER_NAME,

    async selectAccount(input: {
      environment: ProviderEnvironment
      currency: RechargeCurrency
      paymentMethod: string
    }) {
      assertVmqfoxEnvironmentIsolation(config, input.environment)
      if (input.currency !== 'CNY') throw paymentMethodUnavailable()
      if (!isVmqfoxPaymentMethod(input.paymentMethod)) throw paymentMethodUnavailable()
      return { providerAccountKey: accountKey }
    },

    async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
      assertAccount(context.providerAccountKey, context.environment)
      if (context.currency !== 'CNY') throw paymentMethodUnavailable()
      if (!isVmqfoxPaymentMethod(context.paymentMethod)) throw paymentMethodUnavailable()
      const platform = getPlatformCurrencyLimits(context.currency)
      const minimumAmountMinor = platform.minAmountMinor > 1n ? platform.minAmountMinor : 1n
      const maximumAmountMinor = config.maxAmountMinor
      return {
        supportedCurrencies: ['CNY'],
        paymentMethods: VMQFOX_PAYMENT_METHODS,
        actionTypes: ['qr_code'],
        supportsRefunds: false,
        supportsPartialRefund: false,
        supportsDisputes: false,
        supportsReconciliation: false,
        supportsBuyerApprovalCapture: false,
        minimumAmountMinor,
        maximumAmountMinor,
        capabilityVersion: VMQFOX_CAPABILITY_VERSION,
        capabilityDigest: digestCapabilities({
          accountKey: context.providerAccountKey,
          environment: context.environment,
          currency: context.currency,
          paymentMethod: context.paymentMethod,
          version: VMQFOX_CAPABILITY_VERSION,
          minimumAmountMinor,
          maximumAmountMinor,
        }),
      }
    },

    async createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentAction> {
      assertAccount(input.providerAccountKey)
      if (input.currency !== 'CNY') throw paymentMethodUnavailable()
      if (!isVmqfoxPaymentMethod(input.paymentMethod)) throw paymentMethodUnavailable()
      if (!input.returnUrl) throw deterministicFail('支付渠道配置不可用')
      const method = input.paymentMethod
      const price = amountMinorToYuanString(input.amountMinor)
      try {
        const created = await api.create({
          payId: input.paymentAttemptId,
          param: input.orderId,
          type: VMQFOX_PAY_TYPE[method],
          price,
          notifyUrl: config.notifyUrl,
          returnUrl: input.returnUrl,
        })
        return actionFromCreate(input, method, created, now())
      } catch (err) {
        if (err instanceof HttpError) throw err
        if (err instanceof VmqfoxClientError && isDeterministicFailKind(err.kind)) {
          mapCreateError(err)
        }
        const recovered = await recoverCreate(input, method)
        if (recovered) return recovered
        if (err instanceof VmqfoxCreateUnusableError) {
          const bound = bindCreateIdentity(input, err.data)
          if (bound) return bound
        }
        if (err instanceof VmqfoxClientError && isRetryableUnknownKind(err.kind)) {
          throw paymentStateUnknown()
        }
        throw paymentStateUnknown()
      }
    },

    async queryPayment(input: QueryProviderPaymentInput): Promise<NormalizedPayment> {
      assertAccount(input.providerAccountKey)
      const token = input.providerOrderId && isValidPublicToken(input.providerOrderId)
        ? input.providerOrderId
        : null
      try {
        if (token) {
          const [got, checked] = await Promise.all([
            api.get(token),
            api.check(token),
          ])
          const payment = paymentFromGet(config, { ...got, state: checked.state, remainingSeconds: checked.remainingSeconds })
          if (got.payId !== input.providerPaymentId) {
            return {
              ...payment,
              status: 'unknown',
              providerPaymentId: input.providerPaymentId,
              immutableStateVersion: `mismatch:${input.providerPaymentId}`,
            }
          }
          return { ...payment, providerOrderId: token }
        }
        const queried = await api.queryByPayId(input.providerPaymentId, now())
        return paymentFromQuery(config, input.providerPaymentId, queried)
      } catch (err) {
        if (err instanceof VmqfoxClientError && err.kind === 'not_found') {
          return {
            status: 'unknown',
            providerPaymentId: input.providerPaymentId,
            providerCaptureId: null,
            amountMinor: 0n,
            currency: 'CNY',
            providerAccountKey: accountKey,
            immutableStateVersion: `missing:${input.providerPaymentId}`,
            rawStatus: 'missing',
          }
        }
        throw paymentStateUnknown()
      }
    },

    async closePayment(input: CloseProviderPaymentInput): Promise<CloseResult> {
      assertAccount(input.providerAccountKey)
      try {
        const queried = await provider.queryPayment({
          providerPaymentId: input.providerPaymentId,
          providerAccountKey: input.providerAccountKey,
        })
        if (queried.status === 'cancelled') {
          return {
            status: 'cancelled',
            providerPaymentId: input.providerPaymentId,
            immutableStateVersion: queried.immutableStateVersion,
          }
        }
        if (queried.status === 'succeeded') {
          return {
            status: 'succeeded',
            providerPaymentId: input.providerPaymentId,
            immutableStateVersion: queried.immutableStateVersion,
          }
        }
        if (queried.status === 'processing' || queried.status === 'requires_action' || queried.status === 'created') {
          return {
            status: 'processing',
            providerPaymentId: input.providerPaymentId,
            immutableStateVersion: queried.immutableStateVersion,
          }
        }
        return {
          status: 'unknown',
          providerPaymentId: input.providerPaymentId,
          immutableStateVersion: queried.immutableStateVersion,
        }
      } catch {
        return {
          status: 'unknown',
          providerPaymentId: input.providerPaymentId,
          immutableStateVersion: `unknown:${input.providerPaymentId}`,
        }
      }
    },

    async verifyAndNormalizeWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent> {
      return verifyAndNormalizeNotify(config, input.rawBody)
    },

    async createRefund(_input: CreateProviderRefundInput): Promise<NormalizedRefund> {
      throw paymentRefundNotSupported()
    },

    async queryRefund(_input: QueryProviderRefundInput): Promise<NormalizedRefund> {
      throw paymentRefundNotSupported()
    },
  }

  return provider
}

export function createDisabledVmqfoxProvider(): PaymentProvider {
  const unavailable = () => {
    throw paymentProviderUnavailable('vmqfox is not configured')
  }
  return {
    name: VMQFOX_PROVIDER_NAME,
    selectAccount: unavailable,
    getCapabilities: unavailable,
    createPayment: unavailable,
    queryPayment: unavailable,
    closePayment: unavailable,
    verifyAndNormalizeWebhook: unavailable,
    async createRefund() {
      throw paymentRefundNotSupported()
    },
    async queryRefund() {
      throw paymentRefundNotSupported()
    },
  }
}
