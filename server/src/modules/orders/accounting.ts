import type { Prisma } from '@prisma/client'
import { badRequest, notFound } from '../../lib/httpError.js'

type AccountingClient = Pick<
  Prisma.TransactionClient,
  'pointAccount' | 'pointLog' | 'order' | 'settlement'
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

async function ensureSpendableBalance(
  client: AccountingClient,
  userId: number,
  amount: number
) {
  const account = await getAccountOrThrow(client, userId)
  if (account.balance < amount) throw badRequest('积分不足')
}

/** Atomically subtract from the balance that is actually available to spend. */
export async function debitAvailablePoints(
  client: AccountingClient,
  userId: number,
  amount: number
): Promise<number> {
  const result = await client.pointAccount.updateMany({
    where: { userId, balance: { gte: amount } },
    data: { balance: { decrement: amount } },
  })
  if (result.count !== 1) {
    await ensureSpendableBalance(client, userId, amount)
    // The account can only disappear between the conditional update and the
    // diagnostic read if data was changed outside normal application paths.
    throw badRequest('积分扣减失败，请重试')
  }
  return (await getAccountOrThrow(client, userId)).balance
}

export async function creditAvailablePoints(
  client: AccountingClient,
  userId: number,
  amount: number
): Promise<number> {
  const account = await client.pointAccount.update({
    where: { userId },
    data: { balance: { increment: amount } },
  })
  return account.balance
}

/** Atomically move available points into the manual-service reservation pool. */
export async function holdAvailablePoints(
  client: AccountingClient,
  userId: number,
  amount: number
): Promise<number> {
  const result = await client.pointAccount.updateMany({
    where: { userId, balance: { gte: amount } },
    data: {
      balance: { decrement: amount },
      frozenBalance: { increment: amount },
    },
  })
  if (result.count !== 1) {
    await ensureSpendableBalance(client, userId, amount)
    throw badRequest('积分冻结失败，请重试')
  }
  return (await getAccountOrThrow(client, userId)).balance
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
    const released = await client.pointAccount.updateMany({
      where: { userId: order.userId, frozenBalance: { gte: amount } },
      data: { frozenBalance: { decrement: amount } },
    })
    if (released.count !== 1) throw badRequest('订单冻结积分状态异常，请联系管理员')
    balanceAfter = (await getAccountOrThrow(client, order.userId)).balance
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
    const released = await client.pointAccount.updateMany({
      where: { userId: order.userId, frozenBalance: { gte: amount } },
      data: {
        frozenBalance: { decrement: amount },
        balance: { increment: amount },
      },
    })
    if (released.count !== 1) throw badRequest('订单冻结积分状态异常，请联系管理员')
    balanceAfter = (await getAccountOrThrow(client, order.userId)).balance
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
