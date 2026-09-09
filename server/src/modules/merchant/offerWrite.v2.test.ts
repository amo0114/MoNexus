import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { computeOfferCheckoutVersion } from '../../lib/offers.js'
import {
  api,
  authHeader,
  createTestMerchant,
  loginAsMerchant,
} from '../../__tests__/helpers.js'

async function setupMerchant(email: string) {
  const { merchant } = await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: 'offer-v2 商家',
  })
  const { accessToken } = await loginAsMerchant(email, 'pass123')
  if (!accessToken) throw new Error('login did not return accessToken')
  return { merchant, accessToken }
}

const structuredContent = {
  fields: [{ key: 'user', label: '账号', sensitive: false }],
  values: { user: 'demo' },
}

describe('merchant offer write v2 (attributes / structured / CAS)', () => {
  it('PUT attributes are stored and returned on list', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-attr-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: '属性规格商品',
      type: '充值卡密',
      price: 80,
      deliveryMode: 'instant_inventory',
    }).expect(201)

    const offers = await api
      .get(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .expect(200)
    const offerId = offers.body[0].id as number
    expect(typeof offers.body[0].checkoutVersion).toBe('string')
    expect(offers.body[0].checkoutVersion.length).toBeGreaterThan(0)

    const patched = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ attributes: { unitLabel: '1 个兑换码' } })
      .expect(200)
    expect(patched.body.attributes).toEqual({ unitLabel: '1 个兑换码' })
    expect(typeof patched.body.checkoutVersion).toBe('string')

    const stored = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(stored.attributes).toEqual({ unitLabel: '1 个兑换码' })

    const listed = await api
      .get(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(listed.body[0].attributes).toEqual({ unitLabel: '1 个兑换码' })
    expect(listed.body[0].checkoutVersion).toBe(computeOfferCheckoutVersion(stored))
  })

  it('PUT fixedStructuredContent is stored, writes canonical fixedContent, and is returned', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-struct-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: '结构化规格商品',
      type: '邀请码',
      price: 50,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'PLACEHOLDER-FIXED',
      fixedContentType: 'text',
    }).expect(201)

    const created = await api
      .post(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '共享账号',
        price: 120,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: null,
        fixedStructuredContent: structuredContent,
      })
      .expect(201)
    expect(created.body.fixedStructuredContent).toMatchObject(structuredContent)
    expect(created.body.fixedContent).toBe('账号: demo')

    const defaultOffer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.body.id, isDefault: true },
    })
    const patched = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({
        fixedContent: null,
        fixedStructuredContent: structuredContent,
      })
      .expect(200)
    expect(patched.body.fixedStructuredContent).toMatchObject(structuredContent)
    expect(patched.body.fixedContent).toBe('账号: demo')

    const stored = await prisma.offer.findUniqueOrThrow({ where: { id: defaultOffer.id } })
    expect(stored.fixedStructuredContent).toMatchObject(structuredContent)
    expect(stored.fixedContent).toBe('账号: demo')

    const listed = await api
      .get(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .expect(200)
    const listedDefault = listed.body.find((row: { id: number }) => row.id === defaultOffer.id)
    expect(listedDefault.fixedStructuredContent).toMatchObject(structuredContent)
    expect(listedDefault.fixedContent).toBe('账号: demo')
  })

  it('stale expectedCheckoutVersion returns 409; matching version succeeds', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-cas-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: 'CAS 规格商品',
      type: '充值卡密',
      price: 90,
      deliveryMode: 'instant_inventory',
    }).expect(201)

    const listed = await api
      .get(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .expect(200)
    const offerId = listed.body[0].id as number
    const versionA = listed.body[0].checkoutVersion as string

    const first = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ price: 91, expectedCheckoutVersion: versionA })
      .expect(200)
    expect(first.body.price).toBe(91)
    const versionB = first.body.checkoutVersion as string
    expect(versionB).not.toBe(versionA)

    const stale = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ price: 92, expectedCheckoutVersion: versionA })
      .expect(409)
    expect(stale.body.error.code).toBe('CHECKOUT_CHANGED')
    const afterStale = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(afterStale.price).toBe(91)

    const matched = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ price: 92, expectedCheckoutVersion: versionB })
      .expect(200)
    expect(matched.body.price).toBe(92)

    const legacy = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ price: 93 })
      .expect(200)
    expect(legacy.body.price).toBe(93)
  })
})
