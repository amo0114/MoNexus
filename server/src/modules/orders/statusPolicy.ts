import { badRequest } from '../../lib/httpError.js'

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
