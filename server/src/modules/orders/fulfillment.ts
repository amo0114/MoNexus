import type { Order, Prisma } from '@prisma/client'
import { badRequest, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'

export const FULFILLMENT_MODES = ['instant_inventory', 'instant_fixed', 'manual_service'] as const
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number]

export const INSTANT_FULFILLMENT_MODES = ['instant_inventory', 'instant_fixed'] as const
const instantModeSet = new Set<string>(INSTANT_FULFILLMENT_MODES)

export function isInstantMode(mode: string): boolean {
  return instantModeSet.has(mode)
}

export const ORDER_STATUSES = ['pending', 'processing', 'delivered', 'disputed', 'closed'] as const
export type FulfillmentOrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_STATUS_ACTOR_ROLES = ['user', 'merchant', 'admin', 'system'] as const
export type OrderStatusActorRole = (typeof ORDER_STATUS_ACTOR_ROLES)[number]

const fulfillmentModeSet = new Set<string>(FULFILLMENT_MODES)
const orderStatusSet = new Set<string>(ORDER_STATUSES)
const actorRoleSet = new Set<string>(ORDER_STATUS_ACTOR_ROLES)

const legalTransitions: Record<FulfillmentOrderStatus, FulfillmentOrderStatus[]> = {
  pending: ['processing'],
  processing: ['delivered'],
  delivered: ['disputed', 'closed'],
  // disputed → delivered：即时模式（instant_*）货已交付，商家驳回争议时直接恢复为已交付，
  // 否则会卡死在 processing（即时单没有商家 deliver 出口）
  disputed: ['processing', 'delivered', 'closed'],
  closed: [],
}

type OrderStatusEventWriter = Pick<Prisma.TransactionClient, 'orderStatusEvent'>
type OrderStatusTransitionClient = Pick<
  Prisma.TransactionClient,
  'order' | 'orderStatusEvent' | 'deliveryRecord'
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

  const updated = await client.order.update({
    where: { id: order.id },
    data: { status: to },
  })

  if (to === 'delivered') {
    await client.deliveryRecord.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        userId: order.userId,
        productId: order.productId,
        content: input.deliveryContent ?? null,
        status: 'delivered',
        publicNote: input.publicNote ?? null,
        deliveredAt: new Date(),
      },
      update: {
        content: input.deliveryContent ?? undefined,
        status: 'delivered',
        publicNote: input.publicNote ?? undefined,
        deliveredAt: new Date(),
      },
    })
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

  return {
    ...updated,
    status: normalizeOrderStatus(updated.status),
  }
}
