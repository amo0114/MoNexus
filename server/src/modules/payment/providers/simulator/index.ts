import { createHash, randomUUID } from 'node:crypto'
import { badRequest, notFound, paymentMethodUnavailable, unauthenticated } from '../../../../lib/httpError.js'
import { serializeAmountMinor } from '../../../recharge/money.js'
import { getPlatformCurrencyLimits } from '../../../recharge/money.js'
import type { PaymentAttemptStatus, RechargeCurrency } from '../../../recharge/types.js'
import { assertStructuredFormPost } from '../formPost.js'
import type {
  CloseProviderPaymentInput,
  CloseResult,
  CompleteProviderPaymentInput,
  CreateProviderPaymentInput,
  CreateProviderRefundInput,
  NormalizedPayment,
  NormalizedProviderEvent,
  NormalizedRefund,
  PaymentAction,
  PaymentProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderEnvironment,
  ProviderPaymentAction,
  QueryProviderPaymentInput,
  QueryProviderRefundInput,
  RawWebhookInput,
  ReconciliationInput,
  ProviderEntry,
} from '../types.js'

export const SIMULATOR_PROVIDER_NAME = 'simulator' as const
export const SIMULATOR_ACCOUNT_KEY = 'simulator:sandbox:default'
export const SIMULATOR_CAPABILITY_VERSION = 'simulator-v1'
export const SIMULATOR_FORM_POST_HOSTS = ['pay.simulator.test', 'sandbox.simulator.test'] as const
export const SIMULATOR_TEST_AUTH_HEADER = 'x-recharge-simulator-key'
export const SIMULATOR_PAYMENT_METHODS = ['card', 'redirect', 'qr_code', 'form_post'] as const
export type SimulatorPaymentMethod = (typeof SIMULATOR_PAYMENT_METHODS)[number]

export const SIMULATOR_FIXTURES = [
  'success',
  'failure',
  'pending',
  'timeout',
  'duplicate',
  'out_of_order',
  'amount_mismatch',
  'signature_failure',
  'refund_success',
  'refund_failure',
  'dispute',
  'paid_credit_crash',
  'create_throws',
] as const
export type SimulatorFixture = (typeof SIMULATOR_FIXTURES)[number]

type StoredPayment = {
  providerPaymentId: string
  providerOrderId: string
  providerCaptureId: string | null
  requestIdempotencyKey: string
  amountMinor: bigint
  currency: RechargeCurrency
  paymentMethod: string
  providerAccountKey: string
  status: PaymentAttemptStatus
  fixture: SimulatorFixture
  action: PaymentAction
  immutableStateVersion: string
  createdAt: Date
}

type StoredRefund = {
  providerRefundId: string
  providerPaymentId: string
  requestIdempotencyKey: string
  amountMinor: bigint
  currency: RechargeCurrency
  status: NormalizedRefund['status']
  immutableStateVersion: string
}

type CapabilityOverride = Partial<Pick<ProviderCapabilities, 'capabilityVersion' | 'minimumAmountMinor' | 'maximumAmountMinor' | 'supportsRefunds'>>

const payments = new Map<string, StoredPayment>()
const paymentsByIdempotency = new Map<string, string>()
const refunds = new Map<string, StoredRefund>()
const refundsByIdempotency = new Map<string, string>()
let nextFixture: SimulatorFixture = 'success'
let capabilityOverride: CapabilityOverride = {}
let createAmountDelta = 0n
let queryRecoveryStatus: PaymentAttemptStatus | null = null
let queryCount = 0

export function resetSimulatorState() {
  payments.clear()
  paymentsByIdempotency.clear()
  refunds.clear()
  refundsByIdempotency.clear()
  nextFixture = 'success'
  capabilityOverride = {}
  createAmountDelta = 0n
  queryRecoveryStatus = null
  queryCount = 0
}

export function getSimulatorQueryCount() {
  return queryCount
}

export function setSimulatorNextFixture(fixture: SimulatorFixture) {
  if (!(SIMULATOR_FIXTURES as readonly string[]).includes(fixture)) {
    throw badRequest('unknown simulator fixture')
  }
  nextFixture = fixture
}

export function setSimulatorCapabilityOverride(override: CapabilityOverride) {
  capabilityOverride = { ...capabilityOverride, ...override }
}

export function setSimulatorCreateAmountDelta(delta: bigint) {
  createAmountDelta = delta
}

export function setSimulatorQueryRecovery(status: PaymentAttemptStatus | null) {
  queryRecoveryStatus = status
}

export function setStoredPaymentStatus(providerPaymentId: string, status: PaymentAttemptStatus) {
  const row = payments.get(providerPaymentId)
  if (!row) throw notFound('simulator payment not found')
  row.status = status
  row.immutableStateVersion = `${status}:${row.createdAt.toISOString()}`
}

export function getStoredSimulatorPayment(providerPaymentId: string): StoredPayment | undefined {
  return payments.get(providerPaymentId)
}

export function listSimulatorFixtures() {
  return {
    success: { create: 'succeeded/requires_action', complete: 'succeeded' },
    failure: { create: 'failed' },
    pending: { create: 'processing', complete: 'processing' },
    timeout: { create: 'unknown', complete: 'unknown', query: 'unknown-or-recovered' },
    duplicate: { create: 'same providerPaymentId for same idempotency key' },
    out_of_order: { observations: 'inject any order via control endpoint' },
    amount_mismatch: { query: 'amount differs from local snapshot' },
    signature_failure: { webhook: 'signatureVerified=false' },
    refund_success: { refund: 'succeeded' },
    refund_failure: { refund: 'failed' },
    dispute: { webhook: 'dispute.opened fixture' },
    paid_credit_crash: { observation: 'succeeded received, unpaid locally' },
    create_throws: { create: 'persists payment then throws; retry returns same id' },
  }
}

function consumeFixture(): SimulatorFixture {
  const fixture = nextFixture
  nextFixture = 'success'
  return fixture
}

function isMethod(value: string): value is SimulatorPaymentMethod {
  return (SIMULATOR_PAYMENT_METHODS as readonly string[]).includes(value)
}

function digestCapabilities(input: {
  accountKey: string
  environment: string
  currency: string
  paymentMethod: string
  version: string
  minimumAmountMinor: bigint
  maximumAmountMinor: bigint | null
}): string {
  return createHash('sha256').update(JSON.stringify({
    accountKey: input.accountKey,
    environment: input.environment,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
    version: input.version,
    minimumAmountMinor: serializeAmountMinor(input.minimumAmountMinor),
    maximumAmountMinor: input.maximumAmountMinor == null ? null : serializeAmountMinor(input.maximumAmountMinor),
    methods: [...SIMULATOR_PAYMENT_METHODS],
  })).digest('hex')
}

function actionFor(
  method: SimulatorPaymentMethod,
  providerPaymentId: string,
  expiresAt: Date,
): PaymentAction {
  const expiry = expiresAt.toISOString()
  if (method === 'redirect') {
    return {
      type: 'redirect',
      url: `https://pay.simulator.test/approve/${providerPaymentId}`,
      expiresAt: expiry,
    }
  }
  if (method === 'qr_code') {
    return {
      type: 'qr_code',
      content: `SIMULATOR://pay/${providerPaymentId}`,
      display: 'text',
      expiresAt: expiry,
    }
  }
  if (method === 'form_post') {
    const action = {
      type: 'form_post' as const,
      actionUrl: 'https://pay.simulator.test/checkout',
      method: 'POST' as const,
      fields: {
        out_trade_no: providerPaymentId,
        total_amount: '1.00',
        subject: 'recharge',
      },
      expiresAt: expiry,
    }
    return {
      ...action,
      fields: assertStructuredFormPost(action, { hosts: SIMULATOR_FORM_POST_HOSTS }),
    }
  }
  return {
    type: 'client_secret',
    clientSecret: `sim_cs_${providerPaymentId}`,
    expiresAt: expiry,
  }
}

function toNormalized(row: StoredPayment, status = row.status): NormalizedPayment {
  return {
    status,
    providerPaymentId: row.providerPaymentId,
    providerOrderId: row.providerOrderId,
    providerCaptureId: row.providerCaptureId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerAccountKey: row.providerAccountKey,
    immutableStateVersion: `${status}:${row.createdAt.toISOString()}`,
    rawStatus: status,
  }
}

export const simulatorProvider: PaymentProvider = {
  name: SIMULATOR_PROVIDER_NAME,

  async selectAccount(input: {
    environment: ProviderEnvironment
    currency: RechargeCurrency
    paymentMethod: string
  }) {
    if (!isMethod(input.paymentMethod)) {
      throw paymentMethodUnavailable()
    }
    return { providerAccountKey: SIMULATOR_ACCOUNT_KEY }
  },

  async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    if (context.providerAccountKey !== SIMULATOR_ACCOUNT_KEY) {
      throw paymentMethodUnavailable('simulator account is not available')
    }
    if (!isMethod(context.paymentMethod)) {
      throw paymentMethodUnavailable()
    }
    const platform = getPlatformCurrencyLimits(context.currency)
    const version = capabilityOverride.capabilityVersion ?? SIMULATOR_CAPABILITY_VERSION
    const minimumAmountMinor = capabilityOverride.minimumAmountMinor ?? platform.minAmountMinor
    const maximumAmountMinor = capabilityOverride.maximumAmountMinor === undefined
      ? platform.maxAmountMinor
      : capabilityOverride.maximumAmountMinor
    return {
      supportedCurrencies: ['CNY', 'USD'],
      paymentMethods: SIMULATOR_PAYMENT_METHODS,
      actionTypes: ['none', 'redirect', 'qr_code', 'client_secret', 'form_post'],
      supportsRefunds: capabilityOverride.supportsRefunds ?? true,
      supportsPartialRefund: false,
      supportsDisputes: true,
      supportsReconciliation: true,
      supportsBuyerApprovalCapture: context.paymentMethod === 'redirect',
      minimumAmountMinor,
      maximumAmountMinor,
      capabilityVersion: version,
      capabilityDigest: digestCapabilities({
        accountKey: context.providerAccountKey,
        environment: context.environment,
        currency: context.currency,
        paymentMethod: context.paymentMethod,
        version,
        minimumAmountMinor,
        maximumAmountMinor,
      }),
    }
  },

  async createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentAction> {
    if (!isMethod(input.paymentMethod)) throw paymentMethodUnavailable()
    const existingId = paymentsByIdempotency.get(input.requestIdempotencyKey)
    if (existingId) {
      const existing = payments.get(existingId)
      if (!existing) throw new Error('simulator idempotency index corrupted')
      return {
        status: existing.status === 'succeeded' ? 'processing' : existing.status === 'failed' ? 'failed' : existing.status === 'unknown' ? 'unknown' : 'requires_action',
        providerPaymentId: existing.providerPaymentId,
        providerOrderId: existing.providerOrderId,
        action: existing.action,
        requestIdempotencyKey: existing.requestIdempotencyKey,
        amountMinor: existing.amountMinor,
      }
    }

    const fixture = consumeFixture()
    const providerPaymentId = `sim_pay_${randomUUID()}`
    const providerOrderId = `sim_ord_${input.orderId}`
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const action = actionFor(input.paymentMethod, providerPaymentId, expiresAt)

    let status: PaymentAttemptStatus = 'requires_action'
    if (fixture === 'failure') status = 'failed'
    else if (fixture === 'pending') status = 'processing'
    else if (fixture === 'timeout') status = 'unknown'
    else if (input.paymentMethod === 'card' && fixture === 'success') status = 'processing'

    const payableAmountMinor = input.amountMinor + createAmountDelta
    const row: StoredPayment = {
      providerPaymentId,
      providerOrderId,
      providerCaptureId: null,
      requestIdempotencyKey: input.requestIdempotencyKey,
      amountMinor: payableAmountMinor,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      providerAccountKey: input.providerAccountKey,
      status,
      fixture,
      action,
      immutableStateVersion: `${status}:${new Date().toISOString()}`,
      createdAt: new Date(),
    }
    payments.set(providerPaymentId, row)
    paymentsByIdempotency.set(input.requestIdempotencyKey, providerPaymentId)
    if (fixture === 'create_throws') {
      throw new Error('simulator create_throws')
    }
    return {
      status: status === 'failed' ? 'failed' : status === 'unknown' ? 'unknown' : status === 'processing' ? 'processing' : 'requires_action',
      providerPaymentId,
      providerOrderId,
      action,
      requestIdempotencyKey: input.requestIdempotencyKey,
      amountMinor: payableAmountMinor,
    }
  },

  async completePayment(input: CompleteProviderPaymentInput): Promise<NormalizedPayment> {
    const row = payments.get(input.providerPaymentId)
    if (!row || row.providerAccountKey !== input.providerAccountKey) {
      throw notFound('simulator payment not found')
    }
    if (row.paymentMethod !== 'redirect') {
      throw badRequest('simulator complete is only valid for redirect')
    }
    if (row.fixture === 'timeout' || row.status === 'unknown') {
      return toNormalized(row, 'unknown')
    }
    if (row.fixture === 'pending' || row.status === 'processing') {
      return toNormalized(row, 'processing')
    }
    if (row.fixture === 'failure' || row.status === 'failed') {
      return toNormalized(row, 'failed')
    }
    if (row.fixture === 'amount_mismatch') {
      return {
        ...toNormalized(row, 'succeeded'),
        amountMinor: row.amountMinor + 1n,
      }
    }
    row.status = 'succeeded'
    row.providerCaptureId = row.providerCaptureId ?? `sim_cap_${row.providerPaymentId}`
    row.immutableStateVersion = `succeeded:${row.createdAt.toISOString()}`
    return toNormalized(row, 'succeeded')
  },

  async queryPayment(input: QueryProviderPaymentInput): Promise<NormalizedPayment> {
    queryCount += 1
    const row = payments.get(input.providerPaymentId)
    if (!row || row.providerAccountKey !== input.providerAccountKey) {
      throw notFound('simulator payment not found')
    }
    if (queryRecoveryStatus) {
      row.status = queryRecoveryStatus
      row.immutableStateVersion = `${queryRecoveryStatus}:${row.createdAt.toISOString()}`
      if (queryRecoveryStatus === 'succeeded') {
        row.providerCaptureId = row.providerCaptureId ?? `sim_cap_${row.providerPaymentId}`
      }
      const recovered = queryRecoveryStatus
      queryRecoveryStatus = null
      return toNormalized(row, recovered)
    }
    if (row.fixture === 'amount_mismatch') {
      return { ...toNormalized(row), amountMinor: row.amountMinor + 1n }
    }
    return toNormalized(row)
  },

  async closePayment(input: CloseProviderPaymentInput): Promise<CloseResult> {
    const row = payments.get(input.providerPaymentId)
    if (!row || row.providerAccountKey !== input.providerAccountKey) {
      throw notFound('simulator payment not found')
    }
    if (row.status === 'succeeded') {
      return { status: 'succeeded', providerPaymentId: row.providerPaymentId, immutableStateVersion: row.immutableStateVersion }
    }
    if (row.status === 'unknown' || row.fixture === 'timeout') {
      return { status: 'unknown', providerPaymentId: row.providerPaymentId, immutableStateVersion: row.immutableStateVersion }
    }
    if (row.status === 'failed') {
      return { status: 'failed', providerPaymentId: row.providerPaymentId, immutableStateVersion: row.immutableStateVersion }
    }
    row.status = 'cancelled'
    row.immutableStateVersion = `cancelled:${row.createdAt.toISOString()}`
    return { status: 'cancelled', providerPaymentId: row.providerPaymentId, immutableStateVersion: row.immutableStateVersion }
  },

  async verifyAndNormalizeWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent> {
    const body = input.rawBody.toString('utf8')
    let parsed: { eventType?: string; providerEventId?: string; providerPaymentId?: string; fixture?: string }
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      throw badRequest('simulator webhook body is not JSON')
    }
    const signature = input.headers['x-simulator-signature']
    const signatureVerified = signature === 'simulator-test-signature'
    if (parsed.fixture === 'signature_failure' || !signatureVerified) {
      return {
        eventType: parsed.eventType ?? 'payment.failed_verification',
        providerEventId: parsed.providerEventId ?? null,
        providerPaymentId: parsed.providerPaymentId ?? null,
        providerCaptureId: null,
        providerAccountKey: SIMULATOR_ACCOUNT_KEY,
        dedupeKey: parsed.providerEventId ? `webhook:${parsed.providerEventId}` : `webhook:unverified:${createHash('sha256').update(body).digest('hex')}`,
        payment: null,
        signatureVerified: false,
      }
    }
    const payment = parsed.providerPaymentId ? payments.get(parsed.providerPaymentId) : undefined
    return {
      eventType: parsed.eventType ?? 'payment.updated',
      providerEventId: parsed.providerEventId ?? null,
      providerPaymentId: parsed.providerPaymentId ?? null,
      providerCaptureId: payment?.providerCaptureId ?? null,
      providerAccountKey: SIMULATOR_ACCOUNT_KEY,
      dedupeKey: parsed.providerEventId ? `webhook:${parsed.providerEventId}` : `webhook:${createHash('sha256').update(body).digest('hex')}`,
      payment: payment ? toNormalized(payment) : null,
      signatureVerified: true,
    }
  },

  async createRefund(input: CreateProviderRefundInput): Promise<NormalizedRefund> {
    const existingId = refundsByIdempotency.get(input.requestIdempotencyKey)
    if (existingId) {
      const existing = refunds.get(existingId)
      if (existing) {
        return {
          status: existing.status,
          providerRefundId: existing.providerRefundId,
          amountMinor: existing.amountMinor,
          currency: existing.currency,
          immutableStateVersion: existing.immutableStateVersion,
        }
      }
    }
    const fixture = nextFixture === 'refund_failure' ? 'refund_failure' : 'refund_success'
    consumeFixture()
    const providerRefundId = `sim_rf_${randomUUID()}`
    const status: NormalizedRefund['status'] = fixture === 'refund_failure' ? 'failed' : 'succeeded'
    const row: StoredRefund = {
      providerRefundId,
      providerPaymentId: input.providerPaymentId,
      requestIdempotencyKey: input.requestIdempotencyKey,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status,
      immutableStateVersion: `${status}:v1`,
    }
    refunds.set(providerRefundId, row)
    refundsByIdempotency.set(input.requestIdempotencyKey, providerRefundId)
    return {
      status,
      providerRefundId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      immutableStateVersion: row.immutableStateVersion,
    }
  },

  async queryRefund(input: QueryProviderRefundInput): Promise<NormalizedRefund> {
    const row = refunds.get(input.providerRefundId)
    if (!row) throw notFound('simulator refund not found')
    return {
      status: row.status,
      providerRefundId: row.providerRefundId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      immutableStateVersion: row.immutableStateVersion,
    }
  },

  async *listReconciliationEntries(_input: ReconciliationInput): AsyncIterable<ProviderEntry> {
    for (const row of payments.values()) {
      yield {
        providerEntryKey: row.providerPaymentId,
        providerPaymentId: row.providerPaymentId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        status: row.status,
      }
    }
  },
}

export function readSimulatorTestToken(): string | undefined {
  const token = process.env.PAYMENT_SIMULATOR_TEST_TOKEN
  return token && token.length > 0 ? token : undefined
}

export function assertSimulatorControlAuth(headerValue: string | undefined) {
  const expected = readSimulatorTestToken()
  if (!expected) throw notFound()
  if (typeof headerValue !== 'string' || headerValue !== expected) {
    throw unauthenticated('simulator control requires test authentication')
  }
}

export function shouldRegisterSimulatorControlRoutes(isProductionDeploy: boolean): boolean {
  return !isProductionDeploy
}
