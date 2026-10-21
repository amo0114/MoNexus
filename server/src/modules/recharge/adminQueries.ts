import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { serializeAmountMinor } from './money.js'
import { providerSupportsRefunds } from './refund.js'
import { serializeRun } from '../payment/reconciliation/service.js'
import { serializeDispute } from '../payment/disputes/service.js'
import type {
  PaymentDisputeStatus,
  PaymentEventStatus,
  PaymentProviderName,
  RechargeOrderStatus,
  RechargeRefundStatus,
} from './types.js'
import { parseAndValidateStrictRefundDate } from './adminSchema.js'

function serializeAdminOrder(order: {
  id: string
  userId: number
  status: string
  currency: string
  amountMinor: bigint
  totalPoints: bigint
  provider: string
  paymentMethod: string
  adminSandbox: boolean
  paidAt: Date | null
  creditedAt: Date | null
  cancelledAt: Date | null
  createdAt: Date
  updatedAt: Date
  credit?: { id: string } | null
  refund?: { id: string; status: string } | null
  paymentIntent?: {
    activeAttemptId: string | null
    attempts: Array<{ id: string; expectedProviderAmountMinor: bigint }>
  } | null
}) {
  const attempts = order.paymentIntent?.attempts ?? []
  const active = (order.paymentIntent?.activeAttemptId
    ? attempts.find(item => item.id === order.paymentIntent?.activeAttemptId)
    : undefined) ?? attempts.at(-1)
  const payableAmountMinor = active?.expectedProviderAmountMinor ?? order.amountMinor
  return {
    orderId: order.id,
    userId: order.userId,
    status: order.status,
    currency: order.currency,
    amountMinor: serializeAmountMinor(order.amountMinor),
    payableAmountMinor: serializeAmountMinor(payableAmountMinor),
    totalPoints: serializeAmountMinor(order.totalPoints),
    provider: order.provider,
    paymentMethod: order.paymentMethod,
    adminSandbox: order.adminSandbox,
    paidAt: order.paidAt?.toISOString() ?? null,
    creditedAt: order.creditedAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    creditId: order.credit?.id ?? null,
    refundId: order.refund?.id ?? null,
    refundStatus: order.refund?.status ?? null,
  }
}

async function refundCapabilityByOrderId(
  orders: Array<{
    id: string
    adminSandbox: boolean
    provider: string
    providerAccountKey: string
    paymentMethod: string
    currency: string
  }>,
) {
  const cache = new Map<string, boolean>()
  const byOrderId = new Map<string, boolean>()
  for (const order of orders) {
    if (order.adminSandbox) {
      byOrderId.set(order.id, false)
      continue
    }
    const key = `${order.provider}\0${order.providerAccountKey}\0${order.paymentMethod}\0${order.currency}`
    if (!cache.has(key)) {
      cache.set(key, await providerSupportsRefunds(order))
    }
    byOrderId.set(order.id, cache.get(key) === true)
  }
  return byOrderId
}

export async function adminListOrders(query: {
  page: number
  pageSize: number
  status?: RechargeOrderStatus
  userId?: number
  provider?: PaymentProviderName
}) {
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.provider ? { provider: query.provider } : {}),
  }
  const [total, items] = await prisma.$transaction([
    prisma.rechargeOrder.count({ where }),
    prisma.rechargeOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        credit: true,
        refund: true,
        paymentIntent: { include: { attempts: { orderBy: { createdAt: 'asc' } } } },
      },
    }),
  ])
  const refundCaps = await refundCapabilityByOrderId(items)
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: items.map(item => ({
      ...serializeAdminOrder(item),
      supportsRefunds: refundCaps.get(item.id) === true,
    })),
  }
}

function formatRefundItem(refund: Prisma.RechargeRefundGetPayload<{
  include: {
    rechargeOrder: {
      include: {
        credit: true
      }
    }
    reversal: true
    paymentAttempt: true
  }
}>) {
  let reversalStatus: 'completed' | 'pending' | 'not_required' | 'terminated' | 'anomaly'
  if (refund.reversal) {
    reversalStatus = 'completed'
  } else if (!refund.rechargeOrder?.credit && !refund.rechargeOrder?.creditedAt) {
    reversalStatus = 'not_required'
  } else {
    // Credit issued, no reversal record
    if (refund.status === 'succeeded') {
      reversalStatus = 'anomaly'
    } else if (refund.status === 'failed' || refund.status === 'cancelled') {
      reversalStatus = 'terminated'
    } else {
      // requested, points_held, processing, manual_review
      reversalStatus = 'pending'
    }
  }

  const failureReason = refund.paymentAttempt?.lastErrorSafeMessage ?? refund.paymentAttempt?.lastErrorCode ?? null

  return {
    refundId: refund.id,
    orderId: refund.rechargeOrderId,
    rechargeOrderId: refund.rechargeOrderId,
    refundStatus: refund.status,
    status: refund.status,
    reversalStatus,
    failureReason,
    createdByUserId: refund.createdByUserId,
    requesterUserId: refund.createdByUserId,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
    amountMinor: serializeAmountMinor(refund.amountMinor),
    pointsToReverse: serializeAmountMinor(refund.pointsToReverse),
    reasonCode: refund.reasonCode,
    providerRefundId: refund.providerRefundId ?? null,
    rechargeOrder: {
      id: refund.rechargeOrder.id,
      orderId: refund.rechargeOrder.id,
      userId: refund.rechargeOrder.userId,
      status: refund.rechargeOrder.status,
      currency: refund.rechargeOrder.currency,
      amountMinor: serializeAmountMinor(refund.rechargeOrder.amountMinor),
      totalPoints: serializeAmountMinor(refund.rechargeOrder.totalPoints),
      provider: refund.rechargeOrder.provider,
      paymentMethod: refund.rechargeOrder.paymentMethod,
      paidAt: refund.rechargeOrder.paidAt?.toISOString() ?? null,
      createdAt: refund.rechargeOrder.createdAt.toISOString(),
    },
  }
}

export async function adminListRefunds(query: {
  page: number
  pageSize: number
  status?: RechargeRefundStatus
  userId?: number
  orderId?: string
  provider?: PaymentProviderName
  from?: string
  to?: string
}) {
  const where: Prisma.RechargeRefundWhereInput = {}

  if (query.userId || query.provider) {
    where.rechargeOrder = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
    }
  }

  const createdAtFilter: Prisma.DateTimeFilter = {}
  if (query.from) {
    const parsedFrom = parseAndValidateStrictRefundDate(query.from)
    if (parsedFrom.valid && parsedFrom.date) {
      createdAtFilter.gte = parsedFrom.date
    }
  }
  if (query.to) {
    const parsedTo = parseAndValidateStrictRefundDate(query.to)
    if (parsedTo.valid && parsedTo.date) {
      if (parsedTo.isDateOnly) {
        const nextDay = new Date(parsedTo.date.getTime())
        nextDay.setUTCDate(nextDay.getUTCDate() + 1)
        createdAtFilter.lt = nextDay
      } else {
        createdAtFilter.lte = parsedTo.date
      }
    }
  }
  if (createdAtFilter.gte || createdAtFilter.lt || createdAtFilter.lte) {
    where.createdAt = createdAtFilter
  }

  if (query.status) {
    where.status = query.status
  }

  if (query.orderId) {
    where.rechargeOrderId = query.orderId.trim().toLowerCase()
  }

  const [total, items] = await prisma.$transaction([
    prisma.rechargeRefund.count({ where }),
    prisma.rechargeRefund.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        rechargeOrder: {
          include: {
            credit: true,
          },
        },
        reversal: true,
        paymentAttempt: true,
      },
    }),
  ])

  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: items.map(formatRefundItem),
  }
}

export async function adminGetOrder(orderId: string) {
  const order = await prisma.rechargeOrder.findUnique({
    where: { id: orderId },
    include: {
      credit: true,
      refund: true,
      paymentIntent: { include: { attempts: true } },
      creditTask: true,
      disputes: { include: { recoveryCase: true } },
    },
  })
  if (!order) throw notFound('充值订单不存在')
  const refundCaps = await refundCapabilityByOrderId([order])
  return {
    ...serializeAdminOrder(order),
    supportsRefunds: refundCaps.get(order.id) === true,
    paymentIntent: order.paymentIntent
      ? {
          id: order.paymentIntent.id,
          status: order.paymentIntent.status,
          attempts: order.paymentIntent.attempts.map(attempt => ({
            id: attempt.id,
            status: attempt.status,
            providerPaymentId: attempt.providerPaymentId,
          })),
        }
      : null,
    creditTask: order.creditTask
      ? { id: order.creditTask.id, status: order.creditTask.status, attempts: order.creditTask.attempts }
      : null,
    disputes: order.disputes.map(item => serializeDispute(item)),
  }
}

export async function adminListEvents(query: {
  page: number
  pageSize: number
  status?: PaymentEventStatus
  provider?: PaymentProviderName
}) {
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.provider ? { provider: query.provider } : {}),
  }
  const [total, items] = await prisma.$transaction([
    prisma.paymentEvent.count({ where }),
    prisma.paymentEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        provider: true,
        source: true,
        eventType: true,
        status: true,
        providerPaymentId: true,
        paymentAttemptId: true,
        attempts: true,
        lastErrorCode: true,
        createdAt: true,
        processedAt: true,
      },
    }),
  ])
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: items.map(item => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      processedAt: item.processedAt?.toISOString() ?? null,
    })),
  }
}

export async function adminListReconRuns() {
  const items = await prisma.reconciliationRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { items: true },
  })
  return { items: items.map(serializeRun) }
}

export async function adminListDisputes(query: {
  page: number
  pageSize: number
  status?: PaymentDisputeStatus
}) {
  const where = query.status ? { status: query.status } : {}
  const [total, items] = await prisma.$transaction([
    prisma.paymentDispute.count({ where }),
    prisma.paymentDispute.findMany({
      where,
      orderBy: { openedAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { recoveryCase: true },
    }),
  ])
  return { page: query.page, pageSize: query.pageSize, total, items: items.map(serializeDispute) }
}
