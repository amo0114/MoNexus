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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForLockWaiters(min: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
    `
    if (Number(rows[0]?.count ?? 0) >= min) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('barrier: concurrent offer CAS did not wait on the product row lock')
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

  it('PUT price + matching canonical fixedContent on a structured offer keeps structured', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-keep-struct-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: '价格保存保留结构化商品',
      type: '邀请码',
      price: 50,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'PLACEHOLDER-FIXED',
      fixedContentType: 'text',
    }).expect(201)

    const defaultOffer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.body.id, isDefault: true },
    })
    await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({
        fixedContent: null,
        fixedStructuredContent: structuredContent,
      })
      .expect(200)

    const patched = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({ price: 80, fixedContent: '账号: demo' })
      .expect(200)
    expect(patched.body.price).toBe(80)
    expect(patched.body.fixedContent).toBe('账号: demo')
    expect(patched.body.fixedStructuredContent).toMatchObject(structuredContent)

    const stored = await prisma.offer.findUniqueOrThrow({ where: { id: defaultOffer.id } })
    expect(stored.price).toBe(80)
    expect(stored.fixedContent).toBe('账号: demo')
    expect(stored.fixedStructuredContent).toMatchObject(structuredContent)
  })

  it('PUT differing fixedContent on a structured offer returns 400 and leaves structured', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-text-blocked-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: '禁止文本覆盖结构化商品',
      type: '邀请码',
      price: 50,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'PLACEHOLDER-FIXED',
      fixedContentType: 'text',
    }).expect(201)

    const defaultOffer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.body.id, isDefault: true },
    })
    await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({
        fixedContent: null,
        fixedStructuredContent: structuredContent,
      })
      .expect(200)

    const patched = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({ price: 999, fixedContent: 'other' })
      .expect(400)
    expect(patched.body.error.message).toContain('结构化固定内容')

    const stored = await prisma.offer.findUniqueOrThrow({ where: { id: defaultOffer.id } })
    expect(stored.price).toBe(50)
    expect(stored.fixedContent).toBe('账号: demo')
    expect(stored.fixedStructuredContent).toMatchObject(structuredContent)
  })

  it('PUT only fixedStructuredContent on a text offer stores structured + canonical without 400', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-struct-wins-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: '结构化覆盖文本商品',
      type: '邀请码',
      price: 50,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'PLACEHOLDER-FIXED',
      fixedContentType: 'text',
    }).expect(201)

    const defaultOffer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.body.id, isDefault: true },
    })
    expect(defaultOffer.fixedContent).toBe('PLACEHOLDER-FIXED')
    expect(defaultOffer.fixedStructuredContent).toBeNull()

    const patched = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({ fixedStructuredContent: structuredContent })
      .expect(200)
    expect(patched.body.fixedStructuredContent).toMatchObject(structuredContent)
    expect(patched.body.fixedContent).toBe('账号: demo')

    const stored = await prisma.offer.findUniqueOrThrow({ where: { id: defaultOffer.id } })
    expect(stored.fixedStructuredContent).toMatchObject(structuredContent)
    expect(stored.fixedContent).toBe('账号: demo')
  })

  it('PUT only fixedStructuredContent on a structured offer updates structured + canonical without 400', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-struct-replace-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: '结构化替换商品',
      type: '邀请码',
      price: 50,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'PLACEHOLDER-FIXED',
      fixedContentType: 'text',
    }).expect(201)

    const defaultOffer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.body.id, isDefault: true },
    })
    await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({
        fixedContent: null,
        fixedStructuredContent: structuredContent,
      })
      .expect(200)

    const nextStructured = {
      fields: [
        { key: 'user', label: '账号', sensitive: false },
        { key: 'pass', label: '密码', sensitive: true },
      ],
      values: { user: 'alice', pass: 'secret' },
    }
    const patched = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({ fixedStructuredContent: nextStructured })
      .expect(200)
    expect(patched.body.fixedStructuredContent).toMatchObject(nextStructured)
    expect(patched.body.fixedContent).toBe('账号: alice\n密码: secret')

    const stored = await prisma.offer.findUniqueOrThrow({ where: { id: defaultOffer.id } })
    expect(stored.fixedStructuredContent).toMatchObject(nextStructured)
    expect(stored.fixedContent).toBe('账号: alice\n密码: secret')
  })

  it('PUT deliveryMode manual_service on an instant_fixed text offer clears leftover fixed fields', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-mode-switch-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: '履约切换商品',
      type: '邀请码',
      price: 50,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'hello-fixed-text',
      fixedContentType: 'text',
    }).expect(201)

    const defaultOffer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.body.id, isDefault: true },
    })
    expect(defaultOffer.fixedContent).toBe('hello-fixed-text')

    const patched = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${defaultOffer.id}`)
      .set(authHeader(accessToken))
      .send({ deliveryMode: 'manual_service' })
      .expect(200)
    expect(patched.body.deliveryMode).toBe('manual_service')
    expect(patched.body.fixedContent).toBeNull()
    expect(patched.body.fixedStructuredContent).toBeNull()

    const stored = await prisma.offer.findUniqueOrThrow({ where: { id: defaultOffer.id } })
    expect(stored.deliveryMode).toBe('manual_service')
    expect(stored.fixedContent).toBeNull()
    expect(stored.fixedStructuredContent).toBeNull()
    expect(stored.fixedFileId).toBeNull()
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

  it('serializes concurrent expectedCheckoutVersion updates: one 200, one 409 CHECKOUT_CHANGED', async () => {
    const { accessToken } = await setupMerchant(`offer-v2-cas-race-${Date.now()}@test.local`)
    const product = await api.post('/api/merchant/products').set(authHeader(accessToken)).send({
      name: '并发 CAS 规格商品',
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
    const productId = product.body.id as number

    const lockHeld = deferred()
    const releaseHold = deferred()
    const holding = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`
      lockHeld.resolve()
      await releaseHold.promise
    }, { timeout: 15_000 })
    await lockHeld.promise

    const pending = Promise.all([
      api
        .put(`/api/merchant/products/${productId}/offers/${offerId}`)
        .set(authHeader(accessToken))
        .send({ price: 91, expectedCheckoutVersion: versionA }),
      api
        .put(`/api/merchant/products/${productId}/offers/${offerId}`)
        .set(authHeader(accessToken))
        .send({ price: 92, expectedCheckoutVersion: versionA }),
    ])
    try {
      await waitForLockWaiters(2)
    } finally {
      releaseHold.resolve()
    }
    await holding
    const [resA, resB] = await pending

    expect([resA.status, resB.status].sort()).toEqual([200, 409])
    const winner = resA.status === 200 ? resA : resB
    const loser = resA.status === 409 ? resA : resB
    expect(loser.body.error.code).toBe('CHECKOUT_CHANGED')
    expect([91, 92]).toContain(winner.body.price)
    expect(winner.body.checkoutVersion).not.toBe(versionA)

    const stored = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(stored.price).toBe(winner.body.price)
    expect(computeOfferCheckoutVersion(stored)).toBe(winner.body.checkoutVersion)
  })
})
