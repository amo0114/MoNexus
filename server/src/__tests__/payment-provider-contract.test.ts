import { describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { PAYMENT_PROVIDER_NAMES } from '../modules/recharge/types.js'
import {
  assertProviderContractShape,
  REQUIRED_PROVIDER_METHODS,
  runLiveProviderContract,
} from '../modules/payment/providers/contractHarness.js'
import { getRegisteredProvider } from '../modules/payment/providers/registry.js'
import {
  SIMULATOR_ACCOUNT_KEY,
  simulatorProvider,
} from '../modules/payment/providers/simulator/index.js'

describe('payment provider contract harness', () => {
  it('requires the PaymentProvider surface on every mounted adapter', () => {
    const original = { ...config.recharge }
    config.recharge.registeredProviders = [...PAYMENT_PROVIDER_NAMES]
    try {
      for (const name of PAYMENT_PROVIDER_NAMES) {
        const provider = getRegisteredProvider(name)
        expect(provider, name).toBeDefined()
        assertProviderContractShape(provider!)
        for (const method of REQUIRED_PROVIDER_METHODS) {
          expect(provider![method]).toBeTypeOf('function')
        }
      }
    } finally {
      Object.assign(config.recharge, original)
    }
  })

  it('runs the Simulator through create/query/capabilities contract', async () => {
    const result = await runLiveProviderContract(simulatorProvider, {
      amountMinor: 1000n,
      currency: 'CNY',
      paymentMethod: 'card',
      providerAccountKey: SIMULATOR_ACCOUNT_KEY,
    })
    expect(result.created.providerPaymentId.startsWith('sim_pay_')).toBe(true)
    expect(result.queried.amountMinor).toBe(1000n)

    const failed = await simulatorProvider.verifyAndNormalizeWebhook({
      headers: { 'x-simulator-signature': 'forged' },
      rawBody: Buffer.from(JSON.stringify({
        eventType: 'payment.succeeded',
        providerPaymentId: result.created.providerPaymentId,
        fixture: 'signature_failure',
      })),
    })
    expect(failed.signatureVerified).toBe(false)

    const ok = await simulatorProvider.verifyAndNormalizeWebhook({
      headers: { 'x-simulator-signature': 'simulator-test-signature' },
      rawBody: Buffer.from(JSON.stringify({
        eventType: 'payment.succeeded',
        providerEventId: 'evt_contract_1',
        providerPaymentId: result.created.providerPaymentId,
      })),
    })
    expect(ok.signatureVerified).toBe(true)
    expect(ok.payment?.providerPaymentId).toBe(result.created.providerPaymentId)
  })
})
