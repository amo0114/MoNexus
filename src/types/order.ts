export interface OrderStatusEvent {
  id?: number | null
  actorRole: 'user' | 'merchant' | 'admin' | 'system'
  fromStatus: string | null
  toStatus: string
  action: string
  publicNote: string | null
  createdAt: string | null
}

export interface UserOrderListItem {
  id: number
  price: number
  status: string
  deliveryMode: string
  createdAt: string
  merchant: null | { id: number; name: string }
  product: {
    id: number
    name: string
    type: string
    icon: string
    imageUrl: string | null
    deliveryMode: string
  }
  delivery: null | { status: string; publicNote?: string | null; deliveredAt?: string | null }
}

export interface UserOrderDetail extends Omit<UserOrderListItem, 'delivery'> {
  delivery: null | {
    status: string
    content: string
    contentType?: string
    publicNote?: string | null
    deliveredAt?: string | null
  }
  timeline: OrderStatusEvent[]
}
