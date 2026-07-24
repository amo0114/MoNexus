import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestMerchant, createTestUser, loginAs, loginAsMerchant } from './helpers.js'

describe('admin product commercial contract', () => {
  it('validates original price against both incoming and persisted sale price, and supports clearing it', async () => {
    const { user: admin } = await createTestUser('product-contract-admin@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs(admin.email, 'admin123')

    const invalidCreate = await api.post('/api/admin/products')
      .set(authHeader(accessToken))
      .send({ name: '倒挂定价', type: '邀请码', price: 200, originalPrice: 100 })
      .expect(400)
    expect(invalidCreate.body.error.code).toBe('VALIDATION_ERROR')

    const created = await api.post('/api/admin/products')
      .set(authHeader(accessToken))
      .send({ name: '正常定价', type: '邀请码', price: 100, originalPrice: 200 })
      .expect(201)

    // Only the sale price is present in this request: service must still use
    // the persisted original price when checking the relationship.
    await api.put(`/api/admin/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ price: 250 })
      .expect(400)

    // Symmetrically, only the original price is supplied here.
    await api.put(`/api/admin/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ originalPrice: 50 })
      .expect(400)

    const cleared = await api.put(`/api/admin/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ originalPrice: null })
      .expect(200)
    expect(cleared.body.originalPrice).toBeNull()
  })

  it('rejects unsupported product types and unsafe image URLs', async () => {
    const { user: admin } = await createTestUser('product-contract-admin-fields@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs(admin.email, 'admin123')

    await api.post('/api/admin/products')
      .set(authHeader(accessToken))
      .send({ name: '未知类型', type: 'not-a-product-type', price: 100 })
      .expect(400)

    await api.post('/api/admin/products')
      .set(authHeader(accessToken))
      .send({ name: '不安全图片', type: '邀请码', price: 100, imageUrl: 'javascript:alert(1)' })
      .expect(400)
  })
})

describe('merchant product commercial contract', () => {
  it('checks price updates against persisted values and keeps the canonical gallery cover in sync', async () => {
    const { merchant } = await createTestMerchant('product-contract-merchant@test.local', 'merchant123', {
      role: 'merchant', status: 'active', name: '字段契约商家',
    })
    const { accessToken } = await loginAsMerchant('product-contract-merchant@test.local', 'merchant123')

    await api.post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '倒挂定价', type: '邀请码', price: 200, originalPrice: 100 })
      .expect(400)

    const firstImage = 'https://cdn.test.local/cover-1.png'
    const secondImage = 'https://cdn.test.local/cover-2.png'
    const thirdImage = 'https://cdn.test.local/cover-3.png'
    const created = await api.post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '商家正常定价',
        type: '邀请码',
        price: 100,
        originalPrice: 200,
        imageUrl: firstImage,
        images: [firstImage, secondImage],
      })
      .expect(201)

    await api.put(`/api/merchant/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ price: 250 })
      .expect(400)

    await api.put(`/api/merchant/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ originalPrice: 50 })
      .expect(400)

    const galleryUpdate = await api.put(`/api/merchant/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ images: [thirdImage, secondImage] })
      .expect(200)
    expect(galleryUpdate.body.imageUrl).toBe(thirdImage)
    expect(galleryUpdate.body.images).toEqual([thirdImage, secondImage])

    await api.put(`/api/merchant/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ imageUrl: firstImage, images: [secondImage] })
      .expect(400)

    const cleared = await api.put(`/api/merchant/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ originalPrice: null })
      .expect(200)
    expect(cleared.body.originalPrice).toBeNull()
    expect(cleared.body.merchantId).toBe(merchant.id)
  })
})
