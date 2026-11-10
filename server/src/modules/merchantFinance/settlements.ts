import type { Prisma } from '@prisma/client'
import { badRequest } from '../../lib/httpError.js'

type Tx = Prisma.TransactionClient

/**
 * The per-order earning record, created with the order. Amounts are the checkout
 * snapshot; later commission-rate changes never recompute it.
 */
export async function createSettlementInTx(tx: Tx, input: {
  merchantId: number
  orderId: number
  orderAmount: number
  commissionRate: number
  commissionAmount: number
  held: boolean
}) {
  return tx.settlement.create({
    data: {
      merchantId: input.merchantId,
      orderId: input.orderId,
      orderAmount: input.orderAmount,
      commissionRate: input.commissionRate,
      commissionAmount: input.commissionAmount,
      settlementAmount: input.orderAmount - input.commissionAmount,
      status: input.held ? 'holding' : 'pending',
    },
  })
}

/** A captured manual order's earning becomes payable once the order allows it. */
export async function markSettlementPayableInTx(tx: Tx, orderId: number) {
  await tx.settlement.updateMany({
    where: { orderId, status: 'holding' },
    data: { status: 'pending' },
  })
}

/**
 * Cancel an earning that was never paid out. With `rejectSettled`, a settled
 * earning is an error: it can only be reversed through after-sales.
 */
export async function voidUnsettledInTx(
  tx: Tx,
  orderId: number,
  statuses: Array<'pending' | 'holding'>,
  options: { rejectSettled?: boolean } = {},
) {
  const result = await tx.settlement.updateMany({
    where: { orderId, status: { in: statuses } },
    data: { status: 'voided' },
  })
  if (result.count === 1 || !options.rejectSettled) return

  const settlement = await tx.settlement.findUnique({ where: { orderId }, select: { status: true } })
  if (settlement?.status === 'settled') {
    throw badRequest('订单已结算，请通过售后处理退款')
  }
}
