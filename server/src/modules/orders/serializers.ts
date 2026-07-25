import { normalizeOrderStatus } from './fulfillment.js'

type OrderWithDelivery = {
  delivery?: ({ content?: unknown } & Record<string, unknown>) | null
  product?: ({ deliveryMode?: string | null } & Record<string, unknown>) | null
  deliveryModeSnapshot?: string | null
  productNameSnapshot?: string | null
  productTypeSnapshot?: string | null
  productIconSnapshot?: string | null
  productImageUrlSnapshot?: string | null
  status?: string
  createdAt?: unknown
  statusEvents?: Array<{
    fromStatus?: string | null
    toStatus?: string
  } & Record<string, unknown>>
}

function normalizeStatusEvent<T extends {
  fromStatus?: string | null
  toStatus?: string
} & Record<string, unknown>>(event: T) {
  return {
    ...event,
    fromStatus: event.fromStatus ? normalizeOrderStatus(event.fromStatus) : event.fromStatus,
    toStatus: event.toStatus ? normalizeOrderStatus(event.toStatus) : event.toStatus,
  }
}

function normalizeFulfillmentFields<T extends OrderWithDelivery>(order: T) {
  return {
    ...order,
    ...(typeof order.status === 'string' ? { status: normalizeOrderStatus(order.status) } : {}),
    ...(Array.isArray(order.statusEvents)
      ? {
          statusEvents: order.statusEvents.map(normalizeStatusEvent),
        }
      : {}),
  }
}

function withProductDisplaySnapshot<T extends OrderWithDelivery>(order: T) {
  const {
    productNameSnapshot,
    productTypeSnapshot,
    productIconSnapshot,
    productImageUrlSnapshot,
    ...rest
  } = order

  if (!order.product) return rest

  // New orders retain the commercial display contract at checkout. Old rows
  // predate the migration and deliberately fall back field-by-field to the
  // currently linked Product instead of failing to render.
  return {
    ...rest,
    product: {
      ...order.product,
      ...(productNameSnapshot != null ? { name: productNameSnapshot } : {}),
      ...(productTypeSnapshot != null ? { type: productTypeSnapshot } : {}),
      ...(productIconSnapshot != null ? { icon: productIconSnapshot } : {}),
      ...(productImageUrlSnapshot != null ? { imageUrl: productImageUrlSnapshot } : {}),
    },
  }
}

function synthesizeTimeline(order: OrderWithDelivery) {
  if (Array.isArray(order.statusEvents) && order.statusEvents.length > 0) {
    return order.statusEvents.map(normalizeStatusEvent)
  }

  if (typeof order.status !== 'string') return []

  const status = normalizeOrderStatus(order.status)
  return [{
    id: null,
    actorRole: 'system',
    fromStatus: null,
    toStatus: status,
    action: order.status === 'completed' ? 'order.legacy.completed' : `order.legacy.${status}`,
    publicNote: null,
    createdAt: order.createdAt ?? null,
  }]
}

function withUserOrderContract<T extends OrderWithDelivery>(order: T, includeTimeline: boolean) {
  const normalized = withProductDisplaySnapshot(normalizeFulfillmentFields(order))
  return {
    ...normalized,
    // A product can be reconfigured after purchase. Expose the order's
    // immutable fulfillment mode so the UI describes the delivery contract
    // that was actually purchased, not today's product configuration.
    ...((normalized.deliveryModeSnapshot ?? normalized.product?.deliveryMode)
      ? { deliveryMode: normalized.deliveryModeSnapshot ?? normalized.product?.deliveryMode }
      : {}),
    ...(includeTimeline ? { timeline: synthesizeTimeline(order) } : {}),
  }
}

function omitDeliveryContent<T extends OrderWithDelivery>(order: T) {
  if (!order.delivery) return order

  const { content: _content, ...delivery } = order.delivery
  return {
    ...order,
    delivery,
  }
}

/**
 * 购买前表单答案与 DeliveryRecord.content 同一敏感级别：只允许出现在
 * 买家/商家/管理员的订单详情里。列表接口一律剥离（定义快照一并剥离，
 * 列表不需要渲染表单）。
 */
function omitPurchaseForm<T extends Record<string, unknown>>(order: T) {
  const { purchaseFormSnapshot: _s, purchaseFormAnswers: _a, ...rest } = order
  return rest
}

export function serializeUserOrderList<T extends OrderWithDelivery>(order: T) {
  return omitPurchaseForm(omitDeliveryContent(withUserOrderContract(order, false)))
}

export function serializeUserOrderDetail<T extends OrderWithDelivery>(order: T) {
  return withUserOrderContract(order, true)
}

export function serializeMerchantOrder<T extends OrderWithDelivery>(order: T) {
  // 列表与详情共用：默认剥离表单，详情在调用侧显式回填（履约依据）。
  return omitPurchaseForm(omitDeliveryContent(withProductDisplaySnapshot(normalizeFulfillmentFields(order))))
}

export function serializeAdminOrderList<T extends OrderWithDelivery>(order: T) {
  return omitPurchaseForm(omitDeliveryContent(withProductDisplaySnapshot(normalizeFulfillmentFields(order))))
}

export function serializeAdminOrderDetail<T extends OrderWithDelivery>(order: T) {
  return withProductDisplaySnapshot(normalizeFulfillmentFields(order))
}
