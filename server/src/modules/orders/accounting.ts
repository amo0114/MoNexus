import type { Prisma } from '@prisma/client'
import { conflict } from '../../lib/httpError.js'
import {
  captureInTx,
  noteInTx,
  refundInTx,
  releaseInTx,
  reserveInTx,
  spendInTx,
  type WalletContext,
} from '../wallet/index.js'
import { markSettlementPayableInTx, voidUnsettledInTx } from '../merchantFinance/index.js'

type Tx = Prisma.TransactionClient

export type HeldOrder = {
  id: number
  userId: number
  holdingPoints: number | null
  fundsHeld: boolean
}

/** Order wallet keys: one charge, one capture/release, one refund per order. */
export const orderWalletKey = {
  spend: (orderId: number) => `order:${orderId}:spend`,
  reserve: (orderId: number) => `order:${orderId}:reserve`,
  capture: (orderId: number) => `order:${orderId}:capture`,
  release: (orderId: number) => `order:${orderId}:release`,
  refund: (orderId: number) => `order:${orderId}:refund`,
}

function orderCtx(order: { id: number; userId: number }, key: string, reasonCode: string, reason: string, actorUserId?: number | null): WalletContext {
  return {
    operationKey: key,
    userId: order.userId,
    source: { kind: 'order', id: order.id },
    reasonCode,
    actorUserId,
    log: { reason, orderId: order.id },
  }
}

/** Checkout charge: instant modes consume immediately; manual modes reserve. */
export async function chargeOrderInTx(
  tx: Tx,
  order: { id: number; userId: number; price: number },
  mode: 'spend' | 'reserve',
  reason: string,
) {
  const ctx = orderCtx(order, orderWalletKey[mode](order.id), `order_${mode}`, reason, order.userId)
  return mode === 'reserve'
    ? reserveInTx(tx, ctx, { amount: order.price })
    : (await spendInTx(tx, ctx, { amount: order.price }))!
}

/**
 * Capture the buyer's reservation without releasing merchant payout.
 * Caller must hold the order lock and use fresh state after its status/task CAS.
 * `fundsHeld=false` is a deliberately narrow compatibility path for orders
 * created before frozenBalance existed; new orders never take this branch.
 */
export async function captureHeldOrder(
  client: Tx,
  order: HeldOrder,
  reason: string
): Promise<number | null> {
  const amount = order.holdingPoints ?? 0
  if (amount <= 0) return null

  const claimed = await client.order.updateMany({
    where: { id: order.id, userId: order.userId, holdingPoints: amount, fundsHeld: order.fundsHeld },
    data: { holdingPoints: null, fundsHeld: false },
  })
  if (claimed.count !== 1) return null

  const ctx = orderCtx(order, orderWalletKey.capture(order.id), 'order_capture', reason)
  const result = order.fundsHeld
    ? await captureInTx(client, ctx, { reserveKey: orderWalletKey.reserve(order.id), legacyAmount: amount })
    : (await spendInTx(client, ctx, { amount }))!
  return result.balance
}

/** Close/confirm an order and release merchant funds, even if payment was captured earlier. */
export async function settleHeldOrder(
  client: Tx,
  order: HeldOrder,
  reason: string
): Promise<number | null> {
  const balanceAfter = await captureHeldOrder(client, order, reason)
  await markSettlementPayableInTx(client, order.id)
  return balanceAfter
}

/** Return a manual-service reservation without counting it as earned points. */
export async function releaseHeldOrder(
  client: Tx,
  order: HeldOrder,
  reason: string
): Promise<number | null> {
  const amount = order.holdingPoints ?? 0
  if (amount <= 0) return null

  const claimed = await client.order.updateMany({
    where: { id: order.id, userId: order.userId, holdingPoints: amount, fundsHeld: order.fundsHeld },
    data: { holdingPoints: null, fundsHeld: false },
  })
  if (claimed.count !== 1) return null

  const ctx = orderCtx(order, orderWalletKey.release(order.id), 'order_release', reason)
  // The old system only remembered the hold on Order, without reserving the
  // balance.  Preserve the amount and leave the account untouched.
  const result = order.fundsHeld
    ? await releaseInTx(client, ctx, { reserveKey: orderWalletKey.reserve(order.id), legacyAmount: amount })
    : await noteInTx(client, { ...ctx, log: { ...ctx.log, type: 'release' } }, { logAmount: amount })
  await voidUnsettledInTx(client, order.id, ['holding'])
  return result.balance
}

/**
 * Return a captured/instant order payment to its original sources. This is not
 * an earning and must not affect tier progress. Shared by arbitration and
 * after-sales: the single refund key makes a second refund of one order impossible.
 */
export async function refundPaidOrder(
  client: Tx,
  order: Pick<HeldOrder, 'id' | 'userId'> & { price: number },
  reason: string,
  actorUserId?: number | null,
) {
  const ctx = orderCtx(order, orderWalletKey.refund(order.id), 'order_refund', reason, actorUserId)
  const paid = await client.walletOperation.findFirst({
    where: {
      operationKey: { in: [orderWalletKey.spend(order.id), orderWalletKey.capture(order.id)] },
      kind: { in: ['spend', 'capture'] },
    },
    select: { operationKey: true },
  })
  if (paid) return refundInTx(client, ctx, { originalKey: paid.operationKey })

  // Pre-wallet order: only an old-ledger debit of this exact order proves what
  // may be returned; new orders always have a wallet operation.
  const legacyDebit = await client.pointLog.findFirst({
    where: { orderId: order.id, userId: order.userId, type: 'out', amount: order.price, walletOperation: null },
    select: { id: true },
  })
  if (!legacyDebit) throw conflict('找不到该订单的原扣款记录，不能退款')
  return refundInTx(client, ctx, { originalKey: orderWalletKey.spend(order.id), legacyAmount: order.price })
}

/**
 * A refund must not be created after merchant funds have already been settled.
 * Claim the pending/holding record before changing the order state so a racing
 * batch settlement can no longer settle it. Settled orders go through after-sales.
 */
export async function voidRefundableSettlement(client: Tx, orderId: number) {
  await voidUnsettledInTx(client, orderId, ['pending', 'holding'], { rejectSettled: true })
}
