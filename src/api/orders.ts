import api from './client'
import { UserOrderListItem, UserOrderDetail } from '../types/order'
import type { PurchaseFormField } from '../types/merchant'

export interface CheckoutPreview {
  productId: number
  productName: string
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
  // 高风险二次验证：true 时弹窗渲染登录密码输入框（服务端下单时重新裁决）
  requiresVerification: boolean
}

export async function getCheckoutPreview(productId: number): Promise<CheckoutPreview> {
  const { data } = await api.get('/checkout/preview', { params: { productId } })
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
    formAnswers?: Record<string, string>
    expectedPurchaseFormVersion?: string
    verificationPassword?: string
  }
): Promise<CreateOrderResult> {
  const { data } = await api.post(
    '/orders',
    {
      productId,
      expectedPrice: options.expectedPrice,
      ...(options.expectedPurchaseFormVersion
        ? { expectedPurchaseFormVersion: options.expectedPurchaseFormVersion }
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
