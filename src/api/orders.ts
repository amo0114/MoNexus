import api from './client'
import { UserOrderListItem, UserOrderDetail } from '../types/order'
import type { PurchaseFormField } from '../types/merchant'

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
  balanceAfter: number
  merchantId: number | null
  merchantName: string | null
  idempotentReplay?: boolean
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

export async function disputeOrder(id: number): Promise<void> {
  await api.post(`/orders/${id}/dispute`)
}

export async function closeOrder(id: number): Promise<void> {
  await api.post(`/orders/${id}/close`)
}
