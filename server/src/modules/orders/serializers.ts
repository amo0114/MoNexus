type OrderWithDelivery = {
  delivery?: ({ content?: unknown } & Record<string, unknown>) | null
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
  return omitDeliveryContent(order)
}

export function serializeUserOrderDetail<T>(order: T) {
  return order
}

export function serializeMerchantOrder<T extends OrderWithDelivery>(order: T) {
  return omitDeliveryContent(order)
}

export function serializeAdminOrderList<T extends OrderWithDelivery>(order: T) {
  return omitDeliveryContent(order)
}

export function serializeAdminOrderDetail<T>(order: T) {
  return order
}
