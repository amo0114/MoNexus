export type UserRole = 'user' | 'admin' | 'merchant'
export type MerchantStatus = 'pending' | 'active' | 'suspended' | 'rejected'
export type SettlementStatus = 'pending' | 'settled' | 'holding' | 'voided'
export type ProductStatus = 'active' | 'inactive'
export type DeliveryMode = 'instant_inventory' | 'instant_fixed' | 'manual_service'
export type StockMode = 'limited' | 'unlimited'

export interface ListEnvelope<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface Merchant {
  id: number
  userId: number
  name: string
  description: string | null
  status: MerchantStatus
  commissionRate: string
  contactEmail: string | null
  contactPhone: string | null
  createdAt: string
  updatedAt: string
  approvedAt: string | null
  approvedBy: number | null
}

export interface AuthUser {
  id: number
  email: string
  nickname?: string | null
  role: UserRole
  status: string
  inviteCode: string
  points: number
  emailVerified?: string | null
  createdAt?: string
  merchant: null | {
    id: number
    name: string
    status: MerchantStatus
    commissionRate: string
  }
}

export interface MerchantProduct {
  id: number
  merchantId: number | null
  name: string
  description: string | null
  richDescription: string | null
  type: string
  icon: string
  imageUrl: string | null
  /** 商品图片列表；首张为封面，与 imageUrl 保持一致。 */
  images?: string[]
  price: number
  originalPrice: number | null
  stock: number
  sales: number
  isHot: boolean
  status: ProductStatus
  createdAt: string
  merchant?: { id: number; name: string } | null
  _count?: { inventory: number }
  deliveryMode?: DeliveryMode
  stockMode: StockMode
  fixedContent?: string | null
  fixedContentType?: string
  availableStock?: number
  lowStock?: boolean
}

export interface MerchantOrder {
  id: number
  userId: number
  productId: number
  merchantId: number
  price: number
  commissionRate: string
  commissionAmount: number
  settlementAmount: number
  status: string
  createdAt: string
  user?: { id: number; email: string }
  product?: { id: number; name: string; icon: string; type: string; price?: number; deliveryMode?: string }
  delivery?: { status: string; publicNote?: string | null; deliveredAt?: string | null } | null
  settlement?: Settlement | null
  availableActions?: string[]
  statusEvents?: any[]
  holdingPoints?: number | null
  fulfillmentDeadline?: string | null
  slaExceeded?: boolean
}

export interface Settlement {
  id: number
  merchantId: number
  orderId: number
  orderAmount: number
  commissionRate: string
  commissionAmount: number
  settlementAmount: number
  status: SettlementStatus
  settledAt: string | null
  createdAt: string
  merchant?: { id: number; name: string }
  order?: { id: number; price: number; createdAt: string }
  payable?: boolean
  blockReason?: string | null
}

export interface MerchantStats {
  productCount: number
  orderCount: number
  totalRevenue: number
  pendingSettlement: number
  todo?: {
    pending: number
    processing: number
    slaExceeded: number
  }
}

export interface ApplyMerchantRequest {
  name: string
  description?: string
  contactEmail?: string
  contactPhone?: string
}

export interface UpdateMerchantRequest {
  name?: string
  description?: string
  contactEmail?: string
  contactPhone?: string
}

export interface CreateMerchantProductRequest {
  name: string
  description?: string
  richDescription?: string
  type: string
  icon?: string
  imageUrl?: string
  images?: string[]
  price: number
  originalPrice?: number
  isHot?: boolean
  deliveryMode?: DeliveryMode
  stockMode?: StockMode
  /** 非即时库存商品的可售/服务名额。即时库存请使用交付库存管理。 */
  stock?: number
  fixedContent?: string
  fixedContentType?: 'text' | 'url'
}

export interface UpdateMerchantProductRequest extends Omit<Partial<CreateMerchantProductRequest>, 'fixedContent'> {
  status?: ProductStatus
  /** 从固定内容交付切换到其他模式时，可显式清空。 */
  fixedContent?: string | null
}

export interface ImportInventoryRequest {
  text?: string
  items?: string[]
}

export interface RejectMerchantRequest {
  reason?: string
}

export interface UpdateCommissionRequest {
  commissionRate: number
}

export interface BatchSettleRequest {
  settlementIds: number[]
}

export interface MerchantDetail extends Merchant {
  user?: { id: number; email: string; status: string; createdAt: string }
  products?: MerchantProduct[]
  orderCount?: number
  settlementCount?: number
}
