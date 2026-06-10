import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  createTestMerchant,
  loginAsMerchant,
  authHeader,
} from '../../__tests__/helpers.js'

async function setupMerchant(email: string) {
  const { merchant } = await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: '多图商家',
  })
  const { accessToken } = await loginAsMerchant(email, 'pass123')
  return { merchant, accessToken }
}

const validImages = [
  'https://cdn.test.local/img-1.png',
  'https://cdn.test.local/img-2.png',
  '/uploads/local-key.webp',
]

describe('Merchant product images', () => {
  it('creates product with images and returns them in list', async () => {
    const { accessToken } = await setupMerchant('images-create@test.local')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '多图商品',
        type: '网络节点',
        price: 100,
        imageUrl: validImages[0],
        images: validImages,
      })
      .expect(201)

    expect(created.body.images).toEqual(validImages)

    const listed = await api
      .get('/api/merchant/products')
      .set(authHeader(accessToken))
      .expect(200)

    expect(listed.body.items).toHaveLength(1)
    expect(listed.body.items[0].images).toEqual(validImages)
  })

  it('defaults images to empty array when not provided', async () => {
    const { accessToken } = await setupMerchant('images-default@test.local')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '无图商品', type: '网络节点', price: 100 })
      .expect(201)

    expect(created.body.images).toEqual([])
  })

  it('updates product images', async () => {
    const { merchant, accessToken } = await setupMerchant('images-update@test.local')
    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        name: '待更新商品',
        type: '网络节点',
        price: 100,
        images: [validImages[0]],
      },
    })

    const updated = await api
      .put(`/api/merchant/products/${product.id}`)
      .set(authHeader(accessToken))
      .send({ images: [validImages[1], validImages[2]] })
      .expect(200)

    expect(updated.body.images).toEqual([validImages[1], validImages[2]])
  })

  it('rejects more than 6 images', async () => {
    const { accessToken } = await setupMerchant('images-toomany@test.local')
    const tooMany = Array.from({ length: 7 }, (_, i) => `https://cdn.test.local/img-${i}.png`)

    const res = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '超图商品', type: '网络节点', price: 100, images: tooMany })
      .expect(400)

    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects empty or non-url image entries', async () => {
    const { accessToken } = await setupMerchant('images-invalid@test.local')

    for (const images of [[''], ['   '], ['not-a-url']]) {
      const res = await api
        .post('/api/merchant/products')
        .set(authHeader(accessToken))
        .send({ name: '坏图商品', type: '网络节点', price: 100, images })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    }
  })
})
