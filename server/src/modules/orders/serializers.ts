import { normalizeOrderStatus } from './fulfillment.js'

type OrderWithDelivery = {
  delivery?: ({ content?: unknown } & Record<string, unknown>) | null
  status?: string
  statusEvents?: Array<{
    fromStatus?: string | null
    toStatus?: string
  } & Record<string, unknown>>
}

function normalizeFulfillmentFields<T extends OrderWithDelivery>(order: T) {
  return {
    ...order,
    ...(typeof order.status === 'string' ? { status: normalizeOrderStatus(order.status) } : {}),
    ...(Array.isArray(order.statusEvents)
      ? {
          statusEvents: order.statusEvents.map(event => ({
            ...event,
            fromStatus: event.fromStatus ? normalizeOrderStatus(event.fromStatus) : event.fromStatus,
            toStatus: event.toStatus ? normalizeOrderStatus(event.toStatus) : event.toStatus,
          })),
        }
      : {}),
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
  return omitDeliveryContent(normalizeFulfillmentFields(order))
}

export function serializeUserOrderDetail<T extends OrderWithDelivery>(order: T) {
  return normalizeFulfillmentFields(order)
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
