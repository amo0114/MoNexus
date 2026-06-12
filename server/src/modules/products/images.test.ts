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

    expect(res.body).toMatchObject({ hasMore: false, nextCursor: null })
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].images).toEqual(images)
  })

  it('paginates product list by cursor in stable store order', async () => {
    await prisma.product.createMany({
      data: [
        { name: '热门高销量', type: '网络节点', price: 100, isHot: true, sales: 10 },
        { name: '热门低销量', type: '网络节点', price: 100, isHot: true, sales: 5 },
        { name: '普通高销量', type: '网络节点', price: 100, isHot: false, sales: 100 },
      ],
    })

    const firstPage = await api.get('/api/products').query({ pageSize: 2 }).expect(200)

    expect(firstPage.body.items.map((product: { name: string }) => product.name))
      .toEqual(['热门高销量', '热门低销量'])
    expect(firstPage.body.hasMore).toBe(true)
    expect(firstPage.body.nextCursor).toEqual(expect.any(String))

    const secondPage = await api.get('/api/products')
      .query({ pageSize: 2, cursor: firstPage.body.nextCursor })
      .expect(200)

    expect(secondPage.body.items.map((product: { name: string }) => product.name))
      .toEqual(['普通高销量'])
    expect(secondPage.body.hasMore).toBe(false)
    expect(secondPage.body.nextCursor).toBeNull()
  })

  it('rejects malformed product list cursor', async () => {
    await api.get('/api/products').query({ cursor: 'not-a-valid-cursor' }).expect(400)
  })

  it('includes images in product detail', async () => {
    const product = await prisma.product.create({
      data: { name: '公开详情商品', type: '网络节点', price: 100, images },
    })

    const res = await api.get(`/api/products/${product.id}`).expect(200)

    expect(res.body.images).toEqual(images)
  })
})
