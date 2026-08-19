import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import {
  conflict,
  notFound,
  paymentAlreadyInProgress,
  paymentCompletionNotSupported,
  paymentProviderUnavailable,
} from '../../lib/httpError.js'
import { getEnabledProvider, getHistoricalProvider, listEnabledProviders } from '../payment/providers/registry.js'
import type { PaymentProvider, ProviderCapabilities } from '../payment/providers/types.js'
import {
  completeObservationDedupeKey,
  hashNormalizedPayload,
  recordPaymentObservation,
} from '../payment/observations/record.js'
import { PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES, PAYMENT_PROVIDER_NAMES, type AmountSource, type PaymentAttemptStatus, type PaymentProviderName, type RechargeCurrency, type RechargeOrderStatus } from './types.js'
import { serializeAmountMinor } from './money.js'
import {
  assertCurrencyEnabled,
  assertProviderEnabled,
  assertRechargeAcceptsNewOrders,
  assertRechargeNotRestricted,
  providerEnvironment,
} from './gates.js'
import { assertAmountAllowed, effectiveAmountBounds, getActivePricePolicy, priceAmount, type ActivePricePolicy } from './policy.js'
import { remainingLimits, releaseLimitReservations, reserveLimitBuckets } from './limits.js'
import { resolveLimitPeriods } from './periods.js'
import {
  claimRechargeIdempotency,
  completeRechargeIdempotencyClaim,
  computeRechargeRequestDigest,
  releaseRechargeIdempotencyClaim,
} from './idempotency.js'
import { parseStoredAction, publicPaymentAction } from './serialize.js'
import { rechargeQuoteChanged, rechargeQuoteExpired } from '../../lib/httpError.js'

export const QUOTE_TTL_MS = 10 * 60 * 1000
export const ORDER_TTL_MS = 30 * 60 * 1000
export const DISCLOSURE_VERSION = 'recharge-disclosure-v1'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
const NON_TERMINAL_ATTEMPT = new Set<string>(PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES)

function asProviderName(value: string): PaymentProviderName {
  if (!(PAYMENT_PROVIDER_NAMES as readonly string[]).includes(value)) {
    throw paymentProviderUnavailable()
  }
  return value as PaymentProviderName
}

function ownerOrderNotFound(): never {
  throw notFound('充值订单不存在')
}

async function resolveCapabilities(input: {
  providerName: PaymentProviderName
  currency: RechargeCurrency
  paymentMethod: string
}): Promise<{ provider: PaymentProvider; accountKey: string; capabilities: ProviderCapabilities }> {
  assertProviderEnabled(input.providerName)
  const provider = getEnabledProvider(input.providerName)
  const environment = providerEnvironment()
  const { providerAccountKey } = await provider.selectAccount({
    environment,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
  })
  const capabilities = await provider.getCapabilities({
    providerAccountKey,
    environment,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
  })
  if (!capabilities.supportedCurrencies.includes(input.currency)) {
    throw paymentProviderUnavailable()
  }
  if (!capabilities.paymentMethods.includes(input.paymentMethod)) {
    throw paymentProviderUnavailable()
  }
  return { provider, accountKey: providerAccountKey, capabilities }
}

export async function getRechargeConfig(userId: number, currencyRaw: string) {
  assertRechargeAcceptsNewOrders()
  assertCurrencyEnabled(currencyRaw)
  const currency = currencyRaw
  const policy = await getActivePricePolicy(currency)
  const now = new Date()
  const periods = resolveLimitPeriods(now, policy.limitTimeZone)
  const remaining = await remainingLimits(
    userId,
    currency,
    policy.dailyLimitMinor,
    policy.monthlyLimitMinor,
    periods.day,
    periods.month,
    prisma,
  )
  const providers = []
  for (const adapter of listEnabledProviders()) {
    const methods = []
    const probeMethods = adapter.name === 'simulator'
      ? ['card', 'redirect', 'qr_code', 'form_post']
      : []
    for (const paymentMethod of probeMethods) {
      try {
        const resolved = await resolveCapabilities({
          providerName: adapter.name,
          currency,
          paymentMethod,
        })
        methods.push({
          paymentMethod,
          actionTypes: [...resolved.capabilities.actionTypes],
          supportsBuyerApprovalCapture: resolved.capabilities.supportsBuyerApprovalCapture,
          minimumAmountMinor: serializeAmountMinor(resolved.capabilities.minimumAmountMinor),
          maximumAmountMinor: resolved.capabilities.maximumAmountMinor == null
            ? null
            : serializeAmountMinor(resolved.capabilities.maximumAmountMinor),
        })
      } catch {
        // Combination is not offered for this currency.
      }
    }
    if (methods.length > 0) {
      providers.push({ provider: adapter.name, paymentMethods: methods })
    }
  }
  return {
    currency,
    mode: config.recharge.mode,
    pricePolicyId: policy.id,
    pricePolicyCode: policy.code,
    minAmountMinor: serializeAmountMinor(policy.minAmountMinor),
    maxAmountMinor: serializeAmountMinor(policy.maxAmountMinor),
    amountStepMinor: serializeAmountMinor(policy.amountStepMinor),
    dailyLimitMinor: serializeAmountMinor(policy.dailyLimitMinor),
    monthlyLimitMinor: serializeAmountMinor(policy.monthlyLimitMinor),
    dailyRemainingMinor: serializeAmountMinor(remaining.dailyRemainingMinor),
    monthlyRemainingMinor: serializeAmountMinor(remaining.monthlyRemainingMinor),
    suggestedAmounts: policy.suggestedAmounts.map(item => ({
      amountMinor: serializeAmountMinor(item.amountMinor),
      sortOrder: item.sortOrder,
    })),
    providers,
  }
}

export async function createQuote(userId: number, input: {
  currency: string
  amountMinor: bigint
  amountSource: AmountSource
  provider: string
  paymentMethod: string
}) {
  assertRechargeAcceptsNewOrders()
  assertCurrencyEnabled(input.currency)
  await assertRechargeNotRestricted(userId)
  const currency = input.currency
  const providerName = asProviderName(input.provider)
  const policy = await getActivePricePolicy(currency)
  const resolved = await resolveCapabilities({
    providerName,
    currency,
    paymentMethod: input.paymentMethod,
  })
  const bounds = effectiveAmountBounds(
    currency,
    policy,
    resolved.capabilities.minimumAmountMinor,
    resolved.capabilities.maximumAmountMinor,
  )
  assertAmountAllowed({
    amountMinor: input.amountMinor,
    amountSource: input.amountSource,
    bounds,
    stepMinor: policy.amountStepMinor,
    suggestedAmounts: policy.suggestedAmounts.map(item => item.amountMinor),
  })
  const priced = priceAmount(policy, input.amountMinor)
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS)
  const quote = await prisma.rechargeQuote.create({
    data: {
      userId,
      pricePolicyId: policy.id,
      provider: providerName,
      paymentMethod: input.paymentMethod,
      providerAccountKey: resolved.accountKey,
      capabilityVersion: resolved.capabilities.capabilityVersion,
      capabilityDigest: resolved.capabilities.capabilityDigest,
      currency,
      amountMinor: input.amountMinor,
      effectiveMinAmountMinor: bounds.minAmountMinor,
      effectiveMaxAmountMinor: bounds.maxAmountMinor,
      basePoints: priced.basePoints,
      bonusPoints: priced.bonusPoints,
      totalPoints: priced.totalPoints,
      amountSource: input.amountSource,
      expiresAt,
    },
  })
  return serializeQuote(quote, policy)
}

function serializeQuote(quote: {
  id: string
  currency: string
  amountMinor: bigint
  basePoints: bigint
  bonusPoints: bigint
  totalPoints: bigint
  pricePolicyId: string
  provider: string
  paymentMethod: string
  effectiveMinAmountMinor: bigint
  effectiveMaxAmountMinor: bigint
  expiresAt: Date
}, policy: Pick<ActivePricePolicy, 'code'>) {
  return {
    quoteId: quote.id,
    currency: quote.currency,
    amountMinor: serializeAmountMinor(quote.amountMinor),
    basePoints: serializeAmountMinor(quote.basePoints),
    bonusPoints: serializeAmountMinor(quote.bonusPoints),
    totalPoints: serializeAmountMinor(quote.totalPoints),
    pricePolicyId: quote.pricePolicyId,
    pricePolicyCode: policy.code,
    provider: quote.provider,
    paymentMethod: quote.paymentMethod,
    effectiveMinAmountMinor: serializeAmountMinor(quote.effectiveMinAmountMinor),
    effectiveMaxAmountMinor: serializeAmountMinor(quote.effectiveMaxAmountMinor),
    expiresAt: quote.expiresAt.toISOString(),
  }
}

async function loadOwnedOrder(userId: number, orderId: string) {
  const order = await prisma.rechargeOrder.findUnique({
    where: { id: orderId },
    include: {
      paymentIntent: { include: { attempts: { orderBy: { createdAt: 'asc' } } } },
    },
  })
  if (!order || order.userId !== userId) ownerOrderNotFound()
  return order
}

function serializeOrder(order: {
  id: string
  status: string
  currency: string
  amountMinor: bigint
  basePoints: bigint
  bonusPoints: bigint
  totalPoints: bigint
  provider: string
  paymentMethod: string
  expiresAt: Date
  paidAt: Date | null
  creditedAt: Date | null
  cancelledAt: Date | null
  createdAt: Date
  paymentIntent?: {
    id: string
    status: string
    attempts: Array<{
      id: string
      status: string
      actionType: string
      actionPayload: string | null
      providerPaymentId: string | null
      lastErrorCode: string | null
    }>
  } | null
}, options?: { includeAction?: boolean; observationId?: string | null; paymentStatus?: string }) {
  const attempts = order.paymentIntent?.attempts ?? []
  const active = [...attempts].reverse().find(attempt => NON_TERMINAL_ATTEMPT.has(attempt.status)) ?? attempts.at(-1)
  const action = options?.includeAction === false ? null : publicPaymentAction(parseStoredAction(active?.actionPayload ?? null))
  return {
    orderId: order.id,
    status: order.status,
    currency: order.currency,
    amountMinor: serializeAmountMinor(order.amountMinor),
    basePoints: serializeAmountMinor(order.basePoints),
    bonusPoints: serializeAmountMinor(order.bonusPoints),
    totalPoints: serializeAmountMinor(order.totalPoints),
    provider: order.provider,
    paymentMethod: order.paymentMethod,
    expiresAt: order.expiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    creditedAt: order.creditedAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    action,
    paymentIntent: order.paymentIntent
      ? { id: order.paymentIntent.id, status: order.paymentIntent.status }
      : null,
    activeAttempt: active
      ? {
          id: active.id,
          status: active.status,
          providerPaymentId: active.providerPaymentId,
        }
      : null,
    ...(options?.observationId !== undefined ? { observationId: options.observationId } : {}),
    ...(options?.paymentStatus ? { payment: { status: options.paymentStatus } } : {}),
  }
}

async function createProviderAttempt(order: {
  id: string
  userId: number
  amountMinor: bigint
  currency: string
  paymentMethod: string
  provider: string
  providerAccountKey: string
}, intent: { id: string }, attempt: { id: string; requestIdempotencyKey: string }) {
  const provider = getHistoricalProvider(asProviderName(order.provider))
  const created = await provider.createPayment({
    orderId: order.id,
    paymentIntentId: intent.id,
    paymentAttemptId: attempt.id,
    amountMinor: order.amountMinor,
    currency: order.currency as RechargeCurrency,
    paymentMethod: order.paymentMethod,
    providerAccountKey: order.providerAccountKey,
    requestIdempotencyKey: attempt.requestIdempotencyKey,
  })
  const now = new Date()
  const attemptStatus: PaymentAttemptStatus = created.status
  await prisma.$transaction(async tx => {
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: attemptStatus,
        providerPaymentId: created.providerPaymentId,
        providerOrderId: created.providerOrderId ?? null,
        actionType: created.action.type,
        actionPayload: JSON.stringify(created.action),
        completedAt: attemptStatus === 'failed' ? now : null,
        lastErrorCode: attemptStatus === 'failed' ? 'PAYMENT_FAILED' : null,
      },
    })
    if (attemptStatus === 'failed') {
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'failed', activeAttemptId: null },
      })
      await tx.rechargeOrder.update({
        where: { id: order.id },
        data: { status: 'failed' },
      })
      await releaseLimitReservations(tx, order.id)
      return
    }
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'processing',
        activeAttemptId: attempt.id,
      },
    })
    await tx.rechargeOrder.updateMany({
      where: { id: order.id, status: { in: ['created', 'pending_payment'] } },
      data: { status: 'pending_payment' },
    })
  }, TX)
  return created.action
}

export async function createOrder(userId: number, quoteId: string, idempotencyKey: string) {
  assertRechargeAcceptsNewOrders()
  await assertRechargeNotRestricted(userId)
  const digest = computeRechargeRequestDigest({ quoteId })
  const claim = await claimRechargeIdempotency({
    userId,
    scope: 'create_order',
    key: idempotencyKey,
    requestDigest: digest,
    resultType: 'RechargeOrder',
  })
  if (claim.kind === 'replay') {
    const existing = await loadOwnedOrder(userId, claim.resultId)
    return serializeOrder(existing)
  }

  let committed = false
  try {
    const created = await prisma.$transaction(async tx => {
      const quoteRows = await tx.$queryRaw<Array<{
        id: string
        userId: number
        pricePolicyId: string
        provider: string
        paymentMethod: string
        providerAccountKey: string
        capabilityVersion: string
        capabilityDigest: string
        currency: string
        amountMinor: bigint
        effectiveMinAmountMinor: bigint
        effectiveMaxAmountMinor: bigint
        basePoints: bigint
        bonusPoints: bigint
        totalPoints: bigint
        amountSource: string
        expiresAt: Date
        consumedAt: Date | null
      }>>`
        SELECT * FROM "RechargeQuote" WHERE "id" = ${quoteId}::uuid FOR UPDATE`

      const quote = quoteRows[0]
      if (!quote || quote.userId !== userId) throw notFound('充值报价不存在')
      if (quote.consumedAt || quote.expiresAt <= new Date()) throw rechargeQuoteExpired()

      const providerName = asProviderName(quote.provider)
      assertCurrencyEnabled(quote.currency)
      const policy = await tx.rechargePricePolicy.findUniqueOrThrow({ where: { id: quote.pricePolicyId } })
      if (policy.status !== 'active') throw rechargeQuoteChanged()

      const resolved = await resolveCapabilities({
        providerName,
        currency: quote.currency as RechargeCurrency,
        paymentMethod: quote.paymentMethod,
      })
      const bounds = effectiveAmountBounds(
        quote.currency as RechargeCurrency,
        { minAmountMinor: policy.minAmountMinor, maxAmountMinor: policy.maxAmountMinor },
        resolved.capabilities.minimumAmountMinor,
        resolved.capabilities.maximumAmountMinor,
      )
      if (
        resolved.accountKey !== quote.providerAccountKey
        || resolved.capabilities.capabilityDigest !== quote.capabilityDigest
        || resolved.capabilities.capabilityVersion !== quote.capabilityVersion
        || bounds.minAmountMinor !== quote.effectiveMinAmountMinor
        || bounds.maxAmountMinor !== quote.effectiveMaxAmountMinor
        || quote.amountMinor < bounds.minAmountMinor
        || quote.amountMinor > bounds.maxAmountMinor
      ) {
        throw rechargeQuoteChanged()
      }

      const consumed = await tx.rechargeQuote.updateMany({
        where: { id: quote.id, consumedAt: null, expiresAt: { gt: new Date() }, userId },
        data: { consumedAt: new Date() },
      })
      if (consumed.count !== 1) throw rechargeQuoteExpired()

      const expiresAt = new Date(Date.now() + ORDER_TTL_MS)
      const order = await tx.rechargeOrder.create({
        data: {
          userId,
          quoteId: quote.id,
          pricePolicyId: policy.id,
          currency: quote.currency,
          amountMinor: quote.amountMinor,
          basePoints: quote.basePoints,
          bonusPoints: quote.bonusPoints,
          totalPoints: quote.totalPoints,
          pricePolicyCode: policy.code,
          pricePolicyVersion: policy.version,
          pointsNumerator: policy.pointsNumerator,
          pointsDenominator: policy.pointsDenominator,
          roundingMode: 'HALF_EVEN',
          currencyScale: policy.currencyScale,
          bonusRuleVersion: policy.bonusRuleVersion,
          amountSource: quote.amountSource,
          provider: quote.provider,
          paymentMethod: quote.paymentMethod,
          providerAccountKey: quote.providerAccountKey,
          capabilityVersion: quote.capabilityVersion,
          capabilityDigest: quote.capabilityDigest,
          effectiveMinAmountMinor: quote.effectiveMinAmountMinor,
          effectiveMaxAmountMinor: quote.effectiveMaxAmountMinor,
          disclosureVersion: DISCLOSURE_VERSION,
          status: 'created',
          expiresAt,
        },
      })
      const intent = await tx.paymentIntent.create({
        data: {
          rechargeOrderId: order.id,
          amountMinor: order.amountMinor,
          currency: order.currency,
          status: 'requires_method',
          expiresAt,
        },
      })
      const attempt = await tx.paymentAttempt.create({
        data: {
          paymentIntentId: intent.id,
          provider: order.provider,
          providerAccountKey: order.providerAccountKey,
          method: order.paymentMethod,
          status: 'created',
          requestIdempotencyKey: `recharge:${order.id}:attempt:v1`,
          actionType: 'none',
        },
      })
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { activeAttemptId: attempt.id },
      })

      const periods = resolveLimitPeriods(new Date(), policy.limitTimeZone)
      await reserveLimitBuckets(tx, {
        userId,
        currency: order.currency,
        amountMinor: order.amountMinor,
        orderId: order.id,
        expiresAt,
        dailyLimitMinor: policy.dailyLimitMinor,
        monthlyLimitMinor: policy.monthlyLimitMinor,
        day: periods.day,
        month: periods.month,
      })

      await completeRechargeIdempotencyClaim(tx, {
        userId,
        scope: 'create_order',
        key: idempotencyKey,
        claimToken: claim.claimToken,
        resultId: order.id,
      })

      return { order, intent, attempt }
    }, TX)
    committed = true

    await createProviderAttempt(created.order, created.intent, created.attempt)
    const fresh = await loadOwnedOrder(userId, created.order.id)
    return serializeOrder(fresh)
  } catch (err) {
    if (!committed) {
      await releaseRechargeIdempotencyClaim({
        userId,
        scope: 'create_order',
        key: idempotencyKey,
        claimToken: claim.claimToken,
      })
    }
    throw err
  }
}

export async function listOrders(userId: number, query: { page: number; pageSize: number; status?: RechargeOrderStatus }) {
  const where = {
    userId,
    ...(query.status ? { status: query.status } : {}),
  }
  const [total, items] = await prisma.$transaction([
    prisma.rechargeOrder.count({ where }),
    prisma.rechargeOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { paymentIntent: { include: { attempts: { orderBy: { createdAt: 'asc' } } } } },
    }),
  ])
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: items.map(item => serializeOrder(item, { includeAction: false })),
  }
}

export async function getOrder(userId: number, orderId: string) {
  const order = await loadOwnedOrder(userId, orderId)
  return serializeOrder(order)
}

async function persistNormalizedObservation(input: {
  source: 'provider_complete' | 'provider_query'
  provider: string
  providerAccountKey: string
  paymentAttemptId: string
  payment: {
    status: PaymentAttemptStatus
    providerPaymentId: string
    providerCaptureId?: string | null
    amountMinor: bigint
    currency: string
    immutableStateVersion: string
  }
}) {
  const dedupeKey = completeObservationDedupeKey({
    source: input.source,
    providerPaymentId: input.payment.providerPaymentId,
    providerCaptureId: input.payment.providerCaptureId,
    normalizedStatus: input.payment.status,
    amountMinor: input.payment.amountMinor,
    currency: input.payment.currency,
    immutableStateVersion: input.payment.immutableStateVersion,
  })
  const normalizedPayload = {
    status: input.payment.status,
    providerPaymentId: input.payment.providerPaymentId,
    providerCaptureId: input.payment.providerCaptureId ?? null,
    amountMinor: serializeAmountMinor(input.payment.amountMinor),
    currency: input.payment.currency,
    immutableStateVersion: input.payment.immutableStateVersion,
  }
  return recordPaymentObservation({
    provider: input.provider,
    providerAccountKey: input.providerAccountKey,
    source: input.source,
    verificationMethod: 'authenticated_provider_api',
    paymentAttemptId: input.paymentAttemptId,
    providerPaymentId: input.payment.providerPaymentId,
    providerCaptureId: input.payment.providerCaptureId ?? null,
    dedupeKey,
    eventType: `payment.${input.payment.status}`,
    payloadSha256: hashNormalizedPayload(normalizedPayload),
    normalizedPayload,
    signatureVerified: true,
  })
}

export async function completeOrder(userId: number, orderId: string, idempotencyKey: string) {
  assertRechargeAcceptsNewOrders()
  const digest = computeRechargeRequestDigest({ orderId })
  const claim = await claimRechargeIdempotency({
    userId,
    scope: 'complete_payment',
    key: idempotencyKey,
    requestDigest: digest,
    resultType: 'RechargeComplete',
  })
  if (claim.kind === 'replay') {
    const existing = await loadOwnedOrder(userId, orderId)
    return serializeOrder(existing, { observationId: claim.resultId, paymentStatus: existing.status })
  }

  try {
    const order = await loadOwnedOrder(userId, orderId)
    if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'failed') {
      throw conflict('订单已关闭，不能完成支付')
    }
    const intent = order.paymentIntent
    if (!intent) throw notFound('支付意图不存在')
    const attempt = intent.attempts.find(item => item.id === intent.activeAttemptId)
      ?? intent.attempts.find(item => NON_TERMINAL_ATTEMPT.has(item.status))
    if (!attempt) throw paymentAlreadyInProgress('没有可完成的支付尝试')
    if (!attempt.providerPaymentId) throw paymentCompletionNotSupported()

    const provider = getHistoricalProvider(asProviderName(order.provider))
    const capabilities = await provider.getCapabilities({
      providerAccountKey: order.providerAccountKey,
      environment: providerEnvironment(),
      currency: order.currency as RechargeCurrency,
      paymentMethod: order.paymentMethod,
    })
    if (!provider.completePayment || !capabilities.supportsBuyerApprovalCapture) {
      throw paymentCompletionNotSupported()
    }

    let normalized = await provider.completePayment({
      orderId: order.id,
      paymentAttemptId: attempt.id,
      providerPaymentId: attempt.providerPaymentId,
      providerAccountKey: order.providerAccountKey,
      requestIdempotencyKey: `recharge:${order.id}:complete:v1`,
      amountMinor: order.amountMinor,
      currency: order.currency as RechargeCurrency,
    })

    let source: 'provider_complete' | 'provider_query' = 'provider_complete'
    if (normalized.status === 'unknown' || normalized.status === 'processing') {
      const queried = await provider.queryPayment({
        providerPaymentId: attempt.providerPaymentId,
        providerAccountKey: order.providerAccountKey,
        providerOrderId: attempt.providerOrderId,
      })
      if (queried.status !== 'unknown') {
        normalized = queried
        source = 'provider_query'
      }
    }

    if (normalized.status === 'failed' || normalized.status === 'cancelled' || normalized.status === 'unknown') {
      await prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: normalized.status,
          lastErrorCode: normalized.status === 'unknown' ? 'PAYMENT_STATE_UNKNOWN' : 'PAYMENT_FAILED',
          providerCaptureId: normalized.providerCaptureId ?? attempt.providerCaptureId,
        },
      })
    }

    const observation = await persistNormalizedObservation({
      source,
      provider: order.provider,
      providerAccountKey: order.providerAccountKey,
      paymentAttemptId: attempt.id,
      payment: {
        status: normalized.status,
        providerPaymentId: normalized.providerPaymentId,
        providerCaptureId: normalized.providerCaptureId,
        amountMinor: normalized.amountMinor,
        currency: normalized.currency,
        immutableStateVersion: normalized.immutableStateVersion,
      },
    })

    await prisma.$transaction(async tx => {
      await completeRechargeIdempotencyClaim(tx, {
        userId,
        scope: 'complete_payment',
        key: idempotencyKey,
        claimToken: claim.claimToken,
        resultId: observation.id,
      })
    }, TX)

    const fresh = await loadOwnedOrder(userId, orderId)
    return serializeOrder(fresh, {
      observationId: observation.id,
      paymentStatus: normalized.status,
    })
  } catch (err) {
    await releaseRechargeIdempotencyClaim({
      userId,
      scope: 'complete_payment',
      key: idempotencyKey,
      claimToken: claim.claimToken,
    })
    throw err
  }
}

async function closeAndMaybeRelease(
  tx: Prisma.TransactionClient,
  order: {
    id: string
    userId: number
    status: string
    provider: string
    providerAccountKey: string
    paymentMethod: string
    currency: string
    amountMinor: bigint
  },
  terminalStatus: Extract<RechargeOrderStatus, 'cancelled' | 'expired'>,
) {
  const intent = await tx.paymentIntent.findUnique({
    where: { rechargeOrderId: order.id },
    include: { attempts: true },
  })
  const attempts = intent?.attempts ?? []
  const active = attempts.find(item => NON_TERMINAL_ATTEMPT.has(item.status))

  if (!active) {
    const confirmedClosed = attempts.length === 0 || attempts.every(item => !NON_TERMINAL_ATTEMPT.has(item.status) && item.status !== 'succeeded')
    if (!confirmedClosed && attempts.some(item => item.status === 'succeeded')) {
      return { status: order.status, released: false }
    }
    await tx.rechargeOrder.updateMany({
      where: { id: order.id, status: { in: ['created', 'pending_payment', 'closure_pending'] } },
      data: { status: terminalStatus, cancelledAt: new Date() },
    })
    if (intent) {
      await tx.paymentIntent.updateMany({
        where: { id: intent.id, status: { in: ['requires_method', 'processing'] } },
        data: { status: 'cancelled', activeAttemptId: null },
      })
    }
    await releaseLimitReservations(tx, order.id)
    return { status: terminalStatus, released: true }
  }

  await tx.rechargeOrder.updateMany({
    where: { id: order.id, status: { in: ['created', 'pending_payment'] } },
    data: { status: 'closure_pending' },
  })

  if (!active.providerPaymentId) {
    if (active.status === 'created' || active.status === 'failed' || active.status === 'cancelled') {
      await tx.paymentAttempt.updateMany({
        where: { id: active.id, status: { in: [...NON_TERMINAL_ATTEMPT] } },
        data: { status: 'cancelled', completedAt: new Date() },
      })
      await tx.rechargeOrder.updateMany({
        where: { id: order.id, status: { in: ['created', 'pending_payment', 'closure_pending'] } },
        data: { status: terminalStatus, cancelledAt: new Date() },
      })
      await releaseLimitReservations(tx, order.id)
      return { status: terminalStatus, released: true }
    }
    return { status: 'closure_pending', released: false }
  }

  const provider = getHistoricalProvider(asProviderName(order.provider))
  const closed = await provider.closePayment({
    providerPaymentId: active.providerPaymentId,
    providerAccountKey: order.providerAccountKey,
    requestIdempotencyKey: `recharge:${order.id}:close:v1`,
  })
  const queried = closed.status === 'unknown' || closed.status === 'processing' || closed.status === 'succeeded'
    ? await provider.queryPayment({
      providerPaymentId: active.providerPaymentId,
      providerAccountKey: order.providerAccountKey,
      providerOrderId: active.providerOrderId,
    })
    : { status: closed.status, providerPaymentId: active.providerPaymentId, amountMinor: order.amountMinor, currency: order.currency as RechargeCurrency, providerAccountKey: order.providerAccountKey, immutableStateVersion: closed.immutableStateVersion, providerCaptureId: active.providerCaptureId }

  if (queried.status === 'succeeded') {
    await persistNormalizedObservation({
      source: 'provider_query',
      provider: order.provider,
      providerAccountKey: order.providerAccountKey,
      paymentAttemptId: active.id,
      payment: {
        status: 'succeeded',
        providerPaymentId: queried.providerPaymentId,
        providerCaptureId: queried.providerCaptureId,
        amountMinor: queried.amountMinor,
        currency: queried.currency,
        immutableStateVersion: queried.immutableStateVersion,
      },
    })
    return { status: 'closure_pending', released: false }
  }

  if (queried.status === 'unknown' || queried.status === 'processing' || queried.status === 'requires_action' || queried.status === 'created') {
    await tx.paymentAttempt.update({
      where: { id: active.id },
      data: { status: queried.status === 'created' ? 'unknown' : queried.status },
    })
    return { status: 'closure_pending', released: false }
  }

  await tx.paymentAttempt.update({
    where: { id: active.id },
    data: { status: queried.status, completedAt: new Date() },
  })
  await tx.rechargeOrder.updateMany({
    where: { id: order.id, status: { in: ['closure_pending', 'pending_payment', 'created'] } },
    data: { status: terminalStatus, cancelledAt: new Date() },
  })
  if (intent) {
    await tx.paymentIntent.updateMany({
      where: { id: intent.id },
      data: { status: 'cancelled', activeAttemptId: null },
    })
  }
  await releaseLimitReservations(tx, order.id)
  return { status: terminalStatus, released: true }
}

export async function cancelOrder(userId: number, orderId: string, idempotencyKey: string) {
  const digest = computeRechargeRequestDigest({ orderId, action: 'cancel' })
  const claim = await claimRechargeIdempotency({
    userId,
    scope: 'cancel_order',
    key: idempotencyKey,
    requestDigest: digest,
    resultType: 'RechargeCancel',
  })
  if (claim.kind === 'replay') {
    return serializeOrder(await loadOwnedOrder(userId, orderId))
  }
  try {
    await prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{
        id: string
        userId: number
        status: string
        provider: string
        providerAccountKey: string
        paymentMethod: string
        currency: string
        amountMinor: bigint
      }>>`
        SELECT "id", "userId", "status", "provider", "providerAccountKey", "paymentMethod", "currency", "amountMinor"
        FROM "RechargeOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`
      const order = rows[0]
      if (!order || order.userId !== userId) throw notFound('充值订单不存在')
      if (order.status === 'paid' || order.status === 'credited' || order.status === 'refund_pending' || order.status === 'refunded') {
        throw conflict('已支付订单不能取消')
      }
      if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'failed') {
        await completeRechargeIdempotencyClaim(tx, {
          userId,
          scope: 'cancel_order',
          key: idempotencyKey,
          claimToken: claim.claimToken,
          resultId: order.id,
        })
        return
      }
      await closeAndMaybeRelease(tx, order, 'cancelled')
      await completeRechargeIdempotencyClaim(tx, {
        userId,
        scope: 'cancel_order',
        key: idempotencyKey,
        claimToken: claim.claimToken,
        resultId: order.id,
      })
    }, TX)
    return serializeOrder(await loadOwnedOrder(userId, orderId))
  } catch (err) {
    await releaseRechargeIdempotencyClaim({
      userId,
      scope: 'cancel_order',
      key: idempotencyKey,
      claimToken: claim.claimToken,
    })
    throw err
  }
}

export async function expireOrder(userId: number, orderId: string) {
  await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{
      id: string
      userId: number
      status: string
      provider: string
      providerAccountKey: string
      paymentMethod: string
      currency: string
      amountMinor: bigint
    }>>`
      SELECT "id", "userId", "status", "provider", "providerAccountKey", "paymentMethod", "currency", "amountMinor"
      FROM "RechargeOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`
    const order = rows[0]
    if (!order || order.userId !== userId) throw notFound('充值订单不存在')
    if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'failed' || order.status === 'paid' || order.status === 'credited') {
      return
    }
    await closeAndMaybeRelease(tx, order, 'expired')
  }, TX)
  return serializeOrder(await loadOwnedOrder(userId, orderId))
}

export async function requestRefund() {
  throw conflict('退款尚未开放')
}
