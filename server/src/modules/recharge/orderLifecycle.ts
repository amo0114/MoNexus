import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { conflict, HttpError, notFound, paymentStateUnknown, rechargeQuoteChanged, rechargeQuoteExpired } from '../../lib/httpError.js'
import { getHistoricalProvider } from '../payment/providers/registry.js'
import { recordNormalizedPaymentFact } from '../payment/observations/record.js'
import { isPaymentDeadlock } from '../payment/workers/lease.js'
import { PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES, type PaymentAttemptStatus, type RechargeCurrency, type RechargeOrderStatus } from './types.js'
import { assertCurrencyEnabled, assertRechargeAcceptsNewOrders, assertRechargeNotRestricted, isAdminSandboxMode, assertAdminSandboxActor, assertAdminSandboxSelection } from './gates.js'
import { effectiveAmountBounds } from './policy.js'
import { releaseLimitReservations, reserveLimitBuckets } from './limits.js'
import { resolveLimitPeriods } from './periods.js'
import { claimRechargeIdempotency, completeRechargeIdempotencyClaim, computeRechargeRequestDigest, rechargeIdempotencyInFlight, releaseRechargeIdempotencyClaim } from './idempotency.js'
import { includeAttempts, loadOwnedOrder, serializeOrder } from './orderQueries.js'
import { asProviderName, resolveCapabilities } from './providerSelection.js'

export const ORDER_TTL_MS = 30 * 60 * 1000
export const DISCLOSURE_VERSION = 'recharge-disclosure-v1'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
const NON_TERMINAL_ATTEMPT = new Set<string>(PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES)

function buyerReturnUrl(orderId: string): string {
  const origin = String(config.appBaseUrl || config.frontendOrigin || '').replace(/\/$/, '')
  const path = `/recharge?order=${orderId}`
  return origin ? `${origin}${path}` : path
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
    await recordNormalizedPaymentFact({
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
