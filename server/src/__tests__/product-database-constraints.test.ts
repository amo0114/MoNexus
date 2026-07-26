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

// P5 T2：file 形态与签名发放审计的数据库约束。
describe('P5 file-delivery database constraints', () => {
  async function makeFile(merchantId: number, marker: string) {
    return prisma.deliveryFile.create({
      data: {
        key: `${marker.repeat(8).slice(0, 32)}.bin`,
        fileName: 'paid.bin',
        size: 10,
        mimeType: 'application/octet-stream',
        sha256: marker.repeat(16).slice(0, 64),
        merchantId,
      },
    })
  }

  async function makeMerchantWithProduct(suffix: string) {
    const user = await prisma.user.create({
      data: { email: `file-cons-${suffix}@test.local`, password: 'x', role: 'merchant', inviteCode: `FC-${suffix}` },
    })
    const merchant = await prisma.merchant.create({
      data: { userId: user.id, name: `文件约束商家${suffix}`, status: 'active' },
    })
    const product = await prisma.product.create({
      data: { name: `文件约束商品${suffix}`, type: '充值卡密', price: 100, merchantId: merchant.id },
    })
    return { merchant, product }
  }

  it('enforces the file-form invariants on Offer', async () => {
    const { merchant, product } = await makeMerchantWithProduct('a')
    const file = await makeFile(merchant.id, 'a1')

    // file 形态缺 fixedFileId → 拒绝。
    await expect(prisma.offer.create({
      data: {
        productId: product.id, name: '坏文件规格1', price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'file',
      },
    })).rejects.toThrow()

    // file 形态还塞 fixedContent → 拒绝（文件真相源是 fixedFileId）。
    await expect(prisma.offer.create({
      data: {
        productId: product.id, name: '坏文件规格2', price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'file',
        fixedFileId: file.id, fixedContent: 'https://leak.example',
      },
    })).rejects.toThrow()

    // 非 instant_fixed 不能挂 file 形态。
    await expect(prisma.offer.create({
      data: {
        productId: product.id, name: '坏文件规格3', price: 100,
        deliveryMode: 'manual_service', stockMode: 'unlimited', fixedContentType: 'file',
        fixedFileId: file.id,
      },
    })).rejects.toThrow()

    // 非 file 形态不能挂 fixedFileId。
    await expect(prisma.offer.create({
      data: {
        productId: product.id, name: '坏文件规格4', price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContent: '固定文本', fixedFileId: file.id,
      },
    })).rejects.toThrow()

    // 合法 file 形态：instant_fixed + fixedFileId + 空 fixedContent。
    const ok = await prisma.offer.create({
      data: {
        productId: product.id, name: '文件规格', price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContentType: 'file', fixedFileId: file.id,
      },
    })
    expect(ok.fixedFileId).toBe(file.id)

    // 被在售规格引用的文件不可删（RESTRICT）。
    await expect(prisma.deliveryFile.delete({ where: { id: file.id } })).rejects.toThrow()
  })

  it('restricts FileGrantLog role/outcome vocabularies', async () => {
    const { merchant, product } = await makeMerchantWithProduct('b')
    const file = await makeFile(merchant.id, 'b2')
    const buyer = await prisma.user.create({
      data: { email: 'file-cons-buyer@test.local', password: 'x', inviteCode: 'FC-buyer' },
    })
    const order = await prisma.order.create({
      data: { userId: buyer.id, productId: product.id, price: 100 },
    })

    await expect(prisma.fileGrantLog.create({
      data: { fileId: file.id, orderId: order.id, userId: buyer.id, role: 'stranger', outcome: 'granted' },
    })).rejects.toThrow()
    await expect(prisma.fileGrantLog.create({
      data: { fileId: file.id, orderId: order.id, userId: buyer.id, role: 'buyer', outcome: 'maybe' },
    })).rejects.toThrow()

    const ok = await prisma.fileGrantLog.create({
      data: {
        fileId: file.id, orderId: order.id, userId: buyer.id,
        role: 'buyer', outcome: 'granted', expiresAt: new Date(Date.now() + 300_000),
      },
    })
    expect(ok.id).toBeGreaterThan(0)
  })
})
