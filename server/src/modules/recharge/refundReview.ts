import { writeOpenReconItem } from '../payment/events/applyConfirmedPayment.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import {
  availablePointsIn,
  findOperationByKey,
  lockAccountsInTx,
  reserveInTx,
} from '../wallet/index.js'
import { rechargeCreditWalletKey } from './credit.js'
import { refundWalletCtx, providerSupportsRefunds } from './refund.js'
import { assertPermission } from '../adminAuthorization/service.js'
import { governanceConflict, requestHash, writeGovernanceAudit } from '../governance/common.js'
import { z } from 'zod'
import { reasonInput } from '../governance/common.js'

export const reviewInput = reasonInput
  .extend({
    action: z.enum(['resume', 'reject']),
    expectedReviewVersion: z.number().int().nonnegative(),
    evidenceRef: z.string().max(500).nullable().optional(),
  })
  .strict()
async function facts(db: Prisma.TransactionClient, id: string) {
  const refund = await db.rechargeRefund.findUnique({
    where: { id },
    include: {
      rechargeOrder: { include: { credit: true } },
      paymentAttempt: true,
      reversal: true,
      reviewActions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!refund) throw notFound('退款不存在')
  const order = refund.rechargeOrder
  const [source, dispute, hold, recon] = await Promise.all([
    findOperationByKey(db, rechargeCreditWalletKey(order.id)),
    db.paymentDispute.findFirst({ where: { rechargeOrderId: order.id, status: { not: 'won' } } }),
    db.pointHold.findUnique({
      where: { sourceType_sourceId: { sourceType: 'recharge_refund', sourceId: id } },
    }),
    db.reconciliationItem.findFirst({
      where: {
        status: 'open',
        OR: [
          { rechargeOrderId: order.id },
          { paymentAttempt: { paymentIntent: { rechargeOrderId: order.id } } },
        ],
      },
      select: { id: true },
    }),
  ])
  const available = source
    ? await availablePointsIn(db, order.userId, { onlySourceOperationIds: [source.id] })
    : 0
  const blockers: Array<{ code: string; message: string }> = []
  if (!source) blockers.push({ code: 'LEGACY_SOURCE_UNPROVEN', message: '无法证明历史原充值来源' })
  if (source && BigInt(available) < refund.pointsToReverse)
    blockers.push({ code: 'REFUND_SOURCE_INSUFFICIENT', message: '原充值来源积分不足' })
  if (
    order.adminSandbox ||
    order.status !== 'credited' ||
    !order.credit ||
    order.credit.reversedAt ||
    order.credit.points !== refund.pointsToReverse ||
    recon ||
    dispute ||
    refund.reversal ||
    !refund.paymentAttempt.providerPaymentId ||
    refund.providerRefundId ||
    hold ||
    refund.amountMinor !== order.amountMinor ||
    refund.pointsToReverse !== order.totalPoints ||
    refund.paymentAttempt.status !== 'succeeded'
  )
    blockers.push({
      code: 'RECONCILIATION_REQUIRED',
      message: '支付、信用、争议或冻结事实需要核对',
    })
  return { refund, order, source, available, blockers, hold }
}
async function detail(db: Prisma.TransactionClient, id: string, canReview: boolean) {
  const { refund: r, order, source, available, blockers } = await facts(db, id)
  const reconciliation = blockers.some((b) => b.code === 'RECONCILIATION_REQUIRED')
  return {
    id: r.id,
    rechargeOrderId: r.rechargeOrderId,
    userId: order.userId,
    status: r.status,
    amountMinor: String(r.amountMinor),
    currency: order.currency,
    pointsToReverse: String(r.pointsToReverse),
    reasonCode: r.reasonCode,
    reviewVersion: r.reviewVersion,
    qualification: {
      sourceKind: source ? 'recharge' : 'legacy_unknown',
      requiredPoints: String(r.pointsToReverse),
      availablePoints: String(available),
      asOf: new Date().toISOString(),
    },
    allowedActions:
      canReview && r.status === 'manual_review' && !reconciliation
        ? blockers.length
          ? ['reject']
          : ['resume', 'reject']
        : [],
    blockers: r.status === 'manual_review' ? blockers : [],
    history: r.reviewActions.map(({ requestKey, requestHash, ...a }) => a),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}
export async function getRefundReview(actor: number, id: string) {
  const auth = await assertPermission(actor, 'payments.read')
  return detail(prisma, id, auth.permissions.includes('payments.refunds.review'))
}
export async function reviewRefund(
  actor: number,
  id: string,
  key: string,
  input: z.infer<typeof reviewInput>,
) {
  await assertPermission(actor, 'payments.refunds.review')
  const digest = requestHash({ actor, id, ...input })
  // Capability discovery may touch provider configuration. Keep it outside all money locks.
  const pointer = await prisma.rechargeRefund.findUnique({
    where: { id },
    include: { rechargeOrder: true },
  })
  if (!pointer) throw notFound('退款不存在')
  const supportsRefunds =
    input.action === 'resume' ? await providerSupportsRefunds(pointer.rechargeOrder) : true
  const result = await prisma.$transaction(
    async (tx) => {
      await assertPermission(actor, 'payments.refunds.review', tx)
      await tx.$queryRaw`SELECT id FROM "RechargeOrder" WHERE id=${pointer.rechargeOrderId}::uuid FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "RechargeRefund" WHERE id=${id}::uuid FOR UPDATE`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund-review:${key}`}, 0))`
      const prior = await tx.rechargeRefundReviewAction.findUnique({ where: { requestKey: key } })
      if (prior) {
        if (prior.requestHash !== digest)
          throw governanceConflict('IDEMPOTENCY_KEY_REUSED', '幂等键已经用于另一项决定')
        const { requestKey, requestHash, ...action } = prior
        return { refund: await detail(tx, id, true), reviewAction: action, replayed: true }
      }
      await lockAccountsInTx(tx, [pointer.rechargeOrder.userId])
      const f = await facts(tx, id)
      if (
        f.refund.status !== 'manual_review' ||
        f.refund.reviewVersion !== input.expectedReviewVersion
      )
        throw governanceConflict('STATE_CONFLICT', '退款状态或审核版本已经变化')
      if (
        f.blockers.some((b) => b.code === 'RECONCILIATION_REQUIRED') ||
        (input.action === 'resume' && !supportsRefunds)
      ) {
        await writeOpenReconItem(tx, {
          scopePrefix: 'refund-review',
          mismatchType: 'refund_mismatch',
          orderId: f.order.id,
          attemptId: f.refund.paymentAttemptId,
          provider: f.refund.paymentAttempt.provider,
          providerAccountKey: f.refund.paymentAttempt.providerAccountKey,
          providerEntryKey: `manual:${id}`,
          localStatus: f.refund.status,
          localAmountMinor: f.refund.amountMinor,
          quotedAmountMinor: f.order.amountMinor,
          currency: f.order.currency,
        })
        return { reconciliation: true as const }
      }
      if (input.action === 'resume') {
        if (!supportsRefunds)
          throw governanceConflict('RECONCILIATION_REQUIRED', '原渠道当前不支持退款')
        if (!f.source) throw governanceConflict('LEGACY_SOURCE_UNPROVEN', '无法证明历史原充值来源')
        if (BigInt(f.available) < f.refund.pointsToReverse)
          throw governanceConflict('REFUND_SOURCE_INSUFFICIENT', '原充值来源积分不足')
        const amount = Number(f.refund.pointsToReverse)
        if (!Number.isSafeInteger(amount) || amount <= 0)
          throw governanceConflict('RECONCILIATION_REQUIRED', '退款积分不合法')
        await reserveInTx(tx, refundWalletCtx(f.order, id, '人工恢复充值退款冻结'), {
          amount,
          onlySourceOperationIds: [f.source.id],
        })
        await tx.pointHold.create({
          data: {
            userId: f.order.userId,
            sourceType: 'recharge_refund',
            sourceId: id,
            points: f.refund.pointsToReverse,
            status: 'active',
          },
        })
      }
      const toStatus = input.action === 'resume' ? 'points_held' : 'cancelled'
      await tx.rechargeRefund.update({
        where: { id, status: 'manual_review', reviewVersion: input.expectedReviewVersion },
        data: {
          status: toStatus,
          reviewVersion: { increment: 1 },
          reviewedByUserId: actor,
          reviewedAt: new Date(),
          reviewDecisionCode: input.reasonCode,
          reviewNote: input.note,
          ...(input.action === 'reject' ? { completedAt: new Date() } : {}),
        },
      })
      const {
        requestKey,
        requestHash: hash,
        ...action
      } = await tx.rechargeRefundReviewAction.create({
        data: {
          refundId: id,
          kind: input.action,
          requestKey: key,
          requestHash: digest,
          expectedReviewVersion: input.expectedReviewVersion,
          actorUserId: actor,
          reasonCode: input.reasonCode,
          note: input.note,
          evidenceRef: input.evidenceRef,
          fromStatus: 'manual_review',
          toStatus,
        },
      })
      await writeGovernanceAudit(
        tx,
        actor,
        `recharge.refund.${input.action}`,
        'recharge_refund',
        null,
        { reasonCode: input.reasonCode, note: input.note, fromStatus: 'manual_review', toStatus },
      )
      return { refund: await detail(tx, id, true), reviewAction: action, replayed: false }
    },
    { timeout: 15000 },
  )
  if ('reconciliation' in result)
    throw governanceConflict('RECONCILIATION_REQUIRED', '退款事实已转对账，不能覆盖')
  return result
}
