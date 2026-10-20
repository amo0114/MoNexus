import { prisma } from '../../lib/prisma.js'
import { getSettlementEligibility } from '../orders/settlementPolicy.js'

// ---- Settlements ----

export async function listMySettlements(merchantId: number, page = 1, pageSize = 20) {
  const settlements = await prisma.settlement.findMany({
    where: { merchantId },
    include: {
      order: {
        select: { id: true, price: true, status: true, createdAt: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })

  return settlements.map(settlement => ({
    ...settlement,
    ...getSettlementEligibility(settlement.order.status),
  }))
}

// ---- Stats ----

export async function getMyStats(merchantId: number) {
  const now = new Date()
  const [productCount, orderCount, revenueResult, pendingSettlement, pendingCount, processingCount, slaExceeded] =
    await Promise.all([
      prisma.product.count({ where: { merchantId } }),
      prisma.order.count({ where: { merchantId } }),
      prisma.settlement.aggregate({
        where: { merchantId },
        _sum: { settlementAmount: true },
      }),
      prisma.settlement.aggregate({
        where: { merchantId, status: 'pending' },
        _sum: { settlementAmount: true },
      }),
      prisma.order.count({ where: { merchantId, status: 'pending' } }),
      prisma.order.count({ where: { merchantId, status: 'processing' } }),
      prisma.order.count({
        where: {
          merchantId,
          status: { in: ['pending', 'processing'] },
          fulfillmentDeadline: { lt: now },
        },
      }),
    ])

  return {
    productCount,
    orderCount,
    totalRevenue: revenueResult._sum.settlementAmount ?? 0,
    pendingSettlement: pendingSettlement._sum.settlementAmount ?? 0,
    todo: {
      pending: pendingCount,
      processing: processingCount,
      slaExceeded,
    },
  }
}
