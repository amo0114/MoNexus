import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api } from '../../__tests__/helpers.js'
import { getActiveCategoryIdByLabel } from '../../__tests__/catalogFixture.js'

describe('public product endpoints with instant_fixed', () => {
  it('never exposes fixedContent and includes stockMode/deliveryMode', async () => {
    const product = await prisma.product.create({
      data: {
        name: '公开字段商品', type: '邀请码', price: 100, stock: 0, status: 'active',
        visibility: 'public',
        categoryId: await getActiveCategoryIdByLabel('邀请码'),
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
        visibility: 'public',
        categoryId: await getActiveCategoryIdByLabel('充值卡密'),
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

  it('projects registry attributes/details on detail and template fields on list, without secrets', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const product = await prisma.product.create({
      data: {
        name: '模板投影商品',
        type: '邀请码',
        price: 100,
        stock: 0,
        status: 'active',
        visibility: 'public',
        categoryId,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        templateKey: 'redemption_code',
        templateVersion: 1,
        contentVersion: 4,
        attributes: {
          serviceName: 'Steam',
          region: '全球',
          redemptionMethod: '官网兑换',
          secretNote: 'LEAK-ME-ATTR',
        },
        details: {
          highlights: ['参数清晰', '订单内交付'],
          usageInstructions: '兑换后在订单详情查看。',
          purchaseNotes: '兑换前请确认适用地区。',
          afterSalesInstructions: '订单问题请提交售后工单。',
          faq: [{ question: '如何兑换？', answer: '在订单页查看卡密。' }],
          extraSecret: 'LEAK-ME-DETAILS',
        },
        fixedContent: 'SECRET-PAID-CONTENT',
        fixedContentType: 'url',
      },
    })
    await prisma.offer.create({
      data: {
        productId: product.id,
        name: '月卡',
        isDefault: true,
        price: 100,
        stock: 0,
        stockMode: 'unlimited',
        deliveryMode: 'instant_fixed',
        attributes: {
          unitLabel: '月卡',
          faceValueLabel: '30天',
          internalSku: 'LEAK-ME-OFFER',
        },
        fixedContent: 'SECRET-OFFER-CONTENT',
        fixedStructuredContent: { fields: [], values: { password: 'LEAK-STRUCTURED' } },
      },
    })

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(detail.body.templateKey).toBe('redemption_code')
    expect(detail.body.templateVersion).toBe(1)
    expect(detail.body.visibility).toBe('public')
    expect(detail.body.contentVersion).toBe(4)
    expect(detail.body.attributes).toEqual({
      serviceName: 'Steam',
      region: '全球',
      redemptionMethod: '官网兑换',
    })
    expect(detail.body.details).toEqual({
      highlights: ['参数清晰', '订单内交付'],
      usageInstructions: '兑换后在订单详情查看。',
      purchaseNotes: '兑换前请确认适用地区。',
      afterSalesInstructions: '订单问题请提交售后工单。',
      faq: [{ question: '如何兑换？', answer: '在订单页查看卡密。' }],
    })
    expect(detail.body.offers).toHaveLength(1)
    expect(detail.body.offers[0].attributes).toEqual({
      unitLabel: '月卡',
      faceValueLabel: '30天',
    })
    expect(detail.body.offers[0].fixedContent).toBeUndefined()
    expect(detail.body.offers[0].fixedStructuredContent).toBeUndefined()
    expect(detail.body.fixedContent).toBeUndefined()
    expect(detail.body.descriptionImages).toBeUndefined()
    expect(detail.body.sourceDescription).toBeUndefined()

    const detailJson = JSON.stringify(detail.body)
    expect(detailJson).not.toContain('SECRET-PAID-CONTENT')
    expect(detailJson).not.toContain('SECRET-OFFER-CONTENT')
    expect(detailJson).not.toContain('LEAK-ME-ATTR')
    expect(detailJson).not.toContain('LEAK-ME-DETAILS')
    expect(detailJson).not.toContain('LEAK-ME-OFFER')
    expect(detailJson).not.toContain('LEAK-STRUCTURED')
    expect(detailJson).not.toContain('fixedStructuredContent')
    expect(detailJson).not.toContain('descriptionImages')

    const list = await api.get('/api/products').expect(200)
    const listed = list.body.items.find((item: { id: number }) => item.id === product.id)
    expect(listed).toMatchObject({
      id: product.id,
      templateKey: 'redemption_code',
      templateVersion: 1,
      visibility: 'public',
    })
    expect(listed.attributes).toBeUndefined()
    expect(listed.details).toBeUndefined()
    expect(listed.contentVersion).toBeUndefined()
    expect(listed.offers).toBeUndefined()
    const listJson = JSON.stringify(list.body)
    expect(listJson).not.toContain('SECRET-PAID-CONTENT')
    expect(listJson).not.toContain('LEAK-ME-ATTR')
    expect(listJson).not.toContain('LEAK-STRUCTURED')
  })

  it('returns empty attributes when the template is unknown and does not invent fields', async () => {
    const product = await prisma.product.create({
      data: {
        name: '未知模板商品',
        type: '邀请码',
        price: 80,
        stock: 0,
        status: 'active',
        visibility: 'public',
        categoryId: await getActiveCategoryIdByLabel('邀请码'),
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        templateKey: null,
        templateVersion: null,
        attributes: { serviceName: 'ShouldOmit', leaked: 'LEAK-UNKNOWN' },
        details: {
          highlights: [],
          usageInstructions: '',
          purchaseNotes: '',
          afterSalesInstructions: '',
          faq: [],
        },
        fixedContent: 'SECRET-UNKNOWN-TEMPLATE',
      },
    })
    await prisma.offer.create({
      data: {
        productId: product.id,
        name: '默认规格',
        isDefault: true,
        price: 80,
        stock: 0,
        stockMode: 'unlimited',
        deliveryMode: 'instant_fixed',
        attributes: { unitLabel: 'ShouldOmitOffer', leaked: 'LEAK-UNKNOWN-OFFER' },
      },
    })

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(detail.body.templateKey).toBeNull()
    expect(detail.body.attributes).toEqual({})
    expect(detail.body.offers[0].attributes).toEqual({})
    const payload = JSON.stringify(detail.body)
    expect(payload).not.toContain('ShouldOmit')
    expect(payload).not.toContain('LEAK-UNKNOWN')
    expect(payload).not.toContain('SECRET-UNKNOWN-TEMPLATE')
  })
})
