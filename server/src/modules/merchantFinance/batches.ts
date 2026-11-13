import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { badRequest, HttpError, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { creditInTx, ensureAccountInTx, lockAccountsInTx } from '../wallet/index.js'
import { getSettlementEligibility } from './settlementPolicy.js'

type Tx = Prisma.TransactionClient

export const MAX_SETTLEMENT_BATCH_SIZE = 100

export const settlementCreditKey = (settlementId: number) => `settlement:${settlementId}:credit`

type Candidate = {
  id: number
  status: string
  orderId: number
  merchantId: number
  settlementAmount: number
  order: { status: string }
  merchant: { userId: number; name: string }
}

export type SettlementBlockReason =
  | 'not_found'
  | 'not_pending'
  | 'order_not_payable'
  | 'after_sales_open'
  | 'merchant_recovery_open'

/**
 * Every settleable condition in one place, shared by list badges, preview and
 * the locked re-check inside execute.
 */
async function evaluate(db: Tx | typeof prisma, rows: Candidate[]) {
  const orderIds = rows.map(row => row.orderId)
  const merchantIds = [...new Set(rows.map(row => row.merchantId))]
  const [openAfterSales, openRecoveries] = await Promise.all([
    db.orderAfterSalesCase.findMany({ where: { orderId: { in: orderIds }, status: 'open' }, select: { orderId: true } }),
    db.merchantRecoveryCase.findMany({ where: { merchantId: { in: merchantIds }, status: 'open' }, select: { merchantId: true } }),
  ])
  const afterSalesOrders = new Set(openAfterSales.map(row => row.orderId))
  const recoveringMerchants = new Set(openRecoveries.map(row => row.merchantId))
  return new Map(rows.map(row => {
    const policy = getSettlementEligibility(row.order.status)
    let reason: SettlementBlockReason | null = null
    let message: string | null = null
    if (row.status !== 'pending') { reason = 'not_pending'; message = '结算单不是待结算状态' }
    else if (!policy.payable) { reason = 'order_not_payable'; message = policy.blockReason }
    else if (afterSalesOrders.has(row.orderId)) { reason = 'after_sales_open'; message = '订单有进行中的售后，暂不可结算' }
    else if (recoveringMerchants.has(row.merchantId)) { reason = 'merchant_recovery_open'; message = '商家有未清欠收，暂停自动结算' }
    return [row.id, { payable: reason == null, reason, message }] as const
  }))
}

const candidateSelect = {
  id: true,
  status: true,
  orderId: true,
  merchantId: true,
  settlementAmount: true,
  order: { select: { status: true } },
  merchant: { select: { userId: true, name: true } },
} satisfies Prisma.SettlementSelect

export async function settlementEligibilityFor(rows: Candidate[]) {
  return evaluate(prisma, rows)
}

function normalizeIds(settlementIds: number[]) {
  if (!Array.isArray(settlementIds) || settlementIds.length === 0) {
    throw badRequest('请提供有效的结算单ID列表')
  }
  if (new Set(settlementIds).size !== settlementIds.length) throw badRequest('存在重复的结算ID')
  if (settlementIds.length > MAX_SETTLEMENT_BATCH_SIZE) throw badRequest(`单批最多结算 ${MAX_SETTLEMENT_BATCH_SIZE} 笔`)
  return [...settlementIds].sort((a, b) => a - b)
}

/** No locks and no promise: execute re-checks everything under locks. */
export async function previewSettlementBatch(settlementIds: number[]) {
  const ids = normalizeIds(settlementIds)
  const rows = await prisma.settlement.findMany({ where: { id: { in: ids } }, select: candidateSelect })
  const found = new Map(rows.map(row => [row.id, row]))
  const verdicts = await evaluate(prisma, rows)
  const items = ids.map(id => {
    const row = found.get(id)
    if (!row) return { settlementId: id, payable: false, reason: 'not_found' as const, message: '结算单不存在', amount: 0 }
    const verdict = verdicts.get(id)!
    return {
      settlementId: id,
      orderId: row.orderId,
      merchantId: row.merchantId,
      merchantName: row.merchant.name,
      amount: row.settlementAmount,
      ...verdict,
    }
  })
  return {
    items,
    payableCount: items.filter(item => item.payable).length,
    payableTotal: items.filter(item => item.payable).reduce((sum, item) => sum + item.amount, 0),
  }
}

function batchHash(ids: number[]) {
  return createHash('sha256').update(ids.join(',')).digest('hex')
}

async function serializeBatch(db: Tx | typeof prisma, batchId: number, replayed: boolean) {
  const batch = await db.settlementBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: { items: { orderBy: { settlementId: 'asc' }, include: { settlement: { select: { orderId: true } } } } },
  })
  return {
    batchId: batch.id,
    batchNo: batch.batchNo,
    requestKey: batch.requestKey,
    settled: batch.itemCount,
    creditedTotal: batch.totalPoints,
    createdAt: batch.createdAt,
    replayed,
    items: batch.items.map(item => ({
      settlementId: item.settlementId,
      orderId: item.settlement.orderId,
      merchantId: item.merchantId,
      amount: item.amount,
      destination: item.destination,
      walletOperationId: item.walletOperationId,
    })),
  }
}

/**
 * Admin batch-settle: all-or-nothing. Each item credits the merchant owner's
 * account from a merchant_settlement lot and is recorded with its wallet
 * operation, so a replay returns the same batch instead of paying twice.
 *
 * Lock order: Order (id ASC) -> Settlement (id ASC) -> Merchant (id ASC, the
 * per-merchant barrier shared with recovery cases) -> PointAccount (userId ASC).
 * Only an explicit requestKey replays; an older client without one simply gets
 * the "not settleable" rejection on a repeat, since each settlement pays once.
 */
export async function executeSettlementBatch(adminUserId: number, settlementIds: number[], requestKey?: string) {
  const ids = normalizeIds(settlementIds)
  const hash = batchHash(ids)
  const key = requestKey ?? `auto:${randomUUID()}`

  return prisma.$transaction(async tx => {
    const existing = await tx.settlementBatch.findUnique({ where: { requestKey: key }, select: { id: true, requestHash: true } })
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '该结算请求已用于另一组结算单')
      }
      return serializeBatch(tx, existing.id, true)
    }

    const preliminary = await tx.settlement.findMany({ where: { id: { in: ids } }, select: { orderId: true, merchantId: true } })
    if (preliminary.length !== ids.length) throw badRequest('存在不可结算的记录')
    for (const orderId of [...new Set(preliminary.map(p => p.orderId))].sort((a, b) => a - b)) {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    }
    for (const id of ids) {
      await tx.$queryRaw`SELECT "id" FROM "Settlement" WHERE "id" = ${id} FOR UPDATE`
    }
    for (const merchantId of [...new Set(preliminary.map(p => p.merchantId))].sort((a, b) => a - b)) {
      await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${merchantId} FOR UPDATE`
    }

    const settlements = await tx.settlement.findMany({ where: { id: { in: ids } }, select: candidateSelect, orderBy: { id: 'asc' } })
    const verdicts = await evaluate(tx, settlements)
    const blocked = settlements.filter(row => !verdicts.get(row.id)!.payable)
    if (settlements.length !== ids.length || blocked.length > 0) {
      throw badRequest('存在不可结算的记录', blocked.map(row => ({
        field: `settlementIds.${row.id}`,
        message: verdicts.get(row.id)!.message ?? '不可结算',
      })))
    }

    const merchantUserIds = settlements.map(row => row.merchant.userId)
    for (const userId of [...new Set(merchantUserIds)].sort((a, b) => a - b)) await ensureAccountInTx(tx, userId)
    await lockAccountsInTx(tx, merchantUserIds)

    const totalPoints = settlements.reduce((sum, row) => sum + row.settlementAmount, 0)
    const batch = await tx.settlementBatch.create({
      data: { requestKey: key, requestHash: hash, createdByUserId: adminUserId, itemCount: settlements.length, totalPoints },
    })
    const now = new Date()
    for (const row of settlements) {
      const claimed = await tx.settlement.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'settled', settledAt: now },
      })
      if (claimed.count !== 1) throw badRequest('存在不可结算的记录')
      const credit = row.settlementAmount > 0
        ? await creditInTx(tx, {
          operationKey: settlementCreditKey(row.id),
          userId: row.merchant.userId,
          source: { kind: 'settlement', id: row.id },
          reasonCode: 'merchant_settlement',
          actorUserId: adminUserId,
          // Business income, not earned points: growth eligibility stays false.
          log: { type: 'settlement_in', reason: `商家结算入账: 订单#${row.orderId}`, orderId: row.orderId },
        }, { amount: row.settlementAmount, origin: 'merchant_settlement' })
        : null
      await tx.settlementBatchItem.create({
        data: {
          batchId: batch.id,
          settlementId: row.id,
          merchantId: row.merchantId,
          merchantUserId: row.merchant.userId,
          amount: row.settlementAmount,
          walletOperationId: credit?.operationId ?? null,
        },
      })
    }

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '批量结算',
        targetType: 'settlement',
        detail: `批次 #${batch.id}，结算 ${settlements.length} 笔，入账合计 ${totalPoints} 积分`,
      },
    })
    return serializeBatch(tx, batch.id, false)
  }).catch(error => {
    // A concurrent request with the same key committed first: return its batch.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.settlementBatch.findUnique({ where: { requestKey: key } }).then(row => {
        if (!row || row.requestHash !== hash) throw badRequest('存在不可结算的记录')
        return serializeBatch(prisma, row.id, true)
      })
    }
    throw error
  })
}

export async function listSettlementBatches(page = 1, pageSize = 20) {
  const [total, items] = await prisma.$transaction([
    prisma.settlementBatch.count(),
    prisma.settlementBatch.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return { items, total, page, pageSize }
}

export async function getSettlementBatch(batchId: number) {
  const exists = await prisma.settlementBatch.findUnique({ where: { id: batchId }, select: { id: true } })
  if (!exists) throw notFound('结算批次不存在')
  return serializeBatch(prisma, batchId, false)
}
