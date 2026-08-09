/**
 * SPEC-NOTIFY-001 NotificationDispatcher — central filter, template render, idempotent write.
 * Phase 1: same transaction as order mutation; ON CONFLICT DO NOTHING via createMany skipDuplicates.
 */

import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { notificationCreatedCounter } from '../../lib/metrics.js'
import { logger } from '../../lib/logger.js'
import { renderNotification, type NotificationRenderContext } from './templates.js'
import { NOTIFICATION_REALTIME_CHANNEL } from './realtime/constants.js'
import { serializePgPayload } from './realtime/protocol.js'

export type NotificationRecipientRole = 'user' | 'merchant' | 'admin'

export type OrderNotificationSnapshot = {
  id: number
  merchantId?: number | null
  deliveryMode: string
  productName: string
  offerName?: string | null
  userId?: number
}

export type NotificationEvent = {
  type: string
  recipientUserId: number
  recipientRole: NotificationRecipientRole
  order: OrderNotificationSnapshot
  context?: Record<string, unknown>
}

type NotificationWriter = Pick<Prisma.TransactionClient, 'notification'> & {
  /** Present on every real Prisma transaction client; optional in the type so
   * narrow caller typings (e.g. fulfillment) still satisfy the writer. The
   * dispatcher fails loud if realtime is enabled but it is missing. */
  $queryRaw?: Prisma.TransactionClient['$queryRaw']
}

/** NTF-05: merchant new-order only for human manual attention after auto-task branches. */
export function shouldNotifyMerchantNewOrder(input: {
  merchantId: number | null | undefined
  deliveryMode: string
  status: string
  hasProvisionTask: boolean
  hasFakaBridgeTask: boolean
}): boolean {
  if (input.merchantId == null) return false
  if (input.deliveryMode !== 'manual_service') return false
  if (input.hasProvisionTask || input.hasFakaBridgeTask) return false
  return input.status === 'pending' || input.status === 'processing'
}

/** NTF-06 helper: buyer gets delivered when first reaching delivered result. */
export function shouldNotifyBuyerDelivered(order: {
  status: string
  deliveryMode?: string | null
}): boolean {
  return order.status === 'delivered' || order.status === 'completed'
}

export function buildDedupeKey(eventType: string, orderId: number): string {
  switch (eventType) {
    case 'order.created_merchant':
      return `order:${orderId}:merchant_new`
    case 'order.processing_buyer':
      return `order:${orderId}:processing`
    case 'order.delivered_buyer':
      return `order:${orderId}:delivered`
    case 'order.refunded_buyer':
      return `order:${orderId}:refunded`
    case 'order.refunded_merchant':
      return `order:${orderId}:refunded_m`
    case 'order.disputed_buyer':
      return `order:${orderId}:disputed`
    case 'order.disputed_merchant':
      return `order:${orderId}:disputed_m`
    case 'order.dispute_resolved_buyer':
      return `order:${orderId}:resolved`
    case 'order.dispute_resolved_merchant':
      return `order:${orderId}:resolved_m`
    case 'order.closed_buyer':
      return `order:${orderId}:closed`
    default:
      return `order:${orderId}:${eventType}`
  }
}

/** Project order row into a notification-safe snapshot (no delivery content). */
export function orderNotificationSnapshot(order: {
  id: number
  merchantId?: number | null
  deliveryModeSnapshot?: string | null
  deliveryMode?: string | null
  productNameSnapshot?: string | null
  productName?: string | null
  offerNameSnapshot?: string | null
  offerName?: string | null
  userId?: number
}): OrderNotificationSnapshot {
  return {
    id: order.id,
    merchantId: order.merchantId ?? null,
    deliveryMode: order.deliveryModeSnapshot ?? order.deliveryMode ?? 'manual_service',
    productName: order.productNameSnapshot ?? order.productName ?? '商品',
    offerName: order.offerNameSnapshot ?? order.offerName ?? null,
    userId: order.userId,
  }
}

function expiresAtFromConfig(now = new Date()): Date {
  const days = config.notification.expiryDays
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
}

function toRenderContext(event: NotificationEvent): NotificationRenderContext {
  return {
    orderId: event.order.id,
    productName: event.order.productName,
    offerName: event.order.offerName,
    deliveryMode: event.order.deliveryMode,
    merchantId: event.order.merchantId,
    deliveryKind: typeof event.context?.deliveryKind === 'string'
      ? event.context.deliveryKind
      : undefined,
  }
}

export class NotificationDispatcher {
  /**
   * Phase 1: sync write inside the caller's transaction.
   * Disabled when NOTIFICATION_ENABLED=false (zero side effects).
   * Duplicate (recipient, eventType, dedupeKey) is ignored (NTF-02).
   */
  static async emit(event: NotificationEvent, tx: NotificationWriter): Promise<void> {
    if (!config.notification.enabled) return

    if (!Number.isInteger(event.recipientUserId) || event.recipientUserId <= 0) {
      return
    }

    const template = renderNotification(event.type, toRenderContext(event))
    const dedupeKey = buildDedupeKey(event.type, event.order.id)

    const result = await tx.notification.createMany({
      data: [{
        recipientUserId: event.recipientUserId,
        recipientRole: event.recipientRole,
        eventType: event.type,
        category: template.category,
        title: template.title,
        body: template.body,
        payload: template.payload as Prisma.InputJsonValue,
        deeplink: template.deeplink,
        level: template.level,
        status: 'unread',
        dedupeKey,
        relatedOrderId: event.order.id,
        relatedMerchantId: event.order.merchantId ?? null,
        expiresAt: expiresAtFromConfig(),
      }],
      skipDuplicates: true,
    })

    if (result.count === 0) {
      logger.warn({
        event: 'notification.duplicate',
        eventType: event.type,
        dedupeKey,
        recipientUserId: event.recipientUserId,
      }, 'Duplicate notification skipped')
      return
    }
    // SPEC-NOTIFY-RT-001: resolve the new row's id by composite unique key (D-RT-03).
    const created = await tx.notification.findFirst({
      where: { recipientUserId: event.recipientUserId, eventType: event.type, dedupeKey },
      select: { id: true },
    })
    if (!created) {
      logger.warn({
        event: 'notification.missing_id',
        eventType: event.type,
        dedupeKey,
        recipientUserId: event.recipientUserId,
      }, 'Could not resolve notification id after insert; skipping realtime hint')
      return
    }

    // D-RT-03 / NRT-003: same transaction, parameterized pg_notify on the static
    // channel. Any SQL failure propagates so business write + Notification + hint
    // roll back together. Never catch/defer/run-after-commit.
    if (config.notificationRealtime.enabled) {
      if (typeof tx.$queryRaw !== 'function') {
        throw new Error('NotificationWriter must expose $queryRaw when NOTIFICATION_REALTIME_ENABLED=true')
      }
      const payload = serializePgPayload(created.id, event.recipientUserId)
      // Called as a method on tx so Prisma keeps its internal `this` binding.
      // ::text cast avoids Prisma's inability to deserialize a void column.
      await tx.$queryRaw`SELECT pg_notify(${NOTIFICATION_REALTIME_CHANNEL}, ${payload})::text AS result`
    }

    notificationCreatedCounter.inc({
      event_type: event.type,
      recipient_role: event.recipientRole,
    })

    logger.info({
      event: 'notification.created',
      eventType: event.type,
      recipientUserId: event.recipientUserId,
      notificationId: created.id,
      orderId: event.order.id,
      dedupeKey,
    }, 'Notification created')
  }
}
