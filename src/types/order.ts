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
  holdingPoints?: number | null
  /** 购买的规格快照(P4a);单 SKU 商品为「默认规格」。 */
  offerId?: number | null
  offerNameSnapshot?: string | null
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
    /** P4b：结构化交付快照(fields + values);null/缺省 = 纯文本交付。 */
    structuredContent?: import('./merchant').StructuredDeliveryContent | null
    /** P5：文件交付元数据(contentType='file' 时);下载走发放端点。 */
    file?: { fileName: string; size: number; status: string } | null
    publicNote?: string | null
    deliveredAt?: string | null
  }
  timeline: OrderStatusEvent[]
  holdingPoints?: number | null
  fulfillmentDeadline?: string | null
  review?: null | {
    rating: number
    comment: string | null
    status: string
    editableUntil: string
    editedAt: string | null
    createdAt: string
  }
  canReview?: boolean
  /** 购买前填写信息：下单时的字段定义与答案快照（仅本人订单详情可见）。 */
  purchaseFormSnapshot?: Array<{ key: string; label: string; type: string }> | null
  purchaseFormAnswers?: Record<string, string> | null
}
