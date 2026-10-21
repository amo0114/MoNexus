import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/httpError.js'
import { creditAvailablePoints } from '../orders/accounting.js'
import { getSettlementEligibility } from '../orders/settlementPolicy.js'

// ---- Settlements ----

export async function listAllSettlements(status?: string, page = 1, pageSize = 20) {
  const where: Prisma.SettlementWhereInput = {}
  if (status) where.status = status

  const [total, rawItems] = await prisma.$transaction(
    [
      prisma.settlement.count({ where }),
      prisma.settlement.findMany({
        where,
        include: {
          merchant: { select: { id: true, name: true } },
          order: { select: { id: true, price: true, createdAt: true, status: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ],
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  )

  const items = rawItems.map(item => {
    const eligibility = getSettlementEligibility(item.order.status)
    return {
      ...item,
      payable: eligibility.payable,
      blockReason: eligibility.blockReason,
    }
  })

  return { items, total, page, pageSize }
}

/**
 * Admin batch-settle: mark Settlement pending→settled AND credit the merchant
 * owner account (settlementAmount).
 *
 * Atomicity and Lock Ordering:
 * 1. Reject duplicate settlement IDs upfront.
 * 2. Order rows locked in orderId ASC order (FOR UPDATE).
 * 3. Settlement rows locked in id ASC order (FOR UPDATE).
 * 4. Re-read and verify eligibility after acquiring locks.
 * 5. Merchant PointAccount rows locked in userId ASC order (FOR UPDATE).
 * 6. All-or-nothing: any non-eligible settlement aborts the whole batch without partial credits.
 */
export async function batchSettle(adminUserId: number, settlementIds: number[]) {
  if (!Array.isArray(settlementIds) || settlementIds.length === 0) {
    throw badRequest('请提供有效的结算单ID列表')
  }
  const uniqueIds = new Set(settlementIds)
  if (uniqueIds.size !== settlementIds.length) {
    throw badRequest('存在重复的结算ID')
  }

  return prisma.$transaction(async tx => {
    const preliminary = await tx.settlement.findMany({
      where: { id: { in: settlementIds } },
      select: { id: true, orderId: true },
    })
    if (preliminary.length !== settlementIds.length) {
      throw badRequest('存在不可结算的记录')
    }

    // 1. 所有关联 Order 按 orderId ASC 获取 FOR UPDATE
    const sortedOrderIds = [...new Set(preliminary.map(p => p.orderId))].sort((a, b) => a - b)
    for (const oId of sortedOrderIds) {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${oId} FOR UPDATE`
    }

    // 2. 所有 Settlement 按 id ASC 获取 FOR UPDATE
    const sortedSettlementIds = [...settlementIds].sort((a, b) => a - b)
    for (const sId of sortedSettlementIds) {
      await tx.$queryRaw`SELECT "id" FROM "Settlement" WHERE "id" = ${sId} FOR UPDATE`
    }

    // 3. 锁后重新读取并验证 settlement status 和当前 order status
    const settlements = await tx.settlement.findMany({
      where: { id: { in: sortedSettlementIds } },
      select: {
        id: true,
        status: true,
        orderId: true,
        settlementAmount: true,
        merchantId: true,
        order: { select: { status: true } },
        merchant: { select: { userId: true, name: true } },
      },
      orderBy: { id: 'asc' },
    })

    if (
      settlements.length !== settlementIds.length ||
      settlements.some(settlement => (
        settlement.status !== 'pending' ||
        !getSettlementEligibility(settlement.order.status).payable
      ))
    ) {
      throw badRequest('存在不可结算的记录')
    }

    // 4. Merchant PointAccount 按 userId ASC 锁定/更新
    const merchantUserIds = [...new Set(settlements.map(s => s.merchant.userId))].sort((a, b) => a - b)
    for (const uId of merchantUserIds) {
      await tx.pointAccount.upsert({
        where: { userId: uId },
        create: { userId: uId, balance: 0 },
        update: {},
      })
      await tx.$queryRaw`SELECT "id" FROM "PointAccount" WHERE "userId" = ${uId} FOR UPDATE`
    }

    const now = new Date()
    let creditedTotal = 0

    // Row-by-row CAS so we never double-credit under concurrent batch calls.
    for (const settlement of settlements) {
      const claimed = await tx.settlement.updateMany({
        where: { id: settlement.id, status: 'pending' },
        data: { status: 'settled', settledAt: now },
      })
      if (claimed.count !== 1) {
        throw badRequest('存在不可结算的记录')
      }

      const amount = settlement.settlementAmount
      if (amount > 0) {
        const merchantUserId = settlement.merchant.userId
        const balanceAfter = await creditAvailablePoints(tx, merchantUserId, amount)
        await tx.pointLog.create({
          data: {
            userId: merchantUserId,
            type: 'in',
            amount,
            balanceAfter,
            reason: `商家结算入账: 订单#${settlement.orderId}`,
            orderId: settlement.orderId,
          },
        })
        creditedTotal += amount
      }
    }

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '批量结算',
        targetType: 'settlement',
        detail: `结算 ${settlements.length} 笔，入账合计 ${creditedTotal} 积分`,
      },
    })

    return { settled: settlements.length, creditedTotal }
  })
}
