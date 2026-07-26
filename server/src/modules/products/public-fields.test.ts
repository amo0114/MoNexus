import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api } from '../../__tests__/helpers.js'

describe('public product endpoints with instant_fixed', () => {
  it('never exposes fixedContent and includes stockMode/deliveryMode', async () => {
    const product = await prisma.product.create({
      data: {
        name: '公开字段商品', type: '邀请码', price: 100, stock: 0, status: 'active',
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContent: 'SECRET-PAID-CONTENT', fixedContentType: 'url',
      },
    })

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(JSON.stringify(detail.body)).not.toContain('SECRET-PAID-CONTENT')
    expect(detail.body.stockMode).toBe('unlimited')
    expect(detail.body.deliveryMode).toBe('instant_fixed')

    const list = await api.get('/api/products').expect(200)
    expect(JSON.stringify(list.body)).not.toContain('SECRET-PAID-CONTENT')
  })

  it('derives instant inventory stock from available InventoryItem rows, not Product.stock', async () => {
    const product = await prisma.product.create({
      data: {
        name: '库存真相商品', type: '充值卡密', price: 100, stock: 99, status: 'active',
        deliveryMode: 'instant_inventory', stockMode: 'limited',
      },
    })
    const offer = await prisma.offer.create({
      data: { productId: product.id, name: '默认规格', isDefault: true, price: 100, stock: 99 },
    })
    await prisma.inventoryItem.createMany({
      data: [
        { productId: product.id, offerId: offer.id, content: 'AVAILABLE-1', status: 'available' },
        { productId: product.id, offerId: offer.id, content: 'AVAILABLE-2', status: 'available' },
        { productId: product.id, offerId: offer.id, content: 'VOID-1', status: 'void' },
      ],
    })

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(detail.body.stock).toBe(2)

    const list = await api.get('/api/products').expect(200)
    const listed = list.body.items.find((item: { id: number }) => item.id === product.id)
    expect(listed?.stock).toBe(2)
  })
})
