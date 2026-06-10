import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api } from '../../__tests__/helpers.js'

const images = ['https://cdn.test.local/pub-1.png', 'https://cdn.test.local/pub-2.png']

describe('Public products API images serialization', () => {
  it('includes images in product list', async () => {
    await prisma.product.create({
      data: { name: '公开多图商品', type: '网络节点', price: 100, images },
    })

    const res = await api.get('/api/products').expect(200)

    expect(res.body).toHaveLength(1)
    expect(res.body[0].images).toEqual(images)
  })

  it('includes images in product detail', async () => {
    const product = await prisma.product.create({
      data: { name: '公开详情商品', type: '网络节点', price: 100, images },
    })

    const res = await api.get(`/api/products/${product.id}`).expect(200)

    expect(res.body.images).toEqual(images)
  })
})
