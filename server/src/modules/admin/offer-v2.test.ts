import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs } from '../../__tests__/helpers.js'

async function adminAuth(email: string) {
  const { user } = await createTestUser(email, 'admin123', 'admin')
  const auth = await loginAs(email, 'admin123')
  return { user, auth }
}

function platformOfferBody(overrides: Record<string, unknown> = {}) {
  return {
    name: '平台规格',
    price: 100,
    originalPrice: null,
    attributes: {},
    deliveryMode: 'instant_fixed',
    stockMode: 'unlimited',
    validityDays: 30,
    fixedContentType: 'text',
    fixedContent: 'FIXED-TEXT',
    fixedFileId: null,
    fixedStructuredContent: null,
    deliveryFields: null,
    autoProvision: false,
    ...overrides,
  }
}

describe('admin platform offer v2 write (REAL-PG)', () => {
  it('patchAdminOffer persists fixedFileId and fixedContent for a platform-owned product', async () => {
    const { user, auth } = await adminAuth('offer-v2-admin@test.local')
    const created = await api.post('/api/admin/products').set(authHeader(auth.accessToken))
      .send({ name: '平台履约商品', type: '邀请码', price: 50 }).expect(201)
    const offer = await prisma.offer.findFirstOrThrow({ where: { productId: created.body.id, isDefault: true } })

    const textPatched = await api.patch(`/api/admin/products/${created.body.id}/offers/${offer.id}`)
      .set(authHeader(auth.accessToken))
      .send({
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContentType: 'text',
        fixedContent: 'PLATFORM-TEXT',
        fixedFileId: null,
      })
      .expect(200)
    expect(textPatched.body.fixedContentType).toBe('text')
    const afterText = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })
    expect(afterText.deliveryMode).toBe('instant_fixed')
    expect(afterText.fixedContent).toBe('PLATFORM-TEXT')
    expect(afterText.fixedFileId).toBeNull()

    const file = await prisma.deliveryFile.create({
      data: {
        key: `platform-offer-${offer.id}.bin`,
        fileName: 'pack.zip',
        size: 12,
        mimeType: 'application/zip',
        sha256: 'a'.repeat(64),
        merchantId: null,
        uploadedByUserId: user.id,
        status: 'active',
      },
    })
    await api.patch(`/api/admin/products/${created.body.id}/offers/${offer.id}`)
      .set(authHeader(auth.accessToken))
      .send({
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContentType: 'file',
        fixedContent: null,
        fixedFileId: file.id,
      })
      .expect(200)
    const afterFile = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })
    expect(afterFile.fixedContentType).toBe('file')
    expect(afterFile.fixedFileId).toBe(file.id)
    expect(afterFile.fixedContent).toBeNull()
  })

  it('createPlatformOffer rejects merchant-owned products', async () => {
    const { auth } = await adminAuth('offer-v2-merchant-admin@test.local')
    const { merchant } = await createTestMerchant('offer-v2-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const product = await createTestProduct('商家商品', 80, 1, ['sku-1'], merchant.id)
    const rejected = await api.post(`/api/admin/products/${product.id}/offers`)
      .set(authHeader(auth.accessToken))
      .send(platformOfferBody())
      .expect(400)
    expect(rejected.body.error.message).toContain('平台自营')
  })

  it('createPlatformOffer cannot enable autoProvision', async () => {
    const { auth } = await adminAuth('offer-v2-autoprov@test.local')
    const created = await api.post('/api/admin/products').set(authHeader(auth.accessToken))
      .send({ name: '禁止自动开通', type: '邀请码', price: 40 }).expect(201)
    const rejected = await api.post(`/api/admin/products/${created.body.id}/offers`)
      .set(authHeader(auth.accessToken))
      .send(platformOfferBody({ autoProvision: true }))
      .expect(400)
    expect(rejected.body.error.message).toContain('自动开通')
  })
})
