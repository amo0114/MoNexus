import type { Order, Prisma } from '@prisma/client'
import { badRequest, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { structuredContentToJson, type StructuredDeliveryContent } from '../../lib/deliveryFields.js'
import {
  NotificationDispatcher,
  orderNotificationSnapshot,
} from '../notifications/dispatcher.js'

export const FULFILLMENT_MODES = ['instant_inventory', 'instant_fixed', 'manual_service'] as const
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number]

export const INSTANT_FULFILLMENT_MODES = ['instant_inventory', 'instant_fixed'] as const
const instantModeSet = new Set<string>(INSTANT_FULFILLMENT_MODES)

export function isInstantMode(mode: string): boolean {
  return instantModeSet.has(mode)
}

export const ORDER_STATUSES = ['pending', 'processing', 'delivered', 'disputed', 'closed', 'refunded'] as const
export type FulfillmentOrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_STATUS_ACTOR_ROLES = ['user', 'merchant', 'admin', 'system'] as const
export type OrderStatusActorRole = (typeof ORDER_STATUS_ACTOR_ROLES)[number]

const fulfillmentModeSet = new Set<string>(FULFILLMENT_MODES)
const orderStatusSet = new Set<string>(ORDER_STATUSES)
const actorRoleSet = new Set<string>(ORDER_STATUS_ACTOR_ROLES)

const legalTransitions: Record<FulfillmentOrderStatus, FulfillmentOrderStatus[]> = {
  // pending → refunded：商家拒绝接单（manual_service），冻结积分立即退还
  pending: ['processing', 'refunded'],
  processing: ['delivered'],
  delivered: ['disputed', 'closed'],
  // disputed → delivered：即时模式（instant_*）货已交付，商家驳回争议时直接恢复为已交付，
  // 否则会卡死在 processing（即时单没有商家 deliver 出口）
  // disputed → refunded：管理员仲裁支持用户，退还冻结积分
  // disputed → closed：管理员仲裁支持商家，扣减冻结积分
  disputed: ['processing', 'delivered', 'closed', 'refunded'],
  closed: [],
  refunded: [],
}

type OrderStatusEventWriter = Pick<Prisma.TransactionClient, 'orderStatusEvent'>
type OrderStatusTransitionClient = Pick<
  Prisma.TransactionClient,
  'order' | 'orderStatusEvent' | 'deliveryRecord' | 'subscriptionReminder' | 'notification' | 'merchant' | '$queryRaw'
>

export function isFulfillmentMode(mode: string): mode is FulfillmentMode {
  return fulfillmentModeSet.has(mode)
}

export function getProductFulfillmentMode(mode: string): FulfillmentMode {
  if (isFulfillmentMode(mode)) return mode
  throw badRequest('商品履约模式无效')
}

export function normalizeOrderStatus(status: string) {
  return status === 'completed' ? 'delivered' : status
}

export function isFulfillmentOrderStatus(status: string): status is FulfillmentOrderStatus {
  return orderStatusSet.has(status)
}

export function assertFulfillmentOrderStatus(status: string): FulfillmentOrderStatus {
  const normalized = normalizeOrderStatus(status)
  if (isFulfillmentOrderStatus(normalized)) return normalized
  throw badRequest('订单状态无效')
}

export function assertOrderStatusActorRole(role: string): OrderStatusActorRole {
  if (actorRoleSet.has(role)) return role as OrderStatusActorRole
  throw badRequest('订单状态操作人角色无效')
}

export function assertLegalStatusTransition(
  fromStatus: string,
  toStatus: string
): { from: FulfillmentOrderStatus; to: FulfillmentOrderStatus } {
  const from = assertFulfillmentOrderStatus(fromStatus)
  const to = assertFulfillmentOrderStatus(toStatus)

  if (!legalTransitions[from].includes(to)) {
    throw badRequest(`非法订单状态流转: ${from} -> ${to}`)
  }

  return { from, to }
}

export async function createOrderStatusEvent(
  tx: OrderStatusEventWriter,
  input: {
    orderId: number
    actorUserId?: number | null
    actorRole: OrderStatusActorRole
    fromStatus?: string | null
    toStatus: string
    action: string
    publicNote?: string | null
    internalNote?: string | null
  }
) {
  const fromStatus = input.fromStatus ? normalizeOrderStatus(input.fromStatus) : null
  const toStatus = assertFulfillmentOrderStatus(input.toStatus)

  return tx.orderStatusEvent.create({
    data: {
      orderId: input.orderId,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole,
      fromStatus,
      toStatus,
      action: input.action,
      publicNote: input.publicNote ?? null,
      internalNote: input.internalNote ?? null,
    },
  })
}

export async function transitionOrderStatus(
  input: {
    orderId: number
    toStatus: FulfillmentOrderStatus
    actorRole: OrderStatusActorRole
    actorUserId?: number | null
    action?: string
    publicNote?: string | null
    internalNote?: string | null
    deliveryContent?: string | null
    /** P5：人工交付附件（DeliveryFile id）；随交付写入快照。 */
    deliveryFileId?: number | null
    // P4b：结构化交付快照 { fields, values }；null/缺省 = 纯文本交付。
    deliveryStructuredContent?: StructuredDeliveryContent | null
    /**
     * 覆盖本单订阅到期时刻（如 FakaBridge 回传的 Xboard user.expired_at）。
     * 有值时优先于 validityDays 本地推算；未传则保持 resolveSubscriptionExpiresAt。
     */
    expiresAtOverride?: Date | null
  },
  client?: OrderStatusTransitionClient
): Promise<Order> {
  if (!client) {
    return prisma.$transaction(tx => transitionOrderStatus(input, tx))
  }

  const actorRole = assertOrderStatusActorRole(input.actorRole)
  const order = await client.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, userId: true, productId: true, status: true },
  })
  if (!order) throw notFound('订单不存在')

  const { from, to } = assertLegalStatusTransition(order.status, input.toStatus)

  // The state that was read above is part of the write predicate.  Without
  // this compare-and-set, two concurrent close/refund requests could both pass
  // validation and each write an event / settle points.
  const transitioned = await client.order.updateMany({
    where: { id: order.id, status: order.status },
    data: { status: to },
  })
  if (transitioned.count !== 1) {
    throw badRequest('订单状态已变化，请刷新后重试')
  }

  const updated = await client.order.findUnique({ where: { id: order.id } })
  if (!updated) throw notFound('订单不存在')

  if (to === 'delivered') {
    // P6a：人工/恢复交付按订单快照计算到期时刻（续费单顺延语义见
    // resolveSubscriptionExpiresAt）；争议恢复重交付时已有记录仅在原
    // expiresAt 为空时补算（不因重交付顺延订阅）。
    // FakaBridge：Xboard user.expired_at 为权威到期（expiresAtOverride），
    // 避免「面板已顺延、MoNexus 仍按交付+validityDays 推算」漂移。
    const subscriptionExpiresAt =
      input.expiresAtOverride !== undefined
        ? input.expiresAtOverride
        : await resolveSubscriptionExpiresAt(
            client,
            updated,
            updated.validityDaysSnapshot,
            new Date()
          )
    await client.deliveryRecord.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        userId: order.userId,
        productId: order.productId,
        content: input.deliveryContent ?? null,
        structuredContent: input.deliveryStructuredContent
          ? structuredContentToJson(input.deliveryStructuredContent)
          : undefined,
        fileId: input.deliveryFileId ?? null,
        status: 'delivered',
        publicNote: input.publicNote ?? null,
        deliveredAt: new Date(),
        expiresAt: subscriptionExpiresAt,
      },
      update: {
        content: input.deliveryContent ?? undefined,
        // 重新交付携带新附件则覆盖；未携带保持原值（争议恢复等路径）。
        ...(input.deliveryFileId !== undefined ? { fileId: input.deliveryFileId } : {}),
        // 重新交付时携带新快照则覆盖；未携带保持原值（争议恢复等路径）。
        structuredContent: input.deliveryStructuredContent
          ? structuredContentToJson(input.deliveryStructuredContent)
          : undefined,
        status: 'delivered',
        publicNote: input.publicNote ?? undefined,
        deliveredAt: new Date(),
      },
    })
    // 首次交付后 expiresAt 只写不改：重交付不得顺延到期（续费才顺延，T3）。
    // 例外：FakaBridge 权威 override 在首写为空时补齐；若 create 已带值则
    // updateMany(expiresAt:null) 为 no-op。
    await client.deliveryRecord.updateMany({
      where: { orderId: order.id, expiresAt: null },
      data: { expiresAt: subscriptionExpiresAt },
    })
    // Faka 对账/二次成功：若首写用了本地推算、随后拿到 Xboard expired_at，
    // 允许用 override 纠正（仅当显式传入 expiresAtOverride）。
    if (input.expiresAtOverride != null) {
      await client.deliveryRecord.updateMany({
        where: { orderId: order.id },
        data: { expiresAt: input.expiresAtOverride },
      })
    }
    // 复审 P1-2：争议重交付携带**新交付内容**且原订阅已过期时，按新交付
    // 时刻重算——否则争议补救内容落地即被遮蔽/拒下载，买家须付费续费才
    // 看得到补救。仅限"商家主动携带新内容 + 已过期"：resume-instant 不带
    // 内容不重算；未过期的重交付不顺延（防中途重交付白嫖延长）。
    const carriesNewPayload =
      input.deliveryContent != null || input.deliveryStructuredContent != null || input.deliveryFileId != null
    if (carriesNewPayload && subscriptionExpiresAt != null) {
      const extended = await client.deliveryRecord.updateMany({
        where: { orderId: order.id, expiresAt: { lt: new Date() } },
        data: { expiresAt: subscriptionExpiresAt },
      })
      // 复审 P2-1：重算出新周期后必须复位提醒状态——lastStage='expired' 是
      // 终态，留着它新周期的到期前/到期提醒永远不再发。删行即回到
      // "无行 = 待发送"语义，新周期由 cron 照常两段式提醒。
      if (extended.count > 0) {
        await client.subscriptionReminder.deleteMany({ where: { orderId: order.id } })
      }
    }
  }

  await createOrderStatusEvent(client, {
    orderId: order.id,
    actorUserId: input.actorUserId ?? null,
    actorRole,
    fromStatus: from,
    toStatus: to,
    action: input.action ?? `order.status.${from}_to_${to}`,
    publicNote: input.publicNote ?? null,
    internalNote: input.internalNote ?? null,
  })

  // SPEC-NOTIFY-001：状态迁移后同事务写入站内通知（开关关闭时 dispatcher 零副作用）。
  await emitLifecycleNotifications(client, {
    from,
    to,
    action: input.action ?? `order.status.${from}_to_${to}`,
    order: updated,
  })

  return {
    ...updated,
    status: normalizeOrderStatus(updated.status),
  }
}

function resolveDeliveredKind(action: string, deliveryMode: string): string {
  if (action.includes('faka_bridge')) return 'faka'
  if (action.includes('auto_provision')) return 'auto'
  if (isInstantMode(deliveryMode)) return 'instant'
  return 'manual'
}

async function resolveMerchantOwnerUserId(
  client: Pick<Prisma.TransactionClient, 'merchant'>,
  merchantId: number | null | undefined,
): Promise<number | null> {
  if (merchantId == null) return null
  const merchant = await client.merchant.findUnique({
    where: { id: merchantId },
    select: { userId: true },
  })
  return merchant?.userId ?? null
}

async function emitLifecycleNotifications(
  client: Pick<Prisma.TransactionClient, 'notification' | 'merchant'>,
  input: {
    from: FulfillmentOrderStatus
    to: FulfillmentOrderStatus
    action: string
    order: Order
  },
) {
  const snapshot = orderNotificationSnapshot(input.order)
  const merchantOwnerUserId = await resolveMerchantOwnerUserId(client, input.order.merchantId)

  if (input.to === 'processing' && input.from === 'pending') {
    await NotificationDispatcher.emit({
      type: 'order.processing_buyer',
      recipientUserId: input.order.userId,
      recipientRole: 'user',
      order: snapshot,
    }, client)
  }

  if (input.to === 'delivered') {
    await NotificationDispatcher.emit({
      type: 'order.delivered_buyer',
      recipientUserId: input.order.userId,
      recipientRole: 'user',
      order: snapshot,
      context: {
        deliveryKind: resolveDeliveredKind(input.action, snapshot.deliveryMode),
      },
    }, client)
  }

  if (input.to === 'disputed') {
    await NotificationDispatcher.emit({
      type: 'order.disputed_buyer',
      recipientUserId: input.order.userId,
      recipientRole: 'user',
      order: snapshot,
    }, client)
    if (merchantOwnerUserId != null) {
      await NotificationDispatcher.emit({
        type: 'order.disputed_merchant',
        recipientUserId: merchantOwnerUserId,
        recipientRole: 'merchant',
        order: snapshot,
      }, client)
    }
  }

  if (input.to === 'refunded') {
    await NotificationDispatcher.emit({
      type: 'order.refunded_buyer',
      recipientUserId: input.order.userId,
      recipientRole: 'user',
      order: snapshot,
    }, client)
    if (merchantOwnerUserId != null) {
      await NotificationDispatcher.emit({
        type: 'order.refunded_merchant',
        recipientUserId: merchantOwnerUserId,
        recipientRole: 'merchant',
        order: snapshot,
      }, client)
    }
  }

  if (input.to === 'closed') {
    await NotificationDispatcher.emit({
      type: 'order.closed_buyer',
      recipientUserId: input.order.userId,
      recipientRole: 'user',
      order: snapshot,
    }, client)
  }

  // 离开争议：仲裁结果双方通知（与目标态事件并存；各有独立 dedupeKey）。
  if (input.from === 'disputed' && input.to !== 'disputed') {
    await NotificationDispatcher.emit({
      type: 'order.dispute_resolved_buyer',
      recipientUserId: input.order.userId,
      recipientRole: 'user',
      order: snapshot,
    }, client)
    if (merchantOwnerUserId != null) {
      await NotificationDispatcher.emit({
        type: 'order.dispute_resolved_merchant',
        recipientUserId: merchantOwnerUserId,
        recipientRole: 'merchant',
        order: snapshot,
      }, client)
    }
  }
}

/**
 * P6a：按订阅时长快照计算到期时刻。null = 永久（返回 null）。
 * 续费顺延（原单未过期时自原到期起算）由续费链路另行处理（T3）。
 */
export function computeSubscriptionExpiresAt(
  validityDays: number | null | undefined,
  deliveredAt: Date
): Date | null {
  if (validityDays == null || validityDays <= 0) return null
  return new Date(deliveredAt.getTime() + validityDays * 24 * 60 * 60 * 1000)
}

/**
 * P6a T3：交付时解析订阅到期时刻的单点实现（即时下单事务与人工交付共用，
 * 两条路径的顺延语义必须一致）：
 * - 非续费单，或原单到期时刻在交付时已过 → 自交付时刻起算（重算）；
 * - 续费单且原单 expiresAt 仍在未来 → 在原到期时刻上顺延 validityDays 天，
 *   买家提前续费不损失剩余时长。
 * 复审 P1-2：顺延前先锁原单行并终检其状态——人工续费单在"待交付"期间
 * 原单被退款的，交付时不得继承已退款原单的剩余有效期（自交付时刻重算）。
 * FOR UPDATE 与退款路径的行更新互斥，避免"读到未退款、写后才退款"的窗口；
 * 也与下单侧续费终检（P1-1）用同一把锁。
 */
export async function resolveSubscriptionExpiresAt(
  client: Pick<Prisma.TransactionClient, 'order' | 'deliveryRecord' | '$queryRaw'>,
  order: { renewalOfOrderId: number | null },
  validityDays: number | null | undefined,
  deliveredAt: Date
): Promise<Date | null> {
  if (validityDays == null || validityDays <= 0) return null
  if (order.renewalOfOrderId != null) {
    await client.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.renewalOfOrderId} FOR UPDATE`
    const original = await client.order.findUnique({
      where: { id: order.renewalOfOrderId },
      select: { status: true, delivery: { select: { expiresAt: true } } },
    })
    if (
      original
      && original.status !== 'refunded'
      && original.delivery?.expiresAt
      && original.delivery.expiresAt.getTime() > deliveredAt.getTime()
    ) {
      return new Date(original.delivery.expiresAt.getTime() + validityDays * 24 * 60 * 60 * 1000)
    }
  }
  return computeSubscriptionExpiresAt(validityDays, deliveredAt)
}
