import { describe, expect, it } from 'vitest'
import { getProductTemplate } from './registry.js'
import {
  allowedFulfillmentConfigurations,
  evaluateTemplateFulfillment,
  resolveFulfillmentStrategy,
} from './fulfillmentStrategy.js'
import type { FulfillmentOfferInput } from './types.js'

const inventoryOffer: FulfillmentOfferInput = {
  deliveryMode: 'instant_inventory',
  stockMode: 'limited',
  fixedContentType: 'text',
  fixedContent: null,
  fixedFileId: null,
  deliveryFields: null,
  autoProvision: false,
  externalIntegration: null,
}

describe('resolveFulfillmentStrategy (SPEC-PRODUCT-COMMERCE-002 §4.2 / §9.4)', () => {
  it('selects each legal configuration without a default fallback', () => {
    expect(resolveFulfillmentStrategy(inventoryOffer)).toEqual({ ok: true, strategy: { kind: 'inventory' } })
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'same-for-everyone',
    })).toEqual({ ok: true, strategy: { kind: 'fixed_text' } })
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContentType: 'url',
      fixedContent: 'https://example.invalid/guide',
    })).toEqual({ ok: true, strategy: { kind: 'fixed_url' } })
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContentType: 'file',
      fixedFileId: 9,
    })).toEqual({ ok: true, strategy: { kind: 'fixed_file' } })
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
    })).toEqual({ ok: true, strategy: { kind: 'manual' } })
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      autoProvision: true,
    })).toEqual({ ok: true, strategy: { kind: 'merchant_webhook' } })
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      externalIntegration: 'faka_bridge',
      externalSku: 'plan-basic',
    })).toEqual({ ok: true, strategy: { kind: 'faka_bridge' } })
  })

  it('rejects mixed or conflicting offer configuration', () => {
    expect(resolveFulfillmentStrategy({ ...inventoryOffer, stockMode: 'unlimited' }).ok).toBe(false)
    expect(resolveFulfillmentStrategy({ ...inventoryOffer, fixedContent: 'secret' }).ok).toBe(false)
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'manual_service',
      autoProvision: true,
      externalIntegration: 'faka_bridge',
    }).ok).toBe(false)
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'instant_fixed',
      fixedContentType: 'file',
      fixedFileId: 1,
      fixedContent: 'also-text',
    }).ok).toBe(false)
    expect(resolveFulfillmentStrategy({
      ...inventoryOffer,
      deliveryMode: 'instant_inventory',
      deliveryFields: [{ key: 'code', label: '卡密', sensitive: true }],
      fixedFileId: 3,
    }).ok).toBe(false)
  })
})

describe('template fulfillmentRules matching', () => {
  it('uses exclusive vs shared account rules and requires structured delivery on publish', () => {
    const account = getProductTemplate('account', 1)
    if (!account) throw new Error('missing account template')
    expect(allowedFulfillmentConfigurations(account, { accessModel: 'exclusive' })).toEqual(['inventory'])
    expect(allowedFulfillmentConfigurations(account, { accessModel: 'shared' })).toEqual(['fixed_text'])
    expect(allowedFulfillmentConfigurations(account, {}).sort()).toEqual(['fixed_text', 'inventory'])

    const exclusiveDraft = evaluateTemplateFulfillment({
      template: account,
      productAttributes: {},
      offer: { ...inventoryOffer, deliveryFields: [{ key: 'user', label: '账号', sensitive: false }] },
      mode: 'draft',
    })
    expect(exclusiveDraft.ok).toBe(true)

    const exclusivePublish = evaluateTemplateFulfillment({
      template: account,
      productAttributes: { accessModel: 'exclusive' },
      offer: inventoryOffer,
      mode: 'publish',
    })
    expect(exclusivePublish.ok).toBe(false)

    const sharedPublish = evaluateTemplateFulfillment({
      template: account,
      productAttributes: { accessModel: 'shared' },
      offer: {
        ...inventoryOffer,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'user: demo',
        fixedStructuredContent: {
          fields: [{ key: 'user', label: '账号', sensitive: false }],
          values: { user: 'demo' },
        },
      },
      mode: 'publish',
    })
    expect(sharedPublish.ok).toBe(true)
  })

  it('requires a date purchase field before publishing an appointment', () => {
    const appointment = getProductTemplate('appointment', 1)
    if (!appointment) throw new Error('missing appointment template')
    const offer: FulfillmentOfferInput = {
      ...inventoryOffer,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
    }
    expect(evaluateTemplateFulfillment({
      template: appointment,
      productAttributes: { deliveryChannel: 'video', timeZone: 'Asia/Shanghai' },
      offer,
      mode: 'publish',
      purchaseForm: [{ type: 'text', required: true }],
    }).ok).toBe(false)
    expect(evaluateTemplateFulfillment({
      template: appointment,
      productAttributes: { deliveryChannel: 'video', timeZone: 'Asia/Shanghai' },
      offer,
      mode: 'publish',
      purchaseForm: [{ type: 'date', required: true }],
    }).ok).toBe(true)
  })
})
