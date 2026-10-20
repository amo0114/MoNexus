import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES, type RechargeOrderStatus } from './types.js'
import { serializeAmountMinor } from './money.js'
import { parseStoredAction, publicPaymentAction } from './serialize.js'

const NON_TERMINAL_ATTEMPT = new Set<string>(PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES)

export function includeAttempts() {
  return { paymentIntent: { include: { attempts: { orderBy: { createdAt: 'asc' as const } } } } }
}

export async function loadOwnedOrder(userId: number, orderId: string) {
  const order = await prisma.rechargeOrder.findUnique({
    where: { id: orderId },
    include: includeAttempts(),
  })
  if (!order || order.userId !== userId) throw notFound('充值订单不存在')
  return order
}

export function serializeOrder(order: {
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
