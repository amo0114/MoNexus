import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, notFound } from '../../lib/httpError.js'
import { config } from '../../config/index.js'
import { getIsoCurrencyMetadata, serializeAmountMinor, parseAmountMinorString } from './money.js'
import { applyConfirmedPayment } from '../payment/events/applyConfirmedPayment.js'
import { applyDisputeObservation } from '../payment/disputes/service.js'
import { applyRefundObservation, providerSupportsRefunds, requestRechargeRefund } from './refund.js'
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
  RechargeCurrency,
  RechargeOrderStatus,
  RechargePricePolicyStatus,
  ReconciliationScopeType,
} from './types.js'
import type { AdminCreatePricePolicyBody } from './adminSchema.js'
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

type PolicyWithSuggested = Prisma.RechargePricePolicyGetPayload<{
  include: { suggestedAmounts: true }
}>

function policyInclude() {
  return { suggestedAmounts: { orderBy: { sortOrder: 'asc' as const } } }
}

export async function adminListPricePolicies(query: {
  page: number
  pageSize: number
  currency?: RechargeCurrency
  status?: RechargePricePolicyStatus
  adminSandbox?: boolean
}) {
  const where = {
    ...(query.currency ? { currency: query.currency } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.adminSandbox === undefined ? {} : { adminSandbox: query.adminSandbox }),
  }
  const [total, items] = await prisma.$transaction([
    prisma.rechargePricePolicy.count({ where }),
    prisma.rechargePricePolicy.findMany({
      where,
      orderBy: [{ currency: 'asc' }, { adminSandbox: 'asc' }, { version: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: policyInclude(),
    }),
  ])
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: items.map(serializePolicy),
  }
}

export async function adminCreatePricePolicy(body: AdminCreatePricePolicyBody, actorUserId: number) {
  const minAmountMinor = parseAmountMinorString(body.minAmountMinor)
  const maxAmountMinor = parseAmountMinorString(body.maxAmountMinor)
  const amountStepMinor = parseAmountMinorString(body.amountStepMinor)
  const dailyLimitMinor = parseAmountMinorString(body.dailyLimitMinor)
  const monthlyLimitMinor = parseAmountMinorString(body.monthlyLimitMinor)
  const pointsNumerator = parseAmountMinorString(body.pointsNumerator)
  const pointsDenominator = parseAmountMinorString(body.pointsDenominator)
  const iso = getIsoCurrencyMetadata(body.currency)
  if (body.currencyScale !== iso.scale) {
    throw badRequest(`currencyScale 必须与 ${body.currency} 的 ISO 精度 ${iso.scale} 一致`)
  }
  if (minAmountMinor > maxAmountMinor) {
    throw badRequest('最低金额不能高于最高金额')
  }
  if (dailyLimitMinor < maxAmountMinor) {
    throw badRequest('日限额不能低于最高金额')
  }
  if (monthlyLimitMinor < dailyLimitMinor) {
    throw badRequest('月限额不能低于日限额')
  }

  const suggested = body.suggestedAmounts.map(item => ({
    amountMinor: parseAmountMinorString(item.amountMinor),
    sortOrder: item.sortOrder,
  }))
  const seenAmounts = new Set<string>()
  const seenOrders = new Set<number>()
  for (const item of suggested) {
    const key = serializeAmountMinor(item.amountMinor)
    if (seenAmounts.has(key)) throw badRequest('推荐金额不能重复')
    if (seenOrders.has(item.sortOrder)) throw badRequest('推荐金额排序不能重复')
    seenAmounts.add(key)
    seenOrders.add(item.sortOrder)
    if (item.amountMinor < minAmountMinor || item.amountMinor > maxAmountMinor) {
      throw badRequest('推荐金额必须在最低和最高金额之间')
    }
    if (amountStepMinor > 0n && item.amountMinor % amountStepMinor !== 0n) {
      throw badRequest('推荐金额必须符合金额步进')
    }
  }

  const adminSandbox = body.adminSandbox === true
  try {
    return await prisma.$transaction(async tx => {
      const existing = await tx.rechargePricePolicy.findUnique({ where: { code: body.code } })
      if (existing) throw conflict('价格政策代码已存在')
      const latest = await tx.rechargePricePolicy.aggregate({
        where: { currency: body.currency, adminSandbox },
        _max: { version: true },
      })
      const created = await tx.rechargePricePolicy.create({
        data: {
          code: body.code,
          version: (latest._max.version ?? 0) + 1,
          currency: body.currency,
          adminSandbox,
          currencyScale: body.currencyScale,
          pointsNumerator,
          pointsDenominator,
          roundingMode: body.roundingMode,
          minAmountMinor,
          maxAmountMinor,
          amountStepMinor,
          dailyLimitMinor,
          monthlyLimitMinor,
          limitTimeZone: body.limitTimeZone,
          bonusRuleVersion: body.bonusRuleVersion ?? null,
          status: 'draft',
          effectiveAt: new Date(),
          suggestedAmounts: { create: suggested },
        },
        include: policyInclude(),
      })
      await tx.adminLog.create({
        data: {
          adminUserId: actorUserId,
          action: 'recharge.price_policy.create',
          targetType: 'RechargePricePolicy',
          detail: JSON.stringify({
            policyId: created.id,
            code: created.code,
            currency: created.currency,
            adminSandbox,
            status: 'draft',
          }),
        },
      })
      return serializePolicy(created)
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('价格政策代码或版本已存在')
    }
    throw err
  }
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
  await prisma.rechargePricePolicy.update({ where: { id }, data })
  await prisma.adminLog.create({
    data: {
      adminUserId: actorUserId,
      action: 'recharge.price_policy.patch',
      targetType: 'RechargePricePolicy',
      detail: JSON.stringify({ policyId: id, fields: Object.keys(data) }),
    },
  })
  return serializePolicy(await loadPolicy(id))
}

export async function adminActivatePricePolicy(id: string, actorUserId: number) {
  return prisma.$transaction(async tx => {
    const policy = await tx.rechargePricePolicy.findUnique({
      where: { id },
      include: policyInclude(),
    })
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
      include: policyInclude(),
    })
    await tx.adminLog.create({
      data: {
        adminUserId: actorUserId,
        action: 'recharge.price_policy.activate',
        targetType: 'RechargePricePolicy',
        detail: JSON.stringify({
          policyId: id,
          code: policy.code,
          currency: policy.currency,
          adminSandbox: policy.adminSandbox,
        }),
      },
    })
    return serializePolicy(updated)
  })
}

async function loadPolicy(id: string): Promise<PolicyWithSuggested> {
  const row = await prisma.rechargePricePolicy.findUnique({
    where: { id },
    include: policyInclude(),
  })
  if (!row) throw notFound('价格政策不存在')
  return row
}

function serializePolicy(row: PolicyWithSuggested) {
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    currency: row.currency,
    adminSandbox: row.adminSandbox,
    status: row.status,
    currencyScale: row.currencyScale,
    pointsNumerator: serializeAmountMinor(row.pointsNumerator),
    pointsDenominator: serializeAmountMinor(row.pointsDenominator),
    roundingMode: row.roundingMode,
    minAmountMinor: serializeAmountMinor(row.minAmountMinor),
    maxAmountMinor: serializeAmountMinor(row.maxAmountMinor),
    amountStepMinor: serializeAmountMinor(row.amountStepMinor),
    dailyLimitMinor: serializeAmountMinor(row.dailyLimitMinor),
    monthlyLimitMinor: serializeAmountMinor(row.monthlyLimitMinor),
    limitTimeZone: row.limitTimeZone,
    bonusRuleVersion: row.bonusRuleVersion,
    suggestedAmounts: row.suggestedAmounts.map(item => ({
      amountMinor: serializeAmountMinor(item.amountMinor),
      sortOrder: item.sortOrder,
    })),
    effectiveAt: row.effectiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}
