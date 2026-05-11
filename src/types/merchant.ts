export type UserRole = 'user' | 'admin' | 'merchant'
export type MerchantStatus = 'pending' | 'active' | 'suspended' | 'rejected'
export type SettlementStatus = 'pending' | 'settled'
export type ProductStatus = 'active' | 'inactive'

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
  price: number
  originalPrice: number | null
  stock: number
  sales: number
  isHot: boolean
  status: ProductStatus
  createdAt: string
  merchant?: { id: number; name: string } | null
  _count?: { inventory: number }
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
  product?: { id: number; name: string; icon: string; type: string }
  delivery?: { content: string; status: string } | null
  settlement?: Settlement | null
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
}

export interface MerchantStats {
  productCount: number
  orderCount: number
  totalRevenue: number
  pendingSettlement: number
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
  price: number
  originalPrice?: number
  isHot?: boolean
}

export interface UpdateMerchantProductRequest extends Partial<CreateMerchantProductRequest> {
  status?: ProductStatus
}

export interface ImportInventoryRequest {
  items: string[]
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
