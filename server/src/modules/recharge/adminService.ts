import { prisma } from '../../lib/prisma.js'
import { conflict, notFound } from '../../lib/httpError.js'
import { config } from '../../config/index.js'
import { serializeAmountMinor, parseAmountMinorString } from './money.js'
import { applyConfirmedPayment } from '../payment/events/applyConfirmedPayment.js'
import { applyDisputeObservation } from '../payment/disputes/service.js'
import { applyRefundObservation, requestRechargeRefund } from './refund.js'
import {
  createReconciliationRun,
  executeReconciliationRun,
  reconcileOrder,
  serializeRun,
} from '../payment/reconciliation/service.js'
import { closeRecoveryCase, resolveDisputeOutcome, serializeDispute } from '../payment/disputes/service.js'
import type {
  PaymentDisputeStatus,
  PaymentEventStatus,
  PaymentProviderName,
  RechargeOrderStatus,
  ReconciliationScopeType,
} from './types.js'
import { writePaymentAdminLog } from '../payment/audit.js'
import { recordNormalizedPaymentFact } from '../payment/observations/record.js'

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
}) {
  return {
    orderId: order.id,
    userId: order.userId,
    status: order.status,
    currency: order.currency,
    amountMinor: serializeAmountMinor(order.amountMinor),
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
      include: { credit: true, refund: true },
    }),
  ])
  return { page: query.page, pageSize: query.pageSize, total, items: items.map(serializeAdminOrder) }
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
  return {
    ...serializeAdminOrder(order),
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

export async function adminRetryEvent(eventId: string, actorUserId: number) {
  const event = await prisma.paymentEvent.findUnique({ where: { id: eventId } })
  if (!event) throw notFound('支付事件不存在')
  await writePaymentAdminLog({
    adminUserId: actorUserId,
    action: 'payment.event.retry',
    targetType: 'PaymentEvent',
    targetKey: eventId,
    extra: { provider: event.provider, source: event.source },
  })
  await prisma.paymentEvent.update({
    where: { id: eventId },
    data: {
      status: 'received',
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: new Date(),
      lastErrorCode: null,
    },
  })
  if (event.eventType.startsWith('dispute.')) {
    return applyDisputeObservation(eventId)
  }
  if (event.eventType.startsWith('refund.')) {
    return applyRefundObservation(eventId)
  }
  return applyConfirmedPayment(eventId)
}

export async function adminReconcileOrder(orderId: string, actorUserId: number) {
  await writePaymentAdminLog({
    adminUserId: actorUserId,
    action: 'payment.order.reconcile',
    targetType: 'RechargeOrder',
    targetKey: orderId,
  })
  return reconcileOrder(orderId)
}

export async function adminRequestRefund(orderId: string, actorUserId: number, reasonCode?: string) {
  const order = await prisma.rechargeOrder.findUnique({ where: { id: orderId } })
  if (!order) throw notFound('充值订单不存在')
  const { randomUUID } = await import('node:crypto')
  await writePaymentAdminLog({
    adminUserId: actorUserId,
    action: 'payment.order.refund',
    targetType: 'RechargeOrder',
    targetKey: orderId,
    extra: { reasonCode: reasonCode ?? 'admin_requested' },
  })
  return requestRechargeRefund({
    userId: order.userId,
    orderId,
    idempotencyKey: randomUUID(),
    createdByUserId: actorUserId,
    reasonCode: reasonCode ?? 'admin_requested',
  })
}

/**
 * Confirm an administrator's own sandbox order through the normal payment
 * observation and credit pipeline. The /api/admin parent router supplies the
 * current admin-role and MFA boundary; this service keeps the ledger and mode
 * invariants fail-closed as defense in depth.
 */
export async function adminConfirmSandboxOrder(orderId: string, actorUserId: number) {
  if (config.recharge.mode !== 'admin_sandbox' || !config.recharge.adminSandboxEnabled) {
    throw conflict('管理员沙箱支付未启用')
  }

  const order = await prisma.rechargeOrder.findUnique({
    where: { id: orderId },
    include: {
      paymentIntent: { include: { attempts: { orderBy: { createdAt: 'asc' } } } },
    },
  })
  if (!order) throw notFound('充值订单不存在')
  if (!order.adminSandbox
    || order.userId !== actorUserId
    || order.currency !== 'CNY'
    || order.provider !== 'simulator'
    || order.paymentMethod !== 'card') {
    throw conflict('该订单不是当前管理员自己的沙箱订单')
  }

  const intent = order.paymentIntent
  const attempt = intent?.attempts.find(item => item.id === intent.activeAttemptId)
    ?? intent?.attempts.at(-1)
  if (!intent || !attempt?.providerPaymentId) {
    throw conflict('沙箱订单尚未完成支付初始化')
  }
  const isPending = order.status === 'pending_payment' && attempt.status === 'processing'
  const isIdempotentReplay = ['paid', 'credited'].includes(order.status) && attempt.status === 'succeeded'
  if (!isPending && !isIdempotentReplay) {
    throw conflict('沙箱订单当前状态不能确认成功')
  }

  const providerCaptureId = `admin_sandbox:${attempt.id}`
  const observation = await recordNormalizedPaymentFact({
    source: 'provider_complete',
    provider: 'simulator',
    providerAccountKey: order.providerAccountKey,
    paymentAttemptId: attempt.id,
    eventType: 'payment.admin_sandbox_succeeded',
    payment: {
      status: 'succeeded',
      providerPaymentId: attempt.providerPaymentId,
      providerCaptureId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      immutableStateVersion: `admin-sandbox-confirm:v1:${order.id}`,
    },
  })
  const result = await applyConfirmedPayment(observation.id)
  const [credit, account] = await Promise.all([
    prisma.rechargeCredit.findUnique({
      where: { rechargeOrderId: order.id },
      select: { adminSandbox: true },
    }),
    prisma.pointAccount.findUnique({
      where: { userId: actorUserId },
      select: { sandboxBalance: true },
    }),
  ])
  if (!credit?.adminSandbox || !account) {
    throw conflict('沙箱入账尚未完成，请重试')
  }
  await writePaymentAdminLog({
    adminUserId: actorUserId,
    action: 'payment.admin_sandbox.confirm',
    targetType: 'RechargeOrder',
    targetKey: order.id,
    extra: { observationId: observation.id, provider: 'simulator' },
  })
  return {
    orderId: order.id,
    observationId: observation.id,
    result: result.outcome,
    sandboxBalance: account.sandboxBalance,
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

export async function adminCreateReconRun(input: {
  provider: PaymentProviderName
  providerAccountKey?: string
  scopeType: ReconciliationScopeType
  scopeKey?: string
  createdByUserId: number
}) {
  const run = await createReconciliationRun({
    provider: input.provider,
    providerAccountKey: input.providerAccountKey,
    scopeType: input.scopeType,
    scopeKey: input.scopeKey,
    createdByUserId: input.createdByUserId,
  })
  await writePaymentAdminLog({
    adminUserId: input.createdByUserId,
    action: 'payment.recon.create',
    targetType: 'ReconciliationRun',
    targetKey: run.id,
    extra: { provider: input.provider, scopeType: input.scopeType },
  })
  return run
}

export async function adminRerunRecon(runId: string, actorUserId: number) {
  await writePaymentAdminLog({
    adminUserId: actorUserId,
    action: 'payment.recon.rerun',
    targetType: 'ReconciliationRun',
    targetKey: runId,
  })
  return executeReconciliationRun(runId)
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

export async function adminResolveDispute(
  disputeId: string,
  outcome: 'won' | 'lost',
  actorUserId: number,
) {
  const result = await resolveDisputeOutcome({ disputeId, outcome, actorUserId })
  await writePaymentAdminLog({
    adminUserId: actorUserId,
    action: 'payment.dispute.resolve',
    targetType: 'PaymentDispute',
    targetKey: disputeId,
    extra: { outcome },
  })
  return result
}

export async function adminCloseRecoveryCase(
  recoveryCaseId: string,
  status: 'recovered' | 'written_off' | 'restored',
  actorUserId: number,
  resolutionReason?: string,
) {
  const result = await closeRecoveryCase({
    recoveryCaseId,
    status,
    actorUserId,
    resolutionReason,
  })
  await writePaymentAdminLog({
    adminUserId: actorUserId,
    action: 'payment.recovery_case.close',
    targetType: 'PaymentRecoveryCase',
    targetKey: recoveryCaseId,
    extra: { status, resolutionReason: resolutionReason ?? status },
  })
  return result
}

export async function adminPatchPricePolicy(id: string, body: {
  minAmountMinor?: string
  maxAmountMinor?: string
  amountStepMinor?: string
  dailyLimitMinor?: string
  monthlyLimitMinor?: string
  status?: string
}, actorUserId: number) {
  const current = await prisma.rechargePricePolicy.findUnique({ where: { id } })
  if (!current) throw notFound('价格政策不存在')
  if (current.status === 'retired') throw conflict('已退役的价格政策不能修改')
  const data: Record<string, bigint | string> = {}
  if (body.minAmountMinor) data.minAmountMinor = parseAmountMinorString(body.minAmountMinor)
  if (body.maxAmountMinor) data.maxAmountMinor = parseAmountMinorString(body.maxAmountMinor)
  if (body.amountStepMinor) data.amountStepMinor = parseAmountMinorString(body.amountStepMinor)
  if (body.dailyLimitMinor) data.dailyLimitMinor = parseAmountMinorString(body.dailyLimitMinor)
  if (body.monthlyLimitMinor) data.monthlyLimitMinor = parseAmountMinorString(body.monthlyLimitMinor)
  if (body.status === 'draft' || body.status === 'retired') data.status = body.status
  const updated = await prisma.rechargePricePolicy.update({ where: { id }, data })
  await prisma.adminLog.create({
    data: {
      adminUserId: actorUserId,
      action: 'recharge.price_policy.patch',
      targetType: 'RechargePricePolicy',
      detail: JSON.stringify({ policyId: id, fields: Object.keys(data) }),
    },
  })
  return serializePolicy(updated)
}

export async function adminActivatePricePolicy(id: string, actorUserId: number) {
  return prisma.$transaction(async tx => {
    const policy = await tx.rechargePricePolicy.findUnique({ where: { id } })
    if (!policy) throw notFound('价格政策不存在')
    if (policy.status === 'active') return serializePolicy(policy)
    await tx.rechargePricePolicy.updateMany({
      where: {
        currency: policy.currency,
        adminSandbox: policy.adminSandbox,
        status: 'active',
        id: { not: id },
      },
      data: { status: 'retired' },
    })
    const updated = await tx.rechargePricePolicy.update({
      where: { id },
      data: { status: 'active', effectiveAt: new Date() },
    })
    await tx.adminLog.create({
      data: {
        adminUserId: actorUserId,
        action: 'recharge.price_policy.activate',
        targetType: 'RechargePricePolicy',
        detail: JSON.stringify({ policyId: id, currency: policy.currency }),
      },
    })
    return serializePolicy(updated)
  })
}

function serializePolicy(row: {
  id: string
  code: string
  version: number
  currency: string
  adminSandbox: boolean
  status: string
  minAmountMinor: bigint
  maxAmountMinor: bigint
  amountStepMinor: bigint
  dailyLimitMinor: bigint
  monthlyLimitMinor: bigint
  effectiveAt: Date
}) {
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    currency: row.currency,
    adminSandbox: row.adminSandbox,
    status: row.status,
    minAmountMinor: serializeAmountMinor(row.minAmountMinor),
    maxAmountMinor: serializeAmountMinor(row.maxAmountMinor),
    amountStepMinor: serializeAmountMinor(row.amountStepMinor),
    dailyLimitMinor: serializeAmountMinor(row.dailyLimitMinor),
    monthlyLimitMinor: serializeAmountMinor(row.monthlyLimitMinor),
    effectiveAt: row.effectiveAt.toISOString(),
  }
}
