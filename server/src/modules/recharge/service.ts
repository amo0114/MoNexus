import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import {
  conflict,
  forbidden,
  HttpError,
  notFound,
  paymentAlreadyInProgress,
  paymentCompletionNotSupported,
  paymentProviderUnavailable,
  paymentStateUnknown,
} from '../../lib/httpError.js'
import { getEnabledProvider, getHistoricalProvider, listEnabledProviders } from '../payment/providers/registry.js'
import type { PaymentProvider, ProviderCapabilities } from '../payment/providers/types.js'
import { recordNormalizedPaymentFact } from '../payment/observations/record.js'
import { applyConfirmedPayment } from '../payment/events/applyConfirmedPayment.js'
import { requestRechargeRefund } from './refund.js'
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
  rechargeIdempotencyInFlight,
  releaseRechargeIdempotencyClaim,
} from './idempotency.js'
import { parseStoredAction, publicPaymentAction } from './serialize.js'
import { rechargeQuoteChanged, rechargeQuoteExpired } from '../../lib/httpError.js'
import { isPaymentDeadlock } from '../payment/workers/lease.js'

export const QUOTE_TTL_MS = 10 * 60 * 1000
export const ORDER_TTL_MS = 30 * 60 * 1000
export const DISCLOSURE_VERSION = 'recharge-disclosure-v1'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
const NON_TERMINAL_ATTEMPT = new Set<string>(PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES)
const PROVIDER_PAYMENT_METHODS: Readonly<Record<PaymentProviderName, readonly string[]>> = {
  simulator: ['card', 'redirect', 'qr_code', 'form_post'],
  stripe: ['card'],
  paypal: ['redirect'],
  wechat_pay: ['native'],
  alipay: ['wap', 'page'],
}

function isAdminSandboxMode(): boolean {
  return config.recharge.mode === 'admin_sandbox'
}

function assertAdminSandboxActor(role: string): void {
  if (isAdminSandboxMode() && role !== 'admin') {
    throw forbidden('管理员沙箱充值仅限管理员使用')
  }
}

function assertAdminSandboxSelection(input: {
  currency: string
  provider: string
  paymentMethod: string
}): void {
  if (!isAdminSandboxMode()) return
  if (input.currency !== 'CNY' || input.provider !== 'simulator' || input.paymentMethod !== 'card') {
    throw paymentProviderUnavailable('管理员沙箱充值仅支持 CNY、Simulator 和卡支付')
  }
}

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

export async function getRechargeConfig(userId: number, currencyRaw: string, role: string) {
  assertRechargeAcceptsNewOrders()
  assertAdminSandboxActor(role)
  assertCurrencyEnabled(currencyRaw)
  const currency = currencyRaw
  const policy = await getActivePricePolicy(currency, isAdminSandboxMode())
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
    const probeMethods = isAdminSandboxMode() ? ['card'] : PROVIDER_PAYMENT_METHODS[adapter.name]
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
  const sandboxBalance = isAdminSandboxMode()
    ? (await prisma.pointAccount.findUnique({ where: { userId }, select: { sandboxBalance: true } }))?.sandboxBalance ?? 0
    : undefined
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
    ...(sandboxBalance !== undefined ? { sandboxBalance } : {}),
  }
}

export async function createQuote(userId: number, input: {
  currency: string
  amountMinor: bigint
  amountSource: AmountSource
  provider: string
  paymentMethod: string
}, role: string) {
  assertRechargeAcceptsNewOrders()
  assertAdminSandboxActor(role)
  assertAdminSandboxSelection(input)
  assertCurrencyEnabled(input.currency)
  await assertRechargeNotRestricted(userId)
  const currency = input.currency
  const providerName = asProviderName(input.provider)
  const policy = await getActivePricePolicy(currency, isAdminSandboxMode())
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
      adminSandbox: isAdminSandboxMode(),
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

function buyerReturnUrl(orderId: string): string {
  const origin = String(config.appBaseUrl || config.frontendOrigin || '').replace(/\/$/, '')
  const path = `/recharge?order=${orderId}`
  return origin ? `${origin}${path}` : path
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
  adminSandbox: boolean
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
      expectedProviderAmountMinor: bigint
    }>
  } | null
}, options?: { includeAction?: boolean; observationId?: string | null; paymentStatus?: string }) {
  const attempts = order.paymentIntent?.attempts ?? []
  const active = [...attempts].reverse().find(attempt => NON_TERMINAL_ATTEMPT.has(attempt.status)) ?? attempts.at(-1)
  const action = options?.includeAction === false ? null : publicPaymentAction(parseStoredAction(active?.actionPayload ?? null))
  const payableAmountMinor = active?.expectedProviderAmountMinor ?? order.amountMinor
  return {
    orderId: order.id,
    status: order.status,
    currency: order.currency,
    amountMinor: serializeAmountMinor(order.amountMinor),
    payableAmountMinor: serializeAmountMinor(payableAmountMinor),
    basePoints: serializeAmountMinor(order.basePoints),
    bonusPoints: serializeAmountMinor(order.bonusPoints),
    totalPoints: serializeAmountMinor(order.totalPoints),
    provider: order.provider,
    paymentMethod: order.paymentMethod,
    adminSandbox: order.adminSandbox,
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

const OPEN_ORDER = ['created', 'pending_payment'] as const
const CLOSING_ORDER = ['cancelled', 'expired', 'failed', 'closure_pending'] as const
const OPEN_INTENT = ['requires_method', 'processing'] as const

type OrderWithAttempts = {
  id: string
  userId: number
  status: string
  provider: string
  providerAccountKey: string
  paymentMethod: string
  currency: string
  amountMinor: bigint
  adminSandbox: boolean
  paymentIntent: {
    id: string
    status: string
    activeAttemptId: string | null
    attempts: Array<{
      id: string
      status: string
      providerPaymentId: string | null
      providerOrderId: string | null
      requestIdempotencyKey: string
    }>
  } | null
}

function assertOrderMatchesCurrentMode(order: Pick<OrderWithAttempts, 'adminSandbox' | 'provider' | 'paymentMethod' | 'currency'>): void {
  if (order.adminSandbox !== isAdminSandboxMode()) throw rechargeQuoteChanged()
  assertAdminSandboxSelection(order)
}

function includeAttempts() {
  return { paymentIntent: { include: { attempts: { orderBy: { createdAt: 'asc' as const } } } } }
}

async function loadOrderByQuote(userId: number, quoteId: string): Promise<OrderWithAttempts | null> {
  const order = await prisma.rechargeOrder.findUnique({
    where: { quoteId },
    include: includeAttempts(),
  })
  if (!order || order.userId !== userId) return null
  return order
}

async function provisionExistingOrder(order: OrderWithAttempts) {
  const intent = order.paymentIntent
  if (!intent) return
  const attempt = intent.attempts.find(item => item.id === intent.activeAttemptId) ?? intent.attempts[0]
  if (!attempt) return
  await persistProviderCreate(order, intent, attempt)
}

function isDeterministicCreateFailure(error: unknown): boolean {
  return error instanceof HttpError
    && error.status >= 400
    && error.status < 500
    && error.code !== 'PAYMENT_STATE_UNKNOWN'
}

async function failUncreatedPayment(orderId: string, intentId: string, attemptId: string, error: unknown) {
  await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "RechargeOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`
    if (!rows[0] || ['paid', 'credited', 'refund_pending', 'refunded'].includes(rows[0].status)) return
    await tx.paymentAttempt.updateMany({
      where: { id: attemptId, status: 'created', providerPaymentId: null },
      data: {
        status: 'failed',
        completedAt: new Date(),
        lastErrorCode: error instanceof HttpError ? error.code : 'PAYMENT_FAILED',
      },
    })
    await tx.paymentIntent.updateMany({
      where: { id: intentId, status: { in: [...OPEN_INTENT] } },
      data: { status: 'failed', activeAttemptId: null },
    })
    await tx.rechargeOrder.updateMany({
      where: { id: orderId, status: { in: ['created', 'pending_payment', 'closure_pending'] } },
      data: { status: 'failed', cancelledAt: new Date() },
    })
    await releaseLimitReservations(tx, orderId)
  }, TX)
}

async function persistUnknownPayable(
  orderId: string,
  intentId: string,
  attemptId: string,
  created: { providerPaymentId: string; providerOrderId?: string | null; action: { type: string } },
) {
  await prisma.$transaction(async tx => {
    const cas = await tx.paymentAttempt.updateMany({
      where: { id: attemptId, status: 'created', providerPaymentId: null },
      data: {
        status: 'unknown',
        providerPaymentId: created.providerPaymentId || null,
        providerOrderId: created.providerOrderId ?? null,
        actionType: created.action.type,
        actionPayload: JSON.stringify(created.action),
        lastErrorCode: 'PAYMENT_STATE_UNKNOWN',
      },
    })
    if (cas.count !== 1) return
    await tx.paymentIntent.updateMany({
      where: { id: intentId, status: { in: [...OPEN_INTENT] } },
      data: { status: 'reconcile_required', activeAttemptId: attemptId },
    })
    await tx.rechargeOrder.updateMany({
      where: { id: orderId, status: { in: ['created', 'pending_payment', 'closure_pending'] } },
      data: { status: 'reconcile_required' },
    })
  }, TX)
}

async function persistProviderCreate(
  order: OrderWithAttempts,
  intent: { id: string },
  attempt: { id: string; status: string; providerPaymentId: string | null; requestIdempotencyKey: string },
) {
  if (attempt.providerPaymentId) {
    if ((CLOSING_ORDER as readonly string[]).includes(order.status)) {
      await confirmProviderClosure(order, order.status === 'expired' ? 'expired' : 'cancelled')
    }
    return
  }
  if (attempt.status !== 'created') return

  const provider = getHistoricalProvider(asProviderName(order.provider))
  let created
  try {
    created = await provider.createPayment({
      orderId: order.id,
      paymentIntentId: intent.id,
      paymentAttemptId: attempt.id,
      amountMinor: order.amountMinor,
      currency: order.currency as RechargeCurrency,
      paymentMethod: order.paymentMethod,
      providerAccountKey: order.providerAccountKey,
      requestIdempotencyKey: attempt.requestIdempotencyKey,
      returnUrl: buyerReturnUrl(order.id),
    })
  } catch (error) {
    if (isDeterministicCreateFailure(error)) {
      await failUncreatedPayment(order.id, intent.id, attempt.id, error)
    } else {
      await prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: 'created', providerPaymentId: null },
        data: { lastErrorCode: 'PAYMENT_STATE_UNKNOWN' },
      })
    }
    throw error
  }
  if (typeof created.amountMinor !== 'bigint' || created.amountMinor <= 0n) {
    await persistUnknownPayable(order.id, intent.id, attempt.id, created)
    throw paymentStateUnknown('渠道返回的应付金额不合法')
  }
  const now = new Date()
  const attemptStatus: PaymentAttemptStatus = created.status

  let lastError: unknown
  for (let attemptNo = 0; attemptNo < 4; attemptNo += 1) {
    try {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "RechargeOrder" WHERE "id" = ${order.id}::uuid FOR UPDATE`
        await tx.$queryRaw`SELECT "id" FROM "PaymentIntent" WHERE "id" = ${intent.id}::uuid FOR UPDATE`
        await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${attempt.id}::uuid FOR UPDATE`
        const cas = await tx.paymentAttempt.updateMany({
          where: { id: attempt.id, status: 'created', providerPaymentId: null },
          data: {
            status: attemptStatus,
            providerPaymentId: created.providerPaymentId,
            providerOrderId: created.providerOrderId ?? null,
            actionType: created.action.type,
            actionPayload: JSON.stringify(created.action),
            expectedProviderAmountMinor: created.amountMinor,
            completedAt: attemptStatus === 'failed' ? now : null,
            lastErrorCode: attemptStatus === 'failed' ? 'PAYMENT_FAILED' : null,
          },
        })
        if (cas.count !== 1) return

        if (attemptStatus === 'failed') {
          const failed = await tx.rechargeOrder.updateMany({
            where: { id: order.id, status: { in: [...OPEN_ORDER] } },
            data: { status: 'failed' },
          })
          if (failed.count === 1) {
            await tx.paymentIntent.updateMany({
              where: { id: intent.id, status: { in: [...OPEN_INTENT] } },
              data: { status: 'failed', activeAttemptId: null },
            })
            await releaseLimitReservations(tx, order.id)
          }
          return
        }

        await tx.paymentIntent.updateMany({
          where: { id: intent.id, status: { in: [...OPEN_INTENT] } },
          data: { status: 'processing', activeAttemptId: attempt.id },
        })
        await tx.rechargeOrder.updateMany({
          where: { id: order.id, status: { in: [...OPEN_ORDER] } },
          data: { status: 'pending_payment' },
        })
      }, TX)
      lastError = null
      break
    } catch (error) {
      lastError = error
      if (!isPaymentDeadlock(error)) throw error
    }
  }
  if (lastError) throw lastError

  const latest = await prisma.rechargeOrder.findUnique({
    where: { id: order.id },
    include: includeAttempts(),
  })
  if (latest && (CLOSING_ORDER as readonly string[]).includes(latest.status)) {
    await confirmProviderClosure(latest, latest.status === 'expired' ? 'expired' : 'cancelled')
  }
}

export async function recoverProviderCreate(orderId: string) {
  const order = await prisma.rechargeOrder.findUnique({ where: { id: orderId }, include: includeAttempts() })
  if (!order) return null
  await provisionExistingOrder(order)
  return prisma.rechargeOrder.findUnique({ where: { id: orderId }, include: includeAttempts() })
}

async function finishCreateOrder(userId: number, order: OrderWithAttempts, claimToken?: string, idempotencyKey?: string) {
  await provisionExistingOrder(order)
  if (claimToken && idempotencyKey) {
    try {
      await completeRechargeIdempotencyClaim(prisma, {
        userId,
        scope: 'create_order',
        key: idempotencyKey,
        claimToken,
        resultId: order.id,
      })
    } catch {
      // Takeover holder owns the claim; the order row is still the result.
    }
  }
  return serializeOrder(await loadOwnedOrder(userId, order.id))
}

export async function createOrder(userId: number, quoteId: string, idempotencyKey: string, role: string) {
  assertRechargeAcceptsNewOrders()
  assertAdminSandboxActor(role)
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
    assertOrderMatchesCurrentMode(existing)
    return finishCreateOrder(userId, existing)
  }
  const existingByQuote = await loadOrderByQuote(userId, quoteId)
  const sameKeyRecovery = claim.kind === 'in_flight' || (claim.kind === 'claimed' && claim.takeover)
  if (existingByQuote && sameKeyRecovery) {
    assertOrderMatchesCurrentMode(existingByQuote)
    return finishCreateOrder(
      userId,
      existingByQuote,
      claim.kind === 'claimed' ? claim.claimToken : undefined,
      claim.kind === 'claimed' ? idempotencyKey : undefined,
    )
  }
  if (claim.kind === 'in_flight') {
    throw rechargeIdempotencyInFlight()
  }

  let orderCommitted = false
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
        adminSandbox: boolean
        expiresAt: Date
        consumedAt: Date | null
      }>>`
        SELECT * FROM "RechargeQuote" WHERE "id" = ${quoteId}::uuid FOR UPDATE`

      const quote = quoteRows[0]
      if (!quote || quote.userId !== userId) throw notFound('充值报价不存在')
      if (quote.consumedAt || quote.expiresAt <= new Date()) throw rechargeQuoteExpired()
      if (quote.adminSandbox !== isAdminSandboxMode()) throw rechargeQuoteChanged()
      assertAdminSandboxSelection(quote)

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
          adminSandbox: quote.adminSandbox,
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
          expectedProviderAmountMinor: order.amountMinor,
        },
      })
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { activeAttemptId: attempt.id },
      })

      // Sandbox money is not real payment volume. Do not contaminate the
      // administrator's live daily/monthly recharge buckets.
      if (!order.adminSandbox) {
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
      }

      return { order, intent, attempt }
    }, TX)
    orderCommitted = true

    return finishCreateOrder(userId, {
      ...created.order,
      paymentIntent: {
        id: created.intent.id,
        status: created.intent.status,
        activeAttemptId: created.attempt.id,
        attempts: [created.attempt],
      },
    }, claim.claimToken, idempotencyKey)
  } catch (err) {
    if (!orderCommitted) {
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
  return recordNormalizedPaymentFact({
    source: input.source,
    provider: input.provider,
    providerAccountKey: input.providerAccountKey,
    paymentAttemptId: input.paymentAttemptId,
    payment: input.payment,
  })
}

export async function applyTerminalPaymentState(input: {
  orderId: string
  attemptId: string
  status: Extract<PaymentAttemptStatus, 'failed' | 'cancelled'>
}) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "RechargeOrder" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`
    const order = rows[0]
    if (!order || ['paid', 'credited', 'refund_pending', 'refunded'].includes(order.status)) return false
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: input.attemptId },
      include: { paymentIntent: true },
    })
    if (!attempt
      || attempt.paymentIntent.rechargeOrderId !== input.orderId
      || !NON_TERMINAL_ATTEMPT.has(attempt.status)) return false
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: input.status, completedAt: new Date(), lastErrorCode: input.status === 'failed' ? 'PAYMENT_FAILED' : null },
    })
    await tx.paymentIntent.updateMany({
      where: { id: attempt.paymentIntentId, status: { in: [...OPEN_INTENT] } },
      data: { status: input.status === 'cancelled' ? 'cancelled' : 'failed', activeAttemptId: null },
    })
    await tx.rechargeOrder.updateMany({
      where: { id: input.orderId, status: { in: ['created', 'pending_payment', 'closure_pending'] } },
      data: { status: input.status === 'cancelled' ? 'cancelled' : 'failed', cancelledAt: new Date() },
    })
    await releaseLimitReservations(tx, input.orderId)
    return true
  }, TX)
}

export async function completeOrder(userId: number, orderId: string, idempotencyKey: string) {
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
  if (claim.kind === 'in_flight') throw rechargeIdempotencyInFlight()

  try {
    const order = await loadOwnedOrder(userId, orderId)
    if (order.adminSandbox) {
      throw paymentCompletionNotSupported('管理员沙箱支付必须在管理后台确认')
    }
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

    if (normalized.status === 'unknown') {
      await prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: { in: [...PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES] } },
        data: {
          status: normalized.status,
          lastErrorCode: 'PAYMENT_STATE_UNKNOWN',
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
    if (normalized.status === 'succeeded') {
      await applyConfirmedPayment(observation.id)
    } else if (normalized.status === 'failed' || normalized.status === 'cancelled') {
      await applyTerminalPaymentState({ orderId: order.id, attemptId: attempt.id, status: normalized.status })
    }

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

async function markClosurePending(userId: number, orderId: string): Promise<OrderWithAttempts> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{
      id: string
      userId: number
      status: string
    }>>`
      SELECT "id", "userId", "status"
      FROM "RechargeOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`
    const locked = rows[0]
    if (!locked || locked.userId !== userId) throw notFound('充值订单不存在')
    if (locked.status === 'paid' || locked.status === 'credited' || locked.status === 'refund_pending' || locked.status === 'refunded') {
      throw conflict('已支付订单不能取消')
    }
    if (!['cancelled', 'expired', 'failed', 'closure_pending'].includes(locked.status)) {
      await tx.rechargeOrder.updateMany({
        where: { id: orderId, status: { in: [...OPEN_ORDER] } },
        data: { status: 'closure_pending' },
      })
    }
    return tx.rechargeOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: includeAttempts(),
    })
  }, TX)
}

async function confirmProviderClosure(
  order: OrderWithAttempts,
  terminalStatus: Extract<RechargeOrderStatus, 'cancelled' | 'expired'>,
) {
  const attempts = order.paymentIntent?.attempts ?? []
  const createInFlight = attempts.some(item => item.status === 'created' && !item.providerPaymentId)
  if (createInFlight) {
    try {
      await provisionExistingOrder(order)
    } catch {
      return { status: 'closure_pending' as const, released: false }
    }
    const refreshed = await prisma.rechargeOrder.findUnique({ where: { id: order.id }, include: includeAttempts() })
    if (!refreshed || ['cancelled', 'expired', 'failed'].includes(refreshed.status)) {
      return { status: (refreshed?.status ?? 'closure_pending') as 'cancelled' | 'expired' | 'failed' | 'closure_pending', released: refreshed?.status !== 'closure_pending' }
    }
    return confirmProviderClosure(refreshed, terminalStatus)
  }

  if (attempts.length === 0) {
    await finalizeClosedOrder(order, terminalStatus)
    return { status: terminalStatus, released: true }
  }

  const payable = attempts.find(item => item.providerPaymentId && NON_TERMINAL_ATTEMPT.has(item.status))
    ?? [...attempts].reverse().find(item => item.providerPaymentId)
  if (!payable?.providerPaymentId) {
    return { status: 'closure_pending' as const, released: false }
  }

  const provider = getHistoricalProvider(asProviderName(order.provider))
  if (NON_TERMINAL_ATTEMPT.has(payable.status)) {
    await provider.closePayment({
      providerPaymentId: payable.providerPaymentId,
      providerAccountKey: order.providerAccountKey,
      requestIdempotencyKey: `recharge:${order.id}:close:v1`,
    })
  }
  const queried = await provider.queryPayment({
    providerPaymentId: payable.providerPaymentId,
    providerAccountKey: order.providerAccountKey,
    providerOrderId: payable.providerOrderId,
  })

  if (queried.status === 'succeeded') {
    await persistNormalizedObservation({
      source: 'provider_query',
      provider: order.provider,
      providerAccountKey: order.providerAccountKey,
      paymentAttemptId: payable.id,
      payment: {
        status: 'succeeded',
        providerPaymentId: queried.providerPaymentId,
        providerCaptureId: queried.providerCaptureId,
        amountMinor: queried.amountMinor,
        currency: queried.currency,
        immutableStateVersion: queried.immutableStateVersion,
      },
    })
    return { status: 'closure_pending' as const, released: false }
  }

  if (queried.status === 'unknown' || queried.status === 'processing' || queried.status === 'requires_action' || queried.status === 'created') {
    await prisma.paymentAttempt.updateMany({
      where: { id: payable.id, status: { in: [...NON_TERMINAL_ATTEMPT] } },
      data: { status: queried.status === 'created' ? 'unknown' : queried.status },
    })
    return { status: 'closure_pending' as const, released: false }
  }

  await finalizeClosedOrder(order, terminalStatus, {
    attemptId: payable.id,
    attemptStatus: queried.status,
  })
  return { status: terminalStatus, released: true }
}

async function finalizeClosedOrder(
  order: OrderWithAttempts,
  terminalStatus: Extract<RechargeOrderStatus, 'cancelled' | 'expired'>,
  attempt?: { attemptId: string; attemptStatus: string },
) {
  await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status" FROM "RechargeOrder" WHERE "id" = ${order.id}::uuid FOR UPDATE`
    const locked = rows[0]
    if (!locked) return
    if (locked.status === 'paid' || locked.status === 'credited') return
    if (attempt) {
      await tx.paymentAttempt.updateMany({
        where: { id: attempt.attemptId },
        data: { status: attempt.attemptStatus, completedAt: new Date() },
      })
    }
    if (locked.status !== 'cancelled' && locked.status !== 'expired' && locked.status !== 'failed') {
      await tx.rechargeOrder.updateMany({
        where: { id: order.id, status: { in: ['closure_pending', 'pending_payment', 'created'] } },
        data: { status: terminalStatus, cancelledAt: new Date() },
      })
    }
    if (order.paymentIntent) {
      await tx.paymentIntent.updateMany({
        where: { id: order.paymentIntent.id, status: { in: [...OPEN_INTENT] } },
        data: { status: 'cancelled', activeAttemptId: null },
      })
    }
    await releaseLimitReservations(tx, order.id)
  }, TX)
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
  if (claim.kind === 'in_flight') throw rechargeIdempotencyInFlight()
  try {
    const order = await markClosurePending(userId, orderId)
    if (order.status !== 'cancelled' && order.status !== 'expired' && order.status !== 'failed') {
      await confirmProviderClosure(order, 'cancelled')
    }
    await completeRechargeIdempotencyClaim(prisma, {
      userId,
      scope: 'cancel_order',
      key: idempotencyKey,
      claimToken: claim.claimToken,
      resultId: order.id,
    })
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
  const order = await markClosurePending(userId, orderId)
  if (order.status !== 'cancelled' && order.status !== 'expired' && order.status !== 'failed') {
    await confirmProviderClosure(order, 'expired')
  }
  return serializeOrder(await loadOwnedOrder(userId, orderId))
}

export async function requestRefund(userId: number, orderId: string, idempotencyKey: string) {
  return requestRechargeRefund({ userId, orderId, idempotencyKey })
}
