export type UserRole = 'user' | 'admin' | 'merchant'
export type MerchantStatus = 'pending' | 'active' | 'suspended' | 'rejected'
export type SettlementStatus = 'pending' | 'settled' | 'holding' | 'voided'
export type ProductStatus = 'active' | 'inactive'
export type DeliveryMode = 'instant_inventory' | 'instant_fixed' | 'manual_service'
export type StockMode = 'limited' | 'unlimited'

/**
 * SKU/套餐(P4a)。Offer 是价格与履约配置的真相源;单 SKU 商品只有一条
 * "默认规格"。商家端返回完整字段(含 fixedContent),公开接口经
 * serializePublicOffer 剥离 fixedContent。
 */
export interface Offer {
  id: number
  productId?: number
  name: string
  price: number
  originalPrice: number | null
  status: ProductStatus
  deliveryMode: DeliveryMode
  stockMode: StockMode
  stock: number
  /** instant_inventory 的 Offer 级可用交付单元数；非即时库存可缺省。 */
  availableStock?: number
  /** 仅商家端可见;公开商品详情剥离。 */
  fixedContent?: string | null
  fixedContentType?: string
  /** P5：file 形态挂载的交付文件 id(商家端);公开接口只出 deliveryFileSize。 */
  fixedFileId?: number | null
  /** P5：商家端文件元数据(listMyOffers 附带)。 */
  fixedFile?: { fileName: string; size: number; status: string } | null
  /** P5：公开接口上 file 形态的文件大小(字节)。 */
  deliveryFileSize?: number | null
  /** P6a：订阅有效期(天),null/缺省 = 永久;下单快照冻结,改动仅影响新订单。 */
  validityDays?: number | null
  sales?: number
  sortOrder?: number
  /** 每商品恰有一条默认规格;商品级兼容路径(旧编辑/未指定规格的库存操作)落到它。 */
  isDefault?: boolean
  createdAt?: string
  /** P4b：交付字段模板;空数组/缺省 = 纯文本交付。 */
  deliveryFields?: DeliveryField[] | null
  /** P7b：本规格是否走自动开通。与 FakaBridge 互斥。 */
  autoProvision?: boolean
  /** FakaBridge：是否走外部开通。与 autoProvision 互斥。 */
  provisionsExternal?: 'faka_bridge' | null
  /** FakaBridge：Xboard 订阅人数容量快照（商品详情/结算预检）。 */
  fakaCapacity?: {
    remaining: number | null
    capacityLimit: number | null
    sellable: boolean
    source: 'xboard' | 'unavailable'
    reason?: string
  } | null
}

/** P4b：交付字段模板项。模板公开(买家购前可见字段名),字段"值"是敏感数据。 */
export interface DeliveryField {
  key: string
  label: string
  sensitive: boolean
  placeholder?: string
}

/** P4b：结构化交付内容快照(交付时的模板 + 值)。 */
export interface StructuredDeliveryContent {
  fields: DeliveryField[]
  values: Record<string, string>
}

/** 创建/更新规格的请求体(部分字段)。 */
export interface OfferWriteRequest {
  name?: string
  price?: number
  originalPrice?: number | null
  status?: ProductStatus
  deliveryMode?: DeliveryMode
  stockMode?: StockMode
  stock?: number
  fixedContent?: string | null
  fixedContentType?: 'text' | 'url' | 'file'
  /** P5：file 形态挂载的交付文件;null 清空(配合切回 text/url)。 */
  fixedFileId?: number | null
  sortOrder?: number
  /** P6a：订阅有效期(1-3650 天);null = 永久。 */
  validityDays?: number | null
  /** P4b：交付字段模板;null 清空回纯文本交付。 */
  deliveryFields?: DeliveryField[] | null
  /** P7b：是否走自动开通;服务端校验 manual_service + 无模板 + active webhook 配置,否则 422。 */
  autoProvision?: boolean
  /** 仅更新时接受;true = 把默认转移到本规格(不能传 false 取消默认)。 */
  isDefault?: boolean
}

/**
 * P7b：自动开通任务的安全投影(商家/管理端徽标 + 脱敏诊断码)。
 * 内部字段(leaseToken/webhookConfigId/明文密钥)绝不透传。
 * 状态:pending 开通中 / succeeded 已自动交付 / degraded 已降级人工 / cancelled 已取消。
 */
export interface ProvisionTaskSummary {
  status: 'pending' | 'succeeded' | 'degraded' | 'cancelled' | null
  attempts: number
  /** 脱敏诊断码(dns_blocked / tls_error / http_5xx / config_revoked 等);绝非远端响应体。 */
  lastError: string | null
  lastHttpStatus: number | null
  nextAttemptAt: string | null
  merchantNotifiedAt: string | null
  updatedAt: string | null
}

/**
 * P7b：商家 webhook 配置。密钥加密存储,明文仅在创建/重置响应里出现一次
 * (saveMyWebhookConfig 返回 secret),常规读取只出 secretLast4。
 */
export interface MerchantWebhookConfig {
  url: string
  secretLast4: string
  createdAt: string
}

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
  avatarUrl?: string | null
  role: UserRole
  status: string
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
  purchaseForm?: PurchaseFormField[]
  /** SKU 列表(P4a);商家端含完整字段。单 SKU 商品为一条默认规格。 */
  offers?: Offer[]
}

/** 购买前信息收集字段定义；与后端 server/src/lib/purchaseForm.ts 契约一致。 */
export interface PurchaseFormField {
  key: string
  label: string
  type: 'text' | 'select' | 'date'
  required: boolean
  placeholder?: string
  options?: string[]
  /** P6c：date 字段专属——最早可约（今天 + N 天，默认 1）。 */
  minDaysAhead?: number
  /** P6c：date 字段专属——最晚可约（今天 + N 天，默认 30）。 */
  maxDaysAhead?: number
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
  /** 购买的规格快照(P4a)。 */
  offerId?: number | null
  offerNameSnapshot?: string | null
  /** P4b：下单时冻结的交付字段模板快照;发货按它渲染与校验(商家改模板不影响本单)。 */
  deliveryFieldsSnapshot?: DeliveryField[] | null
  user?: { id: number; email: string }
  product?: { id: number; name: string; icon: string; type: string; price?: number; deliveryMode?: string }
  delivery?: {
    status: string
    publicNote?: string | null
    deliveredAt?: string | null
    /** P5：已交付附件元数据(商家订单详情)。 */
    file?: { fileName: string; size: number; status: string } | null
  } | null
  settlement?: Settlement | null
  availableActions?: string[]
  statusEvents?: import('./order').OrderStatusEvent[]
  holdingPoints?: number | null
  fulfillmentDeadline?: string | null
  slaExceeded?: boolean
  /** P6c：预约日期（YYYY-MM-DD，来自 date 表单答案的投影）；null = 非预约单。 */
  bookingDate?: string | null
  /** 仅订单详情接口返回；列表按敏感边界剥离。 */
  purchaseFormSnapshot?: Array<{ key: string; label: string; type: string }> | null
  purchaseFormAnswers?: Record<string, string> | null
  /** P7b：自动开通任务状态(列表与详情均透出;null = 非自动开通单)。 */
  provisionTask?: ProvisionTaskSummary | null
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
  order?: { id: number; price: number; createdAt: string; status?: string }
  payable: boolean
  blockReason: string | null
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
  /** 新写路径必须使用稳定 categoryId（D-CAT-09）；legacy type 不可写。 */
  categoryId: number
  icon?: string
  imageUrl?: string
  images?: string[]
  price: number
  originalPrice?: number
  deliveryMode?: DeliveryMode
  stockMode?: StockMode
  fixedContent?: string
  fixedContentType?: 'text' | 'url'
  /** F3：默认规格名称（缺省「默认规格」）；与商品同事务落库。 */
  primaryOfferName?: string
  /** F3：附加规格；任一条无效则整个创建回滚。 */
  offers?: (OfferWriteRequest & { name: string; price: number })[]
}

export interface UpdateMerchantProductRequest extends Omit<Partial<CreateMerchantProductRequest>, 'fixedContent' | 'primaryOfferName' | 'offers'> {
  status?: ProductStatus
  /** 从固定内容交付切换到其他模式时，可显式清空。 */
  fixedContent?: string | null
}

export interface ImportInventoryRequest {
  text?: string
  items?: string[]
  /** 目标规格(P4a);缺省落到默认 Offer(单 SKU 无感)。 */
  offerId?: number
}

export interface RejectMerchantRequest {
  reason: string
}

export interface UpdateCommissionRequest {
  commissionRate: number
}

export interface BatchSettleRequest {
  settlementIds: number[]
}

export interface BatchSettleResponse {
  settled: number
  creditedTotal: number
}

export interface MerchantDetail extends Merchant {
  user?: { id: number; email: string; status: string; createdAt: string }
  products?: MerchantProduct[]
  orderCount?: number
  settlementCount?: number
}
