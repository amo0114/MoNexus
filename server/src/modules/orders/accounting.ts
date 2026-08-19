import type { Prisma } from '@prisma/client'
import { badRequest, notFound } from '../../lib/httpError.js'
import {
  consumeHeldPoints,
  creditAvailablePoints as creditChecked,
  debitAvailablePoints as debitChecked,
  holdAvailablePoints as holdChecked,
  releaseHeldPoints,
  type PointMutationClient,
} from '../points/checkedMutation.js'

type AccountingClient = PointMutationClient & Pick<
  Prisma.TransactionClient,
  'pointLog' | 'order' | 'settlement'
>

export type HeldOrder = {
  id: number
  userId: number
  holdingPoints: number | null
  fundsHeld: boolean
}

async function getAccountOrThrow(client: AccountingClient, userId: number) {
  const account = await client.pointAccount.findUnique({ where: { userId } })
  if (!account) throw notFound('积分账户不存在')
  return account
}

/** Atomically subtract from the balance that is actually available to spend. */
export async function debitAvailablePoints(
  client: AccountingClient,
  userId: number,
  amount: number
): Promise<number> {
  return (await debitChecked(client, userId, amount)).balance
}

export async function creditAvailablePoints(
  client: AccountingClient,
  userId: number,
  amount: number
): Promise<number> {
  return (await creditChecked(client, userId, amount)).balance
}

/** Atomically move available points into the manual-service reservation pool. */
export async function holdAvailablePoints(
  client: AccountingClient,
  userId: number,
  amount: number
): Promise<number> {
  return (await holdChecked(client, userId, amount)).balance
}

/**
 * Complete a held order exactly once after its status CAS has succeeded.
 * `fundsHeld=false` is a deliberately narrow compatibility path for orders
 * created before frozenBalance existed; new orders never take this branch.
 */
export async function settleHeldOrder(
  client: AccountingClient,
  order: HeldOrder,
  reason: string
): Promise<number | null> {
  const amount = order.holdingPoints ?? 0
  if (amount <= 0) return null

  let balanceAfter: number
  if (order.fundsHeld) {
    balanceAfter = (await consumeHeldPoints(client, order.userId, amount)).balance
  } else {
    balanceAfter = await debitAvailablePoints(client, order.userId, amount)
  }

  await client.pointLog.create({
    data: {
      userId: order.userId,
      type: 'out',
      amount,
      balanceAfter,
      reason,
      orderId: order.id,
    },
  })
  await client.order.update({
    where: { id: order.id },
    data: { holdingPoints: null, fundsHeld: false },
  })
  await client.settlement.updateMany({
    where: { orderId: order.id, status: 'holding' },
    data: { status: 'pending' },
  })
  return balanceAfter
}

/** Return a manual-service reservation without counting it as earned points. */
export async function releaseHeldOrder(
  client: AccountingClient,
  order: HeldOrder,
  reason: string
): Promise<number | null> {
  const amount = order.holdingPoints ?? 0
  if (amount <= 0) return null

  let balanceAfter: number
  if (order.fundsHeld) {
    balanceAfter = (await releaseHeldPoints(client, order.userId, amount)).balance
  } else {
    // The old system only remembered the hold on Order, without reserving the
    // balance.  Preserve the amount and leave the account untouched.
    balanceAfter = (await getAccountOrThrow(client, order.userId)).balance
  }

  await client.pointLog.create({
    data: {
      userId: order.userId,
      type: 'release',
      amount,
      balanceAfter,
      reason,
      orderId: order.id,
    },
  })
  await client.order.update({
    where: { id: order.id },
    data: { holdingPoints: null, fundsHeld: false },
  })
  await client.settlement.updateMany({
    where: { orderId: order.id, status: 'holding' },
    data: { status: 'voided' },
  })
  return balanceAfter
}

/** Refund a completed instant order; this is not an earning and must not affect tier progress. */
export async function refundPaidOrder(
  client: AccountingClient,
  order: Pick<HeldOrder, 'id' | 'userId'> & { price: number },
  reason: string
): Promise<number> {
  const balanceAfter = await creditAvailablePoints(client, order.userId, order.price)
  await client.pointLog.create({
    data: {
      userId: order.userId,
      type: 'refund',
      amount: order.price,
      balanceAfter,
      reason,
      orderId: order.id,
    },
  })
  return balanceAfter
}

/**
 * A refund must not be created after merchant funds have already been settled.
 * Claim the pending/holding record before changing the order state so a racing
 * batch settlement can no longer settle it.
 */
export async function voidRefundableSettlement(client: AccountingClient, orderId: number) {
  const result = await client.settlement.updateMany({
    where: { orderId, status: { in: ['pending', 'holding'] } },
    data: { status: 'voided' },
  })
  if (result.count === 1) return

  const settlement = await client.settlement.findUnique({ where: { orderId } })
  if (settlement?.status === 'settled') {
    throw badRequest('订单已结算，不能自动退款，请先完成线下冲正')
  }
}
