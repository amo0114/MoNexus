export interface UserOrderListItem {
  id: number
  price: number
  status: string
  createdAt: string
  merchant: null | { id: number; name: string }
  product: {
    id: number
    name: string
    type: string
    icon: string
    imageUrl: string | null
  }
  delivery: null | { status: string }
}

export interface UserOrderDetail extends Omit<UserOrderListItem, 'delivery'> {
  delivery: null | {
    status: string
    content: string
  }
}
