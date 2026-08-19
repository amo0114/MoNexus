import { expect } from 'vitest'
import { PAYMENT_ACTION_TYPES, PAYMENT_ATTEMPT_STATUSES, PAYMENT_PROVIDER_NAMES } from '../../recharge/types.js'
import type { PaymentProvider, ProviderCapabilities, ProviderPaymentAction } from './types.js'

const ACTION_SET = new Set<string>(PAYMENT_ACTION_TYPES)
const ATTEMPT_SET = new Set<string>(PAYMENT_ATTEMPT_STATUSES)
const PROVIDER_SET = new Set<string>(PAYMENT_PROVIDER_NAMES)

export const REQUIRED_PROVIDER_METHODS = [
  'getCapabilities',
  'selectAccount',
  'createPayment',
  'queryPayment',
  'closePayment',
  'verifyAndNormalizeWebhook',
  'createRefund',
  'queryRefund',
] as const

export function assertProviderContractShape(provider: PaymentProvider) {
  expect(PROVIDER_SET.has(provider.name)).toBe(true)
  for (const method of REQUIRED_PROVIDER_METHODS) {
    expect(typeof provider[method], `${provider.name}.${method}`).toBe('function')
  }
}

export function assertProviderCapabilities(capabilities: ProviderCapabilities) {
  expect(capabilities.supportedCurrencies.length).toBeGreaterThan(0)
  expect(capabilities.paymentMethods.length).toBeGreaterThan(0)
  expect(capabilities.actionTypes.length).toBeGreaterThan(0)
  expect(capabilities.minimumAmountMinor).toBeGreaterThanOrEqual(0n)
  expect(typeof capabilities.capabilityVersion).toBe('string')
  expect(capabilities.capabilityDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(capabilities.capabilityDigest).not.toMatch(/userId|orderId|sk_|rk_|secret/i)
}

export function assertProviderPaymentAction(action: ProviderPaymentAction) {
  expect(ATTEMPT_SET.has(action.status)).toBe(true)
  expect(action.providerPaymentId.length).toBeGreaterThan(0)
  expect(ACTION_SET.has(action.action.type)).toBe(true)
  if (action.action.type === 'form_post') {
    expect(action.action.actionUrl.startsWith('https://')).toBe(true)
    expect(JSON.stringify(action.action.fields)).not.toMatch(/<script/i)
  }
  if (action.action.type === 'redirect') {
    expect(action.action.url.startsWith('https://')).toBe(true)
  }
}

export async function runLiveProviderContract(provider: PaymentProvider, input: {
  amountMinor: bigint
  currency: 'CNY' | 'USD'
  paymentMethod: string
  providerAccountKey: string
}) {
  assertProviderContractShape(provider)
  const capabilities = await provider.getCapabilities({
    providerAccountKey: input.providerAccountKey,
    environment: 'sandbox',
    currency: input.currency,
    paymentMethod: input.paymentMethod,
  })
  assertProviderCapabilities(capabilities)
  expect(capabilities.supportedCurrencies).toContain(input.currency)
  expect(capabilities.paymentMethods).toContain(input.paymentMethod)

  const created = await provider.createPayment({
    orderId: '00000000-0000-4000-8000-000000000001',
    paymentIntentId: '00000000-0000-4000-8000-000000000002',
    paymentAttemptId: '00000000-0000-4000-8000-000000000003',
    amountMinor: input.amountMinor,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
    providerAccountKey: input.providerAccountKey,
    requestIdempotencyKey: 'contract-create-1',
  })
  assertProviderPaymentAction(created)

  const queried = await provider.queryPayment({
    providerPaymentId: created.providerPaymentId,
    providerAccountKey: input.providerAccountKey,
    providerOrderId: created.providerOrderId,
  })
  expect(queried.providerPaymentId).toBe(created.providerPaymentId)
  expect(queried.amountMinor).toBe(input.amountMinor)
  expect(queried.currency).toBe(input.currency)
  expect(queried.providerAccountKey).toBe(input.providerAccountKey)

  return { created, queried, capabilities }
}
