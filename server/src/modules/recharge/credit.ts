import { Prisma } from '@prisma/client'
import { HttpError, pointBalanceHardCap } from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import {
  POINT_ACCOUNT_HARD_CAP,
  creditAvailablePoints,
} from '../points/checkedMutation.js'
import { tripWriteHook } from '../payment/events/hooks.js'
import { commitCreditTask } from '../payment/workers/lease.js'
import { serializeAmountMinor } from './money.js'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
export const CREDIT_BUSINESS_EVENT_KEY = (orderId: string) => `recharge:${orderId}:credit:v1`

export type CreditApplyResult =
  | { kind: 'credited'; creditId: string; alreadyExisted: boolean }
  | { kind: 'skipped'; reason: string }
  | { kind: 'reconcile_required'; reason: string }

function asJsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function toSafeCreditPoints(points: bigint): number {
  if (points <= 0n) {
    throw pointBalanceHardCap('充值积分必须为正整数')
  }
  if (points > BigInt(POINT_ACCOUNT_HARD_CAP)) {
    throw pointBalanceHardCap()
  }
  const asNumber = Number(points)
  if (!Number.isSafeInteger(asNumber)) {
    throw pointBalanceHardCap('充值积分无法安全转换为整数')
  }
  return asNumber
}

function isRetryableCreditError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.code === 'POINT_BALANCE_CONFLICT'
  }
  const rec = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = rec.code != null ? String(rec.code) : ''
  return code === 'P2034' || code === '40001' || /deadlock|serialization/i.test(String(error))
}

async function writeCreditNotification(
  tx: Prisma.TransactionClient,
  input: { userId: number; orderId: string; points: bigint },
) {
  await tx.notification.createMany({
    data: [{
      recipientUserId: input.userId,
      recipientRole: 'user',
      eventType: 'recharge.credited',
      category: 'system',
      title: '充值已到账',
      body: `已到账 ${serializeAmountMinor(input.points)} 积分`,
      payload: {
        rechargeOrderId: input.orderId,
        points: serializeAmountMinor(input.points),
      },
      deeplink: `/recharge?order=${input.orderId}`,
      level: 'success',
      dedupeKey: `recharge:${input.orderId}:credited`,
      relatedOrderId: null,
    }],
    skipDuplicates: true,
  })
}

/**
 * Transaction B: credit points for a paid recharge order.
 * Only the current lease owner may commit the credit task afterwards.
 */
function isDeadlock(error: unknown): boolean {
  const rec = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = rec.code != null ? String(rec.code) : ''
  const meta = rec.meta && typeof rec.meta === 'object' ? rec.meta as Record<string, unknown> : {}
  const text = [code, meta.code, rec.message].map(item => item == null ? '' : String(item)).join(' ')
  return code === 'P2034' || code === '40P01' || /40P01|deadlock/i.test(text)
}

export async function executeRechargeCredit(input: {
  rechargeOrderId: string
  creditTaskId?: string
  leaseToken?: string
}): Promise<CreditApplyResult> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await executeRechargeCreditOnce(input)
    } catch (error) {
      lastError = error
      if (error instanceof Error && error.message.startsWith('TEST_ROLLBACK:')) throw error
      if (!isDeadlock(error) && !isRetryableCreditError(error)) throw error
    }
  }
  throw lastError
}

async function executeRechargeCreditOnce(input: {
  rechargeOrderId: string
  creditTaskId?: string
  leaseToken?: string
}): Promise<CreditApplyResult> {
  let result: CreditApplyResult
  try {
    result = await prisma.$transaction(async tx => {
      const orderRows = await tx.$queryRaw<Array<{
        id: string
        userId: number
        status: string
        totalPoints: bigint
        paymentIntentId: string | null
      }>>`
        SELECT o."id", o."userId", o."status", o."totalPoints", i."id" AS "paymentIntentId"
        FROM "RechargeOrder" o
        LEFT JOIN "PaymentIntent" i ON i."rechargeOrderId" = o."id"
        WHERE o."id" = ${input.rechargeOrderId}::uuid
        FOR UPDATE OF o`
      const order = orderRows[0]
      if (!order) return { kind: 'skipped', reason: 'order_missing' } as const
      tripWriteHook('after_lock')

      const existing = await tx.rechargeCredit.findUnique({
        where: { rechargeOrderId: order.id },
        select: { id: true },
      })
      if (existing) {
        await tx.rechargeOrder.updateMany({
          where: { id: order.id, status: 'paid' },
          data: { status: 'credited', creditedAt: new Date() },
        })
        return { kind: 'credited', creditId: existing.id, alreadyExisted: true } as const
      }
      if (order.status !== 'paid') {
        return { kind: 'skipped', reason: `order_${order.status}` } as const
      }
      if (!order.paymentIntentId) {
        return { kind: 'reconcile_required', reason: 'missing_payment_intent' } as const
      }

      await tx.$queryRaw`SELECT "userId" FROM "PointAccount" WHERE "userId" = ${order.userId} FOR UPDATE`
      const points = toSafeCreditPoints(order.totalPoints)
      const account = await tx.pointAccount.findUniqueOrThrow({ where: { userId: order.userId } })
      if (BigInt(account.balance) + BigInt(account.frozenBalance) + BigInt(points) > BigInt(POINT_ACCOUNT_HARD_CAP)) {
        throw pointBalanceHardCap()
      }
      tripWriteHook('after_points_check')

      const credited = await creditAvailablePoints(tx, order.userId, points)
      tripWriteHook('after_balance')

      const log = await tx.pointLog.create({
        data: {
          userId: order.userId,
          type: 'in',
          amount: points,
          balanceAfter: credited.balance,
          reason: '充值入账',
        },
      })
      tripWriteHook('after_point_log')

      const credit = await tx.rechargeCredit.create({
        data: {
          rechargeOrderId: order.id,
          paymentIntentId: order.paymentIntentId,
          userId: order.userId,
          points: order.totalPoints,
          balanceBefore: credited.balance - points,
          balanceAfter: credited.balance,
          businessEventKey: CREDIT_BUSINESS_EVENT_KEY(order.id),
          pointLogId: log.id,
        },
      })
      tripWriteHook('after_credit_row')

      const cas = await tx.rechargeOrder.updateMany({
        where: { id: order.id, status: 'paid' },
        data: { status: 'credited', creditedAt: new Date() },
      })
      if (cas.count !== 1) {
        throw new Error('order status changed during credit')
      }
      tripWriteHook('after_cas_credited')

      await writeCreditNotification(tx, {
        userId: order.userId,
        orderId: order.id,
        points: order.totalPoints,
      })
      tripWriteHook('after_notification')

      return { kind: 'credited', creditId: credit.id, alreadyExisted: false } as const
    }, TX)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.rechargeCredit.findUnique({
        where: { rechargeOrderId: input.rechargeOrderId },
        select: { id: true },
      })
      if (existing) {
        if (input.creditTaskId && input.leaseToken) {
          await commitCreditTask(input.creditTaskId, input.leaseToken, 'succeeded')
        }
        return { kind: 'credited', creditId: existing.id, alreadyExisted: true }
      }
    }
    if (error instanceof Error && error.message.startsWith('TEST_ROLLBACK:')) {
      throw error
    }
    if (isRetryableCreditError(error)) {
      if (input.creditTaskId && input.leaseToken) {
        await commitCreditTask(input.creditTaskId, input.leaseToken, 'failed', 'POINT_BALANCE_CONFLICT')
      }
      throw error
    }
    await markCreditReconcileRequired(input.rechargeOrderId, input.creditTaskId, input.leaseToken, error)
    return { kind: 'reconcile_required', reason: error instanceof HttpError ? error.code : 'credit_failed' }
  }

  if (input.creditTaskId && input.leaseToken) {
    if (result.kind === 'credited') {
      const committed = await commitCreditTask(input.creditTaskId, input.leaseToken, 'succeeded')
      if (!committed) {
        throw new Error('expired credit lease cannot commit')
      }
    } else if (result.kind === 'reconcile_required') {
      await commitCreditTask(input.creditTaskId, input.leaseToken, 'reconcile_required', result.reason)
    } else {
      await commitCreditTask(input.creditTaskId, input.leaseToken, 'failed', result.reason)
    }
  }

  if (result.kind === 'credited' && !result.alreadyExisted) {
    logger.info({ event: 'recharge.credited', rechargeOrderId: input.rechargeOrderId }, 'recharge credited')
  }
  return result
}

async function markCreditReconcileRequired(
  orderId: string,
  creditTaskId: string | undefined,
  leaseToken: string | undefined,
  error: unknown,
) {
  const reason = error instanceof HttpError ? error.code : 'CREDIT_INVARIANT'
  await prisma.$transaction(async tx => {
    await tx.rechargeOrder.updateMany({
      where: { id: orderId, status: 'paid' },
      data: { status: 'reconcile_required' },
    })
    if (creditTaskId) {
      await tx.rechargeCreditTask.updateMany({
        where: { id: creditTaskId },
        data: { lastErrorCode: reason },
      })
    }
  }, TX)
  if (creditTaskId && leaseToken) {
    await commitCreditTask(creditTaskId, leaseToken, 'reconcile_required', reason)
  }
  logger.error({
    event: 'recharge.credit_reconcile_required',
    rechargeOrderId: orderId,
    reason,
  }, 'credit marked reconcile_required')
}

export function parseNormalizedPaymentPayload(value: Prisma.JsonValue | null | undefined) {
  const payload = asJsonRecord(value)
  const amountRaw = payload.amountMinor
  return {
    status: typeof payload.status === 'string' ? payload.status : '',
    providerPaymentId: typeof payload.providerPaymentId === 'string' ? payload.providerPaymentId : null,
    providerCaptureId: typeof payload.providerCaptureId === 'string' ? payload.providerCaptureId : null,
    providerRefundId: typeof payload.providerRefundId === 'string' ? payload.providerRefundId : null,
    amountMinor: typeof amountRaw === 'string' ? BigInt(amountRaw) : null,
    currency: typeof payload.currency === 'string' ? payload.currency : null,
    immutableStateVersion: typeof payload.immutableStateVersion === 'string' ? payload.immutableStateVersion : null,
  }
}
