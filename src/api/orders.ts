import api from './client'
import { UserOrderListItem, UserOrderDetail } from '../types/order'
import type { PurchaseFormField } from '../types/merchant'
import type { LegalRequirement } from './legal'

export interface CheckoutPreview {
  productId: number
  productName: string
  /** 本次报价对应的规格(P4a);单 SKU 为默认 Offer。 */
  offerId: number
  offerName: string
  price: number
  deliveryMode: string
  chargeType: 'debit' | 'hold'
  balanceBefore: number
  balanceAfter: number
  sufficient: boolean
  purchasable: boolean
  unpurchasableReason?: string
  purchaseForm: PurchaseFormField[]
  purchaseFormVersion: string
  /** P4b：Offer 结算版本(价格/履约方式/固定内容/交付模板摘要);下单携带。 */
  checkoutVersion: string
  // 高风险二次验证：true 时弹窗渲染登录密码输入框（服务端下单时重新裁决）
  requiresVerification: boolean
  /** P7b：本规格是否走自动开通。true 时结算弹窗明示表单答案将外发到商家 webhook。与 Faka 路径互斥。 */
  autoProvision: boolean
  /** FakaBridge：需验证开通邮箱归属；验证后允许升/降级。与 autoProvision 互斥。 */
  requiresProvisionEmailProof?: boolean
  fakaCapacity?: {
    remaining: number | null
    capacityLimit: number | null
    sellable: boolean
    source: 'xboard' | 'unavailable'
    reason?: string
  } | null
  /** SPEC-LEGAL-001：下单必须确认的协议版本（法律页面关闭 = null，隐藏勾选区）。 */
  legalRequirement?: LegalRequirement | null
}

export async function getCheckoutPreview(productId: number, offerId?: number): Promise<CheckoutPreview> {
  const { data } = await api.get('/checkout/preview', {
    params: { productId, ...(offerId != null ? { offerId } : {}) },
  })
  return data
}

export interface CreateOrderResult {
  orderId: number
  productName: string
  price: number
  status: string
  deliveryMode: string
  deliveryContent?: string
  deliveryContentType?: string
  /** P4b：结构化交付快照;成功弹窗据此字段化展示。 */
  deliveryStructuredContent?: import('../types/merchant').StructuredDeliveryContent
  /** P5：文件交付元数据;下载走 issueOrderFileDownloadUrl,响应里没有直链。 */
  deliveryFile?: { fileName: string; size: number }
  balanceAfter: number
  merchantId: number | null
  merchantName: string | null
  idempotentReplay?: boolean
  /** FakaBridge 等外部开通：下单成功但发货异步进行中。 */
  provisionPending?: boolean
}

export async function createOrder(
  productId: number,
  options: {
    expectedPrice: number
    idempotencyKey: string
    offerId?: number
    formAnswers?: Record<string, string>
    expectedPurchaseFormVersion?: string
    /** P4b：预览返回的 Offer 结算版本;配置变化 → 409 CHECKOUT_CHANGED。 */
    expectedCheckoutVersion?: string
    verificationPassword?: string
    /** P6a：续费下单时关联的原订单;服务端校验合法性并顺延到期时间。 */
    renewalOfOrderId?: number
    /** SPEC-LEGAL-001：协议确认 { document: version }，来自预览的 legalRequirement。 */
    agreementVersions?: Record<string, string>
  }
): Promise<CreateOrderResult> {
  const { data } = await api.post(
    '/orders',
    {
      productId,
      ...(options.offerId != null ? { offerId: options.offerId } : {}),
      expectedPrice: options.expectedPrice,
      ...(options.expectedPurchaseFormVersion
        ? { expectedPurchaseFormVersion: options.expectedPurchaseFormVersion }
        : {}),
      ...(options.expectedCheckoutVersion
        ? { expectedCheckoutVersion: options.expectedCheckoutVersion }
        : {}),
      ...(options.formAnswers && Object.keys(options.formAnswers).length > 0
        ? { formAnswers: options.formAnswers }
        : {}),
      ...(options.verificationPassword ? { verificationPassword: options.verificationPassword } : {}),
      ...(options.renewalOfOrderId != null ? { renewalOfOrderId: options.renewalOfOrderId } : {}),
      ...(options.agreementVersions ? { agreementVersions: options.agreementVersions } : {}),
    },
    { headers: { 'Idempotency-Key': options.idempotencyKey } }
  )
  return data
}

export async function getOrders(params?: { page?: number; pageSize?: number; status?: string }): Promise<UserOrderListItem[]> {
  const { data } = await api.get('/orders', { params })
  return data
}

export async function getOrderDetail(id: number): Promise<UserOrderDetail> {
  const { data } = await api.get(`/orders/${id}`)
  return data
}

/** P5：受控文件下载发放。每次点击都重新请求;签名 URL 不落地任何状态。 */
export interface FileDownloadGrant {
  url: string
  expiresAt: string
  fileName: string
  size: number
}

export async function issueOrderFileDownloadUrl(orderId: number): Promise<FileDownloadGrant> {
  const { data } = await api.post(`/orders/${orderId}/files/download-url`)
  return data
}

/** P6a：续费预检返回(同买家/订阅单/offer 仍在售时 200)。 */
export interface RenewPrecheck {
  productId: number
  offerId: number
  offerName: string
  price: number
  validityDays: number | null
  currentExpiresAt: string | null
}

/**
 * P6a：续费预检。400 code RENEW_NOT_SUBSCRIPTION（非订阅单）/
 * RENEW_OFFER_UNAVAILABLE（规格已下架）。通过后前端走标准结算并携带
 * renewalOfOrderId 下新单。
 */
export async function renewOrder(id: number): Promise<RenewPrecheck> {
  const { data } = await api.post(`/orders/${id}/renew`)
  return data
}

export async function disputeOrder(id: number): Promise<void> {
  await api.post(`/orders/${id}/dispute`)
}

export async function closeOrder(id: number): Promise<void> {
  await api.post(`/orders/${id}/close`)
}
