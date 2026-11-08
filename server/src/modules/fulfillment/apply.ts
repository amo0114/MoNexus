import type { Order, Prisma } from '@prisma/client'
import type { StructuredDeliveryContent } from '../../lib/deliveryFields.js'
import { transitionOrderStatus } from '../orders/fulfillment.js'
import { captureHeldOrder, releaseHeldOrder, type HeldOrder } from '../orders/accounting.js'
import { applyRefundInventoryPolicy, type RefundInventoryOrder } from '../orders/refundInventory.js'

type Tx = Prisma.TransactionClient

/**
 * Core result application for external fulfillment. Providers verify remote
 * evidence, win their own task CAS under the Order lock, then call these in the
 * same transaction; order transitions and points stay owned by the core.
 */

export type ExternalDeliveryInput = {
  orderId: number
  action: { start: string; deliver: string }
  startNote: string
  publicNote: string
  internalNote?: string
  deliveryContent: string
  deliveryStructuredContent?: StructuredDeliveryContent | null
  /** Omit to keep local validity projection; null explicitly means no expiry. */
  expiresAtOverride?: Date | null
  captureReason: string
}

/**
 * Deliver a pending/processing order and capture its held points atomically.
 * Returns null when the order is no longer deliverable (refunded/closed/delivered).
 */
export async function deliverExternalResultInTx(tx: Tx, input: ExternalDeliveryInput): Promise<Order | null> {
  const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { status: true } })
  if (!order || (order.status !== 'pending' && order.status !== 'processing')) return null
  if (order.status === 'pending') {
    await transitionOrderStatus({
      orderId: input.orderId,
      toStatus: 'processing',
      actorRole: 'system',
      action: input.action.start,
      publicNote: input.startNote,
    }, tx)
  }
  const delivered = await transitionOrderStatus({
    orderId: input.orderId,
    toStatus: 'delivered',
    actorRole: 'system',
    action: input.action.deliver,
    deliveryContent: input.deliveryContent,
    deliveryStructuredContent: input.deliveryStructuredContent,
    publicNote: input.publicNote,
    internalNote: input.internalNote,
    ...(input.expiresAtOverride !== undefined ? { expiresAtOverride: input.expiresAtOverride } : {}),
  }, tx)
  // Capture only after authoritative success; the order stays delivered so the
  // dispute/refund flow remains available.
  await captureHeldOrder(tx, delivered, input.captureReason)
  return delivered
}

export type UndeliveredRefundOrder = HeldOrder & RefundInventoryOrder

/** Refund a still-pending external order whose remote effect is proven absent or revoked. */
export async function refundUndeliveredExternalOrderInTx(
  tx: Tx,
  order: UndeliveredRefundOrder,
  input: { action: string; publicNote: string; internalNote?: string; releaseReason: string }
): Promise<void> {
  await transitionOrderStatus({
    orderId: order.id,
    toStatus: 'refunded',
    actorRole: 'system',
    action: input.action,
    publicNote: input.publicNote,
    internalNote: input.internalNote,
  }, tx)
  await releaseHeldOrder(tx, order, input.releaseReason)
  await applyRefundInventoryPolicy(tx, order, { fromStatus: 'pending', actorUserId: order.userId })
  // A buyer/timeout cancel that had to wait for the provider ends here.
  const { cancelRequestedAt } = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { cancelRequestedAt: true } })
  await tx.order.update({
    where: { id: order.id },
    data: { resolutionReason: cancelRequestedAt ? 'cancel_requested' : 'provider_failed' },
  })
}
