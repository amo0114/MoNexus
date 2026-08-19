import type { PaymentActionType, PaymentAttemptStatus, PaymentProviderName, RechargeCurrency } from '../../recharge/types.js'

export type ProviderEnvironment = 'sandbox' | 'live' | 'test'

export type ProviderContext = {
  providerAccountKey: string
  environment: ProviderEnvironment
  currency: RechargeCurrency
  paymentMethod: string
}

export type ProviderCapabilities = {
  supportedCurrencies: readonly RechargeCurrency[]
  paymentMethods: readonly string[]
  actionTypes: readonly PaymentActionType[]
  supportsPartialRefund: boolean
  supportsDisputes: boolean
  supportsReconciliation: boolean
  supportsBuyerApprovalCapture: boolean
  minimumAmountMinor: bigint
  maximumAmountMinor: bigint | null
  capabilityVersion: string
  capabilityDigest: string
}

export type CreateProviderPaymentInput = {
  orderId: string
  paymentIntentId: string
  paymentAttemptId: string
  amountMinor: bigint
  currency: RechargeCurrency
  paymentMethod: string
  providerAccountKey: string
  requestIdempotencyKey: string
  returnUrl?: string
  metadata?: Record<string, string>
}

export type RedirectAction = {
  type: 'redirect'
  url: string
  expiresAt: string
}

export type QrCodeAction = {
  type: 'qr_code'
  content: string
  display: 'text' | 'image_url'
  expiresAt: string
}

export type ClientSecretAction = {
  type: 'client_secret'
  clientSecret: string
  expiresAt: string
}

export type FormPostAction = {
  type: 'form_post'
  actionUrl: string
  method: 'POST'
  fields: Record<string, string>
  expiresAt: string
}

export type NoneAction = {
  type: 'none'
}

export type PaymentAction = RedirectAction | QrCodeAction | ClientSecretAction | FormPostAction | NoneAction

export type ProviderPaymentAction = {
  status: Extract<PaymentAttemptStatus, 'created' | 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'unknown'>
  providerPaymentId: string
  providerOrderId?: string | null
  action: PaymentAction
  requestIdempotencyKey: string
}

export type NormalizedPayment = {
  status: PaymentAttemptStatus
  providerPaymentId: string
  providerOrderId?: string | null
  providerCaptureId?: string | null
  amountMinor: bigint
  currency: RechargeCurrency
  providerAccountKey: string
  immutableStateVersion: string
  rawStatus?: string
}

export type CompleteProviderPaymentInput = {
  orderId: string
  paymentAttemptId: string
  providerPaymentId: string
  providerAccountKey: string
  requestIdempotencyKey: string
  amountMinor: bigint
  currency: RechargeCurrency
}

export type QueryProviderPaymentInput = {
  providerPaymentId: string
  providerAccountKey: string
  providerOrderId?: string | null
}

export type CloseProviderPaymentInput = {
  providerPaymentId: string
  providerAccountKey: string
  requestIdempotencyKey: string
}

export type CloseResult = {
  status: Extract<PaymentAttemptStatus, 'cancelled' | 'failed' | 'succeeded' | 'unknown' | 'processing'>
  providerPaymentId: string
  immutableStateVersion: string
}

export type RawWebhookInput = {
  headers: Record<string, string | string[] | undefined>
  rawBody: Buffer
  providerAccountKey?: string
}

export type NormalizedProviderEvent = {
  eventType: string
  providerEventId?: string | null
  providerPaymentId?: string | null
  providerCaptureId?: string | null
  providerAccountKey: string
  dedupeKey: string
  payment: NormalizedPayment | null
  signatureVerified: boolean
}

export type CreateProviderRefundInput = {
  providerPaymentId: string
  providerAccountKey: string
  amountMinor: bigint
  currency: RechargeCurrency
  requestIdempotencyKey: string
}

export type QueryProviderRefundInput = {
  providerRefundId: string
  providerAccountKey: string
}

export type NormalizedRefund = {
  status: 'processing' | 'succeeded' | 'failed' | 'unknown'
  providerRefundId: string
  amountMinor: bigint
  currency: RechargeCurrency
  immutableStateVersion: string
}

export type ReconciliationInput = {
  providerAccountKey: string
  environment: ProviderEnvironment
  periodStart?: Date
  periodEnd?: Date
}

export type ProviderEntry = {
  providerEntryKey: string
  providerPaymentId?: string | null
  amountMinor: bigint
  currency: RechargeCurrency
  status: string
}

export interface PaymentProvider {
  readonly name: PaymentProviderName
  getCapabilities(context: ProviderContext): Promise<ProviderCapabilities>
  selectAccount(input: {
    environment: ProviderEnvironment
    currency: RechargeCurrency
    paymentMethod: string
  }): Promise<{ providerAccountKey: string }>
  createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentAction>
  completePayment?(input: CompleteProviderPaymentInput): Promise<NormalizedPayment>
  queryPayment(input: QueryProviderPaymentInput): Promise<NormalizedPayment>
  closePayment(input: CloseProviderPaymentInput): Promise<CloseResult>
  verifyAndNormalizeWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent>
  createRefund(input: CreateProviderRefundInput): Promise<NormalizedRefund>
  queryRefund(input: QueryProviderRefundInput): Promise<NormalizedRefund>
  listReconciliationEntries?(input: ReconciliationInput): AsyncIterable<ProviderEntry>
}
