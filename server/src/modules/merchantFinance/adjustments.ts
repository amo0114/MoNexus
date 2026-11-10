import { Prisma } from '@prisma/client'
import { badRequest, conflict, HttpError, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { findOperationByKey, lockAccountsInTx, spendInTx } from '../wallet/index.js'
import { settlementCreditKey } from './batches.js'

type Tx = Prisma.TransactionClient

/**
 * Reverse a settled earning for a full after-sales refund. Caller (orders
 * after-sales) holds Order -> case -> Settlement locks; this takes Merchant and
 * then the merchant account. The adjustment never rewrites Settlement amounts.
 *
 * Clawback uses only available merchant_settlement points (this order's lot
 * first): never frozen points, recharge, reward or legacy_unknown. What cannot
 * be taken becomes a MerchantRecoveryCase, which blocks that merchant's later
 * settlements; it never fails the buyer refund.
 */
export async function reverseForAfterSalesInTx(tx: Tx, input: {
  settlementId: number
  afterSalesCaseId: number
  actorUserId: number
  reason: string
}) {
  const settlement = await tx.settlement.findUniqueOrThrow({
    where: { id: input.settlementId },
    include: { merchant: { select: { id: true, userId: true } } },
  })
  if (settlement.status !== 'settled') throw conflict('结算单未入账，不需要冲正')
  await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${settlement.merchantId} FOR UPDATE`
  await lockAccountsInTx(tx, [settlement.merchant.userId])

  const creditOp = await findOperationByKey(tx, settlementCreditKey(settlement.id))
  const due = settlement.settlementAmount
  const clawback = due > 0
    ? await spendInTx(tx, {
      operationKey: `after-sales:${input.afterSalesCaseId}:clawback`,
      userId: settlement.merchant.userId,
      source: { kind: 'after_sales', id: input.afterSalesCaseId },
      reasonCode: 'settlement_reversal',
      actorUserId: input.actorUserId,
      log: { type: 'out', reason: `售后冲正扣回: 订单#${settlement.orderId}`, orderId: settlement.orderId },
    }, {
      amount: due,
      origins: ['merchant_settlement'],
      preferSourceOperationIds: creditOp ? [creditOp.id] : [],
      allowPartial: true,
    })
    : null
  const collected = clawback?.amount ?? 0

  const adjustment = await tx.settlementAdjustment.create({
    data: {
      settlementId: settlement.id,
      afterSalesCaseId: input.afterSalesCaseId,
      merchantId: settlement.merchantId,
      orderAmountDelta: -settlement.orderAmount,
      commissionDelta: -settlement.commissionAmount,
      settlementDelta: -due,
      clawbackPoints: collected,
      clawbackOperationId: clawback?.operationId ?? null,
      reason: input.reason,
      createdByUserId: input.actorUserId,
    },
  })
  const recovery = due - collected > 0
    ? await tx.merchantRecoveryCase.create({
      data: { adjustmentId: adjustment.id, merchantId: settlement.merchantId, amountDue: due - collected },
    })
    : null
  return { adjustmentId: adjustment.id, clawbackPoints: collected, recoveryCaseId: recovery?.id ?? null, shortfall: due - collected }
}

export type RecoveryActionKind = 'wallet_clawback' | 'offline_received' | 'waived'

/**
 * One evidenced action on a merchant recovery case. Lock order: Merchant ->
 * case -> merchant account; never reaches back to Order/Settlement.
 * Offline receipt closes the receivable without touching any wallet; a waiver
 * records the platform absorbing the loss, not a merchant repayment.
 */
export async function applyRecoveryAction(input: {
  caseId: number
  kind: RecoveryActionKind
  amount: number
  requestKey: string
  evidence?: string
  note?: string
  actorUserId: number
}) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw badRequest('金额不合法')
  if (input.kind !== 'wallet_clawback' && !input.evidence?.trim()) throw badRequest('线下收讫或豁免必须填写凭证')

  return prisma.$transaction(async tx => {
    const target = await tx.merchantRecoveryCase.findUnique({ where: { id: input.caseId }, select: { merchantId: true } })
    if (!target) throw notFound('欠收案件不存在')
    await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${target.merchantId} FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "MerchantRecoveryCase" WHERE "id" = ${input.caseId} FOR UPDATE`

    const replay = await tx.merchantRecoveryAction.findUnique({ where: { requestKey: input.requestKey } })
    if (replay) {
      if (replay.caseId !== input.caseId || replay.kind !== input.kind || replay.amount !== input.amount) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '该请求已用于另一项处理')
      }
      return serializeRecoveryCase(tx, input.caseId)
    }

    const recovery = await tx.merchantRecoveryCase.findUniqueOrThrow({
      where: { id: input.caseId },
      include: { adjustment: { select: { settlementId: true, settlement: { select: { orderId: true } } } } },
    })
    if (recovery.status !== 'open') throw conflict('欠收案件已结清')
    const remaining = recovery.amountDue - recovery.amountCollected - recovery.amountWaived
    if (input.amount > remaining) throw conflict(`金额超过未收部分（${remaining}）`)

    let walletOperationId: number | null = null
    if (input.kind === 'wallet_clawback') {
      const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: recovery.merchantId }, select: { userId: true } })
      await lockAccountsInTx(tx, [merchant.userId])
      const spent = await spendInTx(tx, {
        operationKey: `merchant-recovery:${recovery.id}:${input.requestKey}`,
        userId: merchant.userId,
        source: { kind: 'merchant_recovery', id: recovery.id },
        reasonCode: 'merchant_recovery',
        actorUserId: input.actorUserId,
        log: { type: 'out', reason: `商家欠收追回: 订单#${recovery.adjustment.settlement.orderId}`, orderId: recovery.adjustment.settlement.orderId },
      }, { amount: input.amount, origins: ['merchant_settlement'], allowPartial: true })
      if (!spent || spent.amount !== input.amount) {
        throw conflict(`商家可追回的结算积分不足（可用 ${spent?.amount ?? 0}）`)
      }
      walletOperationId = spent.operationId
    }

    await tx.merchantRecoveryAction.create({
      data: {
        caseId: recovery.id,
        kind: input.kind,
        amount: input.amount,
        requestKey: input.requestKey,
        walletOperationId,
        evidence: input.evidence?.trim() || null,
        note: input.note?.trim() || null,
        actorUserId: input.actorUserId,
      },
    })
    const collected = recovery.amountCollected + (input.kind === 'waived' ? 0 : input.amount)
    const waived = recovery.amountWaived + (input.kind === 'waived' ? input.amount : 0)
    const closed = collected + waived === recovery.amountDue
    await tx.merchantRecoveryCase.update({
      where: { id: recovery.id },
      data: { amountCollected: collected, amountWaived: waived, status: closed ? 'closed' : 'open', closedAt: closed ? new Date() : null },
    })
    await tx.adminLog.create({
      data: {
        adminUserId: input.actorUserId,
        action: '商家欠收处理',
        targetType: 'merchant_recovery_case',
        targetId: recovery.id,
        detail: `${input.kind} ${input.amount} 积分`,
      },
    })
    return serializeRecoveryCase(tx, recovery.id)
  })
}

export async function serializeRecoveryCase(db: Tx | typeof prisma, caseId: number) {
  const row = await db.merchantRecoveryCase.findUnique({
    where: { id: caseId },
    include: {
      actions: { orderBy: { createdAt: 'asc' } },
      adjustment: { select: { settlementId: true, afterSalesCaseId: true, settlement: { select: { orderId: true } } } },
    },
  })
  if (!row) throw notFound('欠收案件不存在')
  const outstanding = row.amountDue - row.amountCollected - row.amountWaived
  return {
    id: row.id,
    merchantId: row.merchantId,
    orderId: row.adjustment.settlement.orderId,
    settlementId: row.adjustment.settlementId,
    afterSalesCaseId: row.adjustment.afterSalesCaseId,
    amountDue: row.amountDue,
    amountCollected: row.amountCollected,
    amountWaived: row.amountWaived,
    outstanding,
    status: row.status,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    allowedActions: row.status === 'open' ? (['wallet_clawback', 'offline_received', 'waived'] as RecoveryActionKind[]) : [],
    actions: row.actions.map(action => ({
      id: action.id,
      kind: action.kind,
      amount: action.amount,
      evidence: action.evidence,
      note: action.note,
      walletOperationId: action.walletOperationId,
      createdAt: action.createdAt,
    })),
  }
}

export async function listRecoveryCases(query: { merchantId?: number; status?: string; page?: number; pageSize?: number }) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where: Prisma.MerchantRecoveryCaseWhereInput = {
    ...(query.merchantId ? { merchantId: query.merchantId } : {}),
    ...(query.status ? { status: query.status } : {}),
  }
  const [total, rows] = await prisma.$transaction([
    prisma.merchantRecoveryCase.count({ where }),
    prisma.merchantRecoveryCase.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  const items = await Promise.all(rows.map(row => serializeRecoveryCase(prisma, row.id)))
  return { items, total, page, pageSize }
}
