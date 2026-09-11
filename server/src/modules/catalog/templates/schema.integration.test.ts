import { describe, expect, it } from 'vitest'
import { prisma } from '../../../lib/prisma.js'
import { createTestMerchant, createTestUser } from '../../../__tests__/helpers.js'
import { EMPTY_PRODUCT_DETAILS } from './types.js'
import { getActiveCategoryIdByLabel } from '../../../__tests__/catalogFixture.js'

describe('product commerce v2 schema honesty (SPEC-PRODUCT-COMMERCE-002 §3 / §12.2)', () => {
  it('defaults new products to members_only with empty details and no assurance/snapshot', async () => {
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const product = await prisma.product.create({
      data: { name: '存量形态商品', type: '充值卡密', price: 100, categoryId },
    })
    expect(product.visibility).toBe('members_only')
    expect(product.templateKey).toBeNull()
    expect(product.templateVersion).toBeNull()
    expect(product.attributes).toEqual({})
    expect(product.details).toEqual(EMPTY_PRODUCT_DETAILS)
    expect(product.contentVersion).toBe(1)
    expect(await prisma.productAssuranceGrant.count({ where: { productId: product.id } })).toBe(0)
    expect(await prisma.productShareLink.count({ where: { productId: product.id } })).toBe(0)
  })

  it('rejects mixed template key/version and invalid visibility', async () => {
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    await expect(prisma.product.create({
      data: {
        name: '半套模板',
        type: '充值卡密',
        price: 100,
        categoryId,
        templateKey: 'redemption_code',
      },
    })).rejects.toThrow()
    await expect(prisma.product.create({
      data: {
        name: '非法可见性',
        type: '充值卡密',
        price: 100,
        categoryId,
        visibility: 'password',
      },
    })).rejects.toThrow()
  })

  it('keeps historical delivery-file actors null and requires an owner or uploader', async () => {
    const { merchant, user } = await createTestMerchant()
    const merchantOwned = await prisma.deliveryFile.create({
      data: {
        key: `${'ab'.repeat(16)}.bin`,
        fileName: 'paid.bin',
        size: 10,
        mimeType: 'application/octet-stream',
        sha256: 'ab'.repeat(32),
        merchantId: merchant.id,
      },
    })
    expect(merchantOwned.uploadedByUserId).toBeNull()
    expect(merchantOwned.merchantId).toBe(merchant.id)

    const platformOwned = await prisma.deliveryFile.create({
      data: {
        key: `${'cd'.repeat(16)}.bin`,
        fileName: 'platform.bin',
        size: 10,
        mimeType: 'application/octet-stream',
        sha256: 'cd'.repeat(32),
        merchantId: null,
        uploadedByUserId: user.id,
      },
    })
    expect(platformOwned.merchantId).toBeNull()
    expect(platformOwned.uploadedByUserId).toBe(user.id)

    await expect(prisma.deliveryFile.create({
      data: {
        key: `${'ef'.repeat(16)}.bin`,
        fileName: 'orphan.bin',
        size: 10,
        mimeType: 'application/octet-stream',
        sha256: 'ef'.repeat(32),
        merchantId: null,
        uploadedByUserId: null,
      },
    })).rejects.toThrow()
  })

  it('does not invent order content snapshots for new rows until checkout writes them', async () => {
    const buyer = await createTestUser('snapshot-buyer@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const product = await prisma.product.create({
      data: { name: '快照商品', type: '充值卡密', price: 100, categoryId },
    })
    const offer = await prisma.offer.create({
      data: { productId: product.id, name: '默认规格', isDefault: true, price: 100 },
    })
    const order = await prisma.order.create({
      data: {
        userId: buyer.user.id,
        productId: product.id,
        offerId: offer.id,
        price: 100,
        status: 'delivered',
        deliveryModeSnapshot: 'instant_inventory',
      },
    })
    expect(order.productContentSnapshot).toBeNull()
  })
})
