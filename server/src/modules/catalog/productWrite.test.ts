import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestMerchant, loginAs } from '../../__tests__/helpers.js'
import { getActiveCategoryIdByLabel } from '../../__tests__/catalogFixture.js'
import { prisma } from '../../lib/prisma.js'
import { EMPTY_PRODUCT_DETAILS } from './templates/types.js'

async function merchantToken(email: string) {
  await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `商家-${email}`,
  })
  const { accessToken } = await loginAs(email, 'pass123')
  return accessToken
}

describe('createProduct v2 (SPEC-PRODUCT-COMMERCE-002 §9.1)', () => {
  it('atomically creates a templated draft with offers and no secret inventory', async () => {
    const token = await merchantToken('v2-create@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const res = await api.post('/api/merchant/products').set(authHeader(token)).send({
      editorVersion: 2,
      templateKey: 'redemption_code',
      templateVersion: 1,
      name: 'V2 卡密草稿',
      categoryId,
      description: '这是用于模板创建路径的简介。',
      richDescription: null,
      descriptionImages: [],
      images: [],
      visibility: 'members_only',
      attributes: { serviceName: '示例软件' },
      details: EMPTY_PRODUCT_DETAILS,
      purchaseForm: [],
      offers: [{
        name: '1 个兑换码',
        price: 100,
        originalPrice: null,
        attributes: { unitLabel: '1 个兑换码' },
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
        validityDays: null,
        fixedContentType: 'text',
        fixedContent: null,
        fixedFileId: null,
        fixedStructuredContent: null,
        deliveryFields: null,
        autoProvision: false,
      }],
    }).expect(201)

    expect(res.body).toEqual(expect.objectContaining({
      status: 'draft',
      contentVersion: 1,
      nextStep: 'availability',
    }))
    expect(res.body.offers).toEqual([
      expect.objectContaining({ name: '1 个兑换码', isDefault: true }),
    ])
    const product = await prisma.product.findUniqueOrThrow({ where: { id: res.body.id } })
    expect(product.templateKey).toBe('redemption_code')
    expect(product.visibility).toBe('members_only')
    expect(product.attributes).toEqual({ serviceName: '示例软件' })
    expect(await prisma.inventoryItem.count({ where: { productId: product.id } })).toBe(0)
    expect(await prisma.offer.count({ where: { productId: product.id } })).toBe(1)
  })

  it('keeps the legacy create DTO as a members_only untemplated draft', async () => {
    const token = await merchantToken('v2-legacy@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const res = await api.post('/api/merchant/products').set(authHeader(token)).send({
      name: '旧入口草稿',
      categoryId,
      price: 80,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
    }).expect(201)
    const product = await prisma.product.findUniqueOrThrow({ where: { id: res.body.id } })
    expect(product.templateKey).toBeNull()
    expect(product.visibility).toBe('members_only')
    expect(product.status).toBe('draft')
  })
})
