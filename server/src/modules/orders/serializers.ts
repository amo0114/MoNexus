import { normalizeOrderStatus } from './fulfillment.js'

type OrderWithDelivery = {
  delivery?: ({ content?: unknown } & Record<string, unknown>) | null
  product?: ({ deliveryMode?: string | null } & Record<string, unknown>) | null
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
  const normalized = normalizeFulfillmentFields(order)
  return {
    ...normalized,
    ...(normalized.product?.deliveryMode ? { deliveryMode: normalized.product.deliveryMode } : {}),
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

export function serializeUserOrderList<T extends OrderWithDelivery>(order: T) {
  return omitDeliveryContent(withUserOrderContract(order, false))
}

export function serializeUserOrderDetail<T extends OrderWithDelivery>(order: T) {
  return withUserOrderContract(order, true)
}

export function serializeMerchantOrder<T extends OrderWithDelivery>(order: T) {
  return omitDeliveryContent(normalizeFulfillmentFields(order))
}

export function serializeAdminOrderList<T extends OrderWithDelivery>(order: T) {
  return omitDeliveryContent(normalizeFulfillmentFields(order))
}

export function serializeAdminOrderDetail<T extends OrderWithDelivery>(order: T) {
  return normalizeFulfillmentFields(order)
}
