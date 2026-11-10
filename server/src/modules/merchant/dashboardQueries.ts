import { prisma } from '../../lib/prisma.js'
import { getMerchantFinanceSummary, listSettlementEntries } from '../merchantFinance/index.js'

// ---- Settlements ----

/** Legacy array shape for the dashboard tab; the paged envelope is listFinanceEntries. */
export async function listMySettlements(merchantId: number, page = 1, pageSize = 20) {
  return (await listSettlementEntries({ merchantId, page, pageSize })).items
}

export async function listFinanceEntries(merchantId: number, query: { status?: string; page?: number; pageSize?: number }) {
  return listSettlementEntries({ ...query, merchantId })
}

export async function getFinanceSummary(merchantId: number) {
  return getMerchantFinanceSummary(merchantId)
}

// ---- Stats ----

export async function getMyStats(merchantId: number) {
  const now = new Date()
  const [productCount, orderCount, finance, pendingCount, processingCount, slaExceeded] =
    await Promise.all([
      prisma.product.count({ where: { merchantId } }),
      prisma.order.count({ where: { merchantId } }),
      getMerchantFinanceSummary(merchantId),
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
    // Net earned points (voided earnings and after-sales reversals excluded).
    totalRevenue: finance.netEarned,
    // Not yet credited: waiting for completion plus settleable now.
    pendingSettlement: finance.awaitingCompletion + finance.settleable,
    finance,
    todo: {
      pending: pendingCount,
      processing: processingCount,
      slaExceeded,
    },
  }
}
