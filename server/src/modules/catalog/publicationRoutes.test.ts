import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  loginAsMerchant,
} from '../../__tests__/helpers.js'

async function merchantToken(email: string): Promise<string> {
  await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `商家-${email}`,
  })
  return (await loginAsMerchant(email, 'pass123')).accessToken
}

const completeDraft = {
  name: '可发布目录商品',
  type: '邀请码',
  price: 50,
  deliveryMode: 'instant_fixed',
  stockMode: 'unlimited',
  fixedContent: 'https://example.com/delivery',
  fixedContentType: 'url',
  imageUrl: 'https://example.com/cover.png',
  images: ['https://example.com/cover.png'],
}

describe('catalog publication routes — real PostgreSQL', () => {
  it('creates a draft, publishes atomically, unpublishes, and preserves first publishedAt', async () => {
    const token = await merchantToken('catalog-publish@test.local')
    const created = await api.post('/api/merchant/products')
      .set(authHeader(token)).send(completeDraft).expect(201)
    expect(created.body.status).toBe('draft')
    expect(created.body.publishedAt).toBeNull()

    const readiness = await api.get(`/api/merchant/products/${created.body.id}/readiness`)
      .set(authHeader(token)).expect(200)
    expect(readiness.body).toEqual({ ready: true, productId: created.body.id, issues: [] })

    const published = await api.post(`/api/merchant/products/${created.body.id}/publish`)
      .set(authHeader(token)).expect(200)
    expect(published.body.status).toBe('active')
    expect(published.body.publishedAt).toEqual(expect.any(String))
    const firstPublishedAt = published.body.publishedAt

    const unpublished = await api.post(`/api/merchant/products/${created.body.id}/unpublish`)
      .set(authHeader(token)).expect(200)
    expect(unpublished.body).toMatchObject({ id: created.body.id, status: 'inactive' })

    const republished = await api.post(`/api/merchant/products/${created.body.id}/publish`)
      .set(authHeader(token)).expect(200)
    expect(republished.body).toMatchObject({
      id: created.body.id,
      status: 'active',
      publishedAt: firstPublishedAt,
    })
  })

  it('returns stable readiness details and leaves an incomplete draft unchanged', async () => {
    const token = await merchantToken('catalog-not-ready@test.local')
    const created = await api.post('/api/merchant/products')
      .set(authHeader(token))
      .send({ ...completeDraft, imageUrl: undefined, images: undefined })
      .expect(201)

    const readiness = await api.get(`/api/merchant/products/${created.body.id}/readiness`)
      .set(authHeader(token)).expect(200)
    expect(readiness.body.ready).toBe(false)
    expect(readiness.body.issues).toContainEqual({
      code: 'COVER_REQUIRED', field: 'images', offerId: null,
    })

    const rejected = await api.post(`/api/merchant/products/${created.body.id}/publish`)
      .set(authHeader(token)).expect(422)
    expect(rejected.body.error.code).toBe('PRODUCT_NOT_READY')
    expect(rejected.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COVER_REQUIRED' }),
    ]))
    expect((await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe('draft')
  })

  it('enforces merchant ownership and strict draft request allowlists', async () => {
    const ownerToken = await merchantToken('catalog-owner@test.local')
    const otherToken = await merchantToken('catalog-other@test.local')
    const created = await api.post('/api/merchant/products')
      .set(authHeader(ownerToken)).send(completeDraft).expect(201)

    await api.get(`/api/merchant/products/${created.body.id}/readiness`)
      .set(authHeader(otherToken)).expect(404)
    await api.post(`/api/merchant/products/${created.body.id}/publish`)
      .set(authHeader(otherToken)).expect(404)

    for (const forbidden of [
      { isHot: true },
      { stock: 10 },
      { status: 'active' },
      { inventoryItems: ['secret-card'] },
    ]) {
      await api.post('/api/merchant/products')
        .set(authHeader(ownerToken))
        .send({ ...completeDraft, name: `非法字段-${Object.keys(forbidden)[0]}`, ...forbidden })
        .expect(400)
    }
  })
})
