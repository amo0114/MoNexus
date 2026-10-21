import { prisma } from '../../lib/prisma.js'
import { conflict, notFound } from '../../lib/httpError.js'
import { config } from '../../config/index.js'
import { applyConfirmedPayment } from '../payment/events/applyConfirmedPayment.js'
import { applyDisputeObservation, closeRecoveryCase, resolveDisputeOutcome } from '../payment/disputes/service.js'
import { applyRefundObservation, requestRechargeRefund } from './refund.js'
import {
  createReconciliationRun,
  executeReconciliationRun,
  reconcileOrder,
} from '../payment/reconciliation/service.js'
import type { PaymentProviderName, ReconciliationScopeType } from './types.js'
import { writePaymentAdminLog } from '../payment/audit.js'
import { recordNormalizedPaymentFact } from '../payment/observations/record.js'

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
