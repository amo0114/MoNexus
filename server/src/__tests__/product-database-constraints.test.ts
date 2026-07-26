import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'

describe('Product and InventoryItem database constraints', () => {
  it('rejects invalid product commercial values and finite state values', async () => {
    const invalidProducts = [
      { name: '零价格', type: '充值卡密', price: 0 },
      { name: '倒挂原价', type: '充值卡密', price: 100, originalPrice: 99 },
      { name: '负库存', type: '充值卡密', price: 100, stock: -1 },
      { name: '负销量', type: '充值卡密', price: 100, sales: -1 },
      { name: '非法上下架状态', type: '充值卡密', price: 100, status: 'archived' },
      { name: '非法履约方式', type: '充值卡密', price: 100, deliveryMode: 'scheduled' },
      { name: '非法库存方式', type: '充值卡密', price: 100, stockMode: 'reserved' },
      { name: '非法固定内容类型', type: '充值卡密', price: 100, fixedContentType: 'html' },
      {
        name: '即时库存不能不限量', type: '充值卡密', price: 100,
        deliveryMode: 'instant_inventory', stockMode: 'unlimited',
      },
    ]

    for (const data of invalidProducts) {
      await expect(prisma.product.create({ data })).rejects.toThrow()
    }
  })

  it('rejects an inventory item with an invalid lifecycle state', async () => {
    const product = await prisma.product.create({
      data: { name: '库存状态约束商品', type: '充值卡密', price: 100 },
    })
    const offer = await prisma.offer.create({
      data: { productId: product.id, name: '默认规格', isDefault: true, price: 100 },
    })

    await expect(prisma.inventoryItem.create({
      data: { productId: product.id, offerId: offer.id, content: 'INVALID-STATUS-CARD', status: 'reserved' },
    })).rejects.toThrow()
  })

  it('enforces auditable inventory movement semantics at the database layer', async () => {
    const product = await prisma.product.create({
      data: { name: '库存流水约束商品', type: '充值卡密', price: 100 },
    })

    await expect(prisma.inventoryLog.create({
      data: { productId: product.id, actorUserId: 1, action: 'import', delta: 1 },
    })).rejects.toThrow()
    await expect(prisma.inventoryLog.create({
      data: {
        productId: product.id,
        actorUserId: 1,
        action: 'void',
        delta: 1,
        batchId: '11111111-1111-4111-8111-111111111111',
      },
    })).rejects.toThrow()
    await expect(prisma.inventoryLog.create({
      data: { productId: product.id, actorUserId: 1, action: 'sale', delta: -1 },
    })).rejects.toThrow()
  })
})
