import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { settlementEligibilityFor } from './batches.js'

const entrySelect = {
  id: true,
  merchantId: true,
  orderId: true,
  orderAmount: true,
  commissionRate: true,
  commissionAmount: true,
  settlementAmount: true,
  status: true,
  settledAt: true,
  createdAt: true,
  order: { select: { id: true, price: true, status: true, createdAt: true } },
  merchant: { select: { id: true, name: true, userId: true } },
  batchItem: { select: { batchId: true, walletOperationId: true } },
  adjustments: {
    select: { id: true, settlementDelta: true, commissionDelta: true, clawbackPoints: true, createdAt: true,
      recoveryCase: { select: { id: true, status: true, amountDue: true, amountCollected: true, amountWaived: true } } },
  },
} satisfies Prisma.SettlementSelect

type EntryRow = Prisma.SettlementGetPayload<{ select: typeof entrySelect }>

/**
 * One settlement row in the shared vocabulary. `credit` says how the payout is
 * evidenced: a batch item, a legacy settled row without one (shown read-only,
 * never re-credited), or nothing yet.
 */
async function serializeEntries(rows: EntryRow[]) {
  const verdicts = await settlementEligibilityFor(rows)
  return rows.map(row => {
    const verdict = verdicts.get(row.id)!
    const adjustmentTotal = row.adjustments.reduce((sum, a) => sum + a.settlementDelta, 0)
    return {
      id: row.id,
      merchantId: row.merchantId,
      merchant: { id: row.merchant.id, name: row.merchant.name },
      orderId: row.orderId,
      order: row.order,
      orderAmount: row.orderAmount,
      commissionRate: row.commissionRate,
      commissionAmount: row.commissionAmount,
      settlementAmount: row.settlementAmount,
      status: row.status,
      settledAt: row.settledAt,
      createdAt: row.createdAt,
      netAmount: row.status === 'voided' ? 0 : row.settlementAmount + adjustmentTotal,
      payable: verdict.payable,
      blockReason: verdict.payable ? null : verdict.message,
      blockCode: verdict.reason,
      credit: row.batchItem
        ? { kind: 'batch' as const, batchId: row.batchItem.batchId, walletOperationId: row.batchItem.walletOperationId }
        : row.status === 'settled' ? { kind: 'legacy_incomplete' as const } : null,
      adjustments: row.adjustments.map(a => ({
        id: a.id,
        settlementDelta: a.settlementDelta,
        commissionDelta: a.commissionDelta,
        clawbackPoints: a.clawbackPoints,
        createdAt: a.createdAt,
        recovery: a.recoveryCase
          ? { id: a.recoveryCase.id, status: a.recoveryCase.status,
            outstanding: a.recoveryCase.amountDue - a.recoveryCase.amountCollected - a.recoveryCase.amountWaived }
          : null,
      })),
    }
  })
}

export async function listSettlementEntries(query: { merchantId?: number; status?: string; page?: number; pageSize?: number }) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where: Prisma.SettlementWhereInput = {
    ...(query.merchantId != null ? { merchantId: query.merchantId } : {}),
    ...(query.status ? { status: query.status } : {}),
  }
  const [total, rows] = await prisma.$transaction(
    [
      prisma.settlement.count({ where }),
      prisma.settlement.findMany({
        where,
        select: entrySelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
  return { items: await serializeEntries(rows), total, page, pageSize }
}

/**
 * Merchant earnings in one vocabulary for every page (§7.1). These are wallet
 * points earned on the platform, not withdrawable cash; the wallet balance is
 * reported separately because a merchant may already have spent earnings.
 */
export async function getMerchantFinanceSummary(merchantId: number) {
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { userId: true } })
  const [byStatus, adjustments, credited, legacySettled, recoveries, account, pendingRows] = await Promise.all([
    prisma.settlement.groupBy({ by: ['status'], where: { merchantId }, _sum: { settlementAmount: true, orderAmount: true } }),
    prisma.settlementAdjustment.aggregate({ where: { merchantId }, _sum: { settlementDelta: true, clawbackPoints: true } }),
    prisma.settlementBatchItem.aggregate({ where: { merchantId }, _sum: { amount: true } }),
    prisma.settlement.aggregate({ where: { merchantId, status: 'settled', batchItem: null }, _sum: { settlementAmount: true } }),
    prisma.merchantRecoveryCase.findMany({
      where: { merchantId },
      select: { status: true, amountDue: true, amountCollected: true, amountWaived: true,
        actions: { where: { kind: 'wallet_clawback' }, select: { amount: true } } },
    }),
    prisma.pointAccount.findUnique({ where: { userId: merchant.userId }, select: { balance: true, frozenBalance: true } }),
    prisma.settlement.findMany({
      where: { merchantId, status: 'pending' },
      select: { id: true, status: true, orderId: true, merchantId: true, settlementAmount: true,
        order: { select: { status: true } }, merchant: { select: { userId: true, name: true } } },
    }),
  ])
  const sum = (status: string) => byStatus.find(row => row.status === status)?._sum.settlementAmount ?? 0
  const verdicts = await settlementEligibilityFor(pendingRows)
  const settleable = pendingRows.filter(row => verdicts.get(row.id)!.payable).reduce((s, row) => s + row.settlementAmount, 0)
  const pending = sum('pending')
  const recoveryClawback = recoveries.reduce((s, r) => s + r.actions.reduce((a, x) => a + x.amount, 0), 0)

  return {
    unit: 'points' as const,
    netEarned: sum('pending') + sum('holding') + sum('settled') + (adjustments._sum.settlementDelta ?? 0),
    awaitingCompletion: sum('holding') + (pending - settleable),
    settleable,
    credited: (credited._sum.amount ?? 0) + (legacySettled._sum.settlementAmount ?? 0),
    legacyCreditedWithoutVoucher: legacySettled._sum.settlementAmount ?? 0,
    clawedBack: (adjustments._sum.clawbackPoints ?? 0) + recoveryClawback,
    outstandingRecovery: recoveries
      .filter(r => r.status === 'open')
      .reduce((s, r) => s + r.amountDue - r.amountCollected - r.amountWaived, 0),
    walletBalance: account?.balance ?? 0,
    walletFrozen: account?.frozenBalance ?? 0,
  }
}
