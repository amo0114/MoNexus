import api from './client'
import type { PublicPaymentAction } from '../pages/recharge/paymentActions'
import type { PaymentProviderName, RechargeOrderStatus } from '../pages/recharge/status'

export type RechargeAmountSource = 'suggested' | 'custom'

export interface RechargeSuggestedAmount {
  amountMinor: string
  sortOrder: number
}

export interface RechargePaymentMethodOption {
  paymentMethod: string
  actionTypes: string[]
  supportsBuyerApprovalCapture: boolean
  minimumAmountMinor: string
  maximumAmountMinor: string | null
}

export interface RechargeProviderOption {
  provider: PaymentProviderName | string
  paymentMethods: RechargePaymentMethodOption[]
}

export interface RechargeConfig {
  currency: string
  mode: string
  pricePolicyId: string
  pricePolicyCode: string
  minAmountMinor: string
  maxAmountMinor: string
  amountStepMinor: string
  dailyLimitMinor: string
  monthlyLimitMinor: string
  dailyRemainingMinor: string
  monthlyRemainingMinor: string
  suggestedAmounts: RechargeSuggestedAmount[]
  providers: RechargeProviderOption[]
  sandboxBalance?: number
}

export interface RechargeQuote {
  quoteId: string
  currency: string
  amountMinor: string
  basePoints: string
  bonusPoints: string
  totalPoints: string
  pricePolicyId: string
  pricePolicyCode: string
  provider: string
  paymentMethod: string
  effectiveMinAmountMinor: string
  effectiveMaxAmountMinor: string
  expiresAt: string
}

export interface RechargeOrder {
  orderId: string
  status: RechargeOrderStatus | string
  currency: string
  amountMinor: string
  basePoints: string
  bonusPoints: string
  totalPoints: string
  provider: string
  paymentMethod: string
  adminSandbox: boolean
  expiresAt: string
  paidAt: string | null
  creditedAt: string | null
  cancelledAt: string | null
  createdAt: string
  action: PublicPaymentAction
  paymentIntent: { id: string; status: string } | null
  activeAttempt: { id: string; status: string; providerPaymentId: string | null } | null
  observationId?: string | null
  payment?: { status: string }
}

export interface RechargeOrderList {
  page: number
  pageSize: number
  total: number
  items: RechargeOrder[]
}

export interface RechargeRefund {
  refundId: string
  orderId: string
  status: string
  amountMinor: string
  pointsToReverse: string
  reasonCode: string
  providerRefundId: string | null
  createdAt: string
  completedAt: string | null
}

function withIdempotency(key: string) {
  return { headers: { 'Idempotency-Key': key } }
}

export async function getRechargeConfig(currency: string): Promise<RechargeConfig> {
  const { data } = await api.get<RechargeConfig>('/recharge/config', { params: { currency } })
  return data
}

export async function createRechargeQuote(body: {
  currency: string
  amountMinor: string
  amountSource: RechargeAmountSource
  provider: string
  paymentMethod: string
}): Promise<RechargeQuote> {
  const { data } = await api.post<RechargeQuote>('/recharge/quotes', body)
  return data
}

export async function createRechargeOrder(quoteId: string, idempotencyKey: string): Promise<RechargeOrder> {
  const { data } = await api.post<RechargeOrder>('/recharge/orders', { quoteId }, withIdempotency(idempotencyKey))
  return data
}

export async function listRechargeOrders(params?: {
  status?: string
  page?: number
  pageSize?: number
}): Promise<RechargeOrderList> {
  const { data } = await api.get<RechargeOrderList>('/recharge/orders', { params })
  return data
}

export async function getRechargeOrder(orderId: string): Promise<RechargeOrder> {
  const { data } = await api.get<RechargeOrder>(`/recharge/orders/${orderId}`)
  return data
}

export async function completeRechargeOrder(orderId: string, idempotencyKey: string): Promise<RechargeOrder> {
  const { data } = await api.post<RechargeOrder>(
    `/recharge/orders/${orderId}/complete`,
    {},
    withIdempotency(idempotencyKey),
  )
  return data
}

export async function cancelRechargeOrder(orderId: string, idempotencyKey: string): Promise<RechargeOrder> {
  const { data } = await api.post<RechargeOrder>(
    `/recharge/orders/${orderId}/cancel`,
    {},
    withIdempotency(idempotencyKey),
  )
  return data
}

export async function requestRechargeRefund(orderId: string, idempotencyKey: string): Promise<RechargeRefund> {
  const { data } = await api.post<RechargeRefund>(
    `/recharge/orders/${orderId}/refunds`,
    {},
    withIdempotency(idempotencyKey),
  )
  return data
}
