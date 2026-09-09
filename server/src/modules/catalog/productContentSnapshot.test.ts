import { describe, expect, it } from 'vitest'
import { computeRequestDigest } from '../orders/idempotency.js'
import { api, authHeader, createTestProduct, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { prisma } from '../../lib/prisma.js'
import { EMPTY_PRODUCT_DETAILS } from './templates/types.js'

describe('product content snapshot and checkout terms (SPEC-PRODUCT-COMMERCE-002 §3.3)', () => {
  it('keeps the idempotency digest byte-stable when the new term fields are omitted', () => {
    const base = { productId: 42, expectedPrice: 100 }
    expect(computeRequestDigest(base)).toBe(computeRequestDigest({ ...base }))
    expect(computeRequestDigest({
      ...base,
      expectedProductContentVersion: 2,
      expectedAssuranceGrantId: null,
    })).not.toBe(computeRequestDigest(base))
    expect(computeRequestDigest({
      ...base,
      expectedProductContentVersion: 2,
      expectedAssuranceGrantId: 9,
    })).not.toBe(computeRequestDigest({
      ...base,
      expectedProductContentVersion: 2,
      expectedAssuranceGrantId: null,
    }))
  })

  it('previews current content version and freezes a snapshot on order create', async () => {
    const buyer = await createTestUser('content-snapshot@test.local', 'pass123')
    const product = await createTestProduct('条款快照商品', 100, 2, ['SNAP-1', 'SNAP-2'])
    const { accessToken } = await loginAs(buyer.user.email, 'pass123')

    const preview = await api.get('/api/checkout/preview')
      .set(authHeader(accessToken))
      .query({ productId: product.id })
      .expect(200)
    expect(preview.body.productContentVersion).toBe(1)
    expect(preview.body.assuranceGrantId).toBeNull()
    expect(preview.body.productContentSnapshot).toEqual(expect.objectContaining({
      version: 1,
      contentVersion: 1,
      templateKey: null,
      details: EMPTY_PRODUCT_DETAILS,
      assurance: null,
    }))

    const created = await api.post('/api/orders')
      .set(authHeader(accessToken))
      .send({
        productId: product.id,
        offerId: preview.body.offerId,
        expectedPrice: 100,
        expectedCheckoutVersion: preview.body.checkoutVersion,
        expectedProductContentVersion: preview.body.productContentVersion,
        expectedAssuranceGrantId: preview.body.assuranceGrantId,
      })
      .expect(201)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.body.orderId } })
    expect(order.productContentSnapshot).toEqual(preview.body.productContentSnapshot)

    const detail = await api.get(`/api/orders/${created.body.orderId}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(detail.body.productContentSnapshot).toEqual(preview.body.productContentSnapshot)
  })

  it('rejects checkout when content version changes after preview', async () => {
    const buyer = await createTestUser('content-changed@test.local', 'pass123')
    const product = await createTestProduct('条款变更商品', 100, 1, ['CHG-1'])
    const { accessToken } = await loginAs(buyer.user.email, 'pass123')
    const preview = await api.get('/api/checkout/preview')
      .set(authHeader(accessToken))
      .query({ productId: product.id })
      .expect(200)

    await prisma.product.update({
      where: { id: product.id },
      data: { contentVersion: { increment: 1 } },
    })

    const conflict = await api.post('/api/orders')
      .set(authHeader(accessToken))
      .send({
        productId: product.id,
        offerId: preview.body.offerId,
        expectedPrice: 100,
        expectedCheckoutVersion: preview.body.checkoutVersion,
        expectedProductContentVersion: preview.body.productContentVersion,
        expectedAssuranceGrantId: preview.body.assuranceGrantId,
      })
      .expect(409)
    expect(conflict.body.error.code).toBe('CHECKOUT_CHANGED')
  })

  it('rejects a request that sends only one of the new term fields', async () => {
    const buyer = await createTestUser('content-partial@test.local', 'pass123')
    const product = await createTestProduct('条款半套商品', 100, 1, ['HALF-1'])
    const { accessToken } = await loginAs(buyer.user.email, 'pass123')
    const res = await api.post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id, expectedProductContentVersion: 1 })
      .expect(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})
