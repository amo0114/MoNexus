import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestMerchant, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { getActiveCategoryIdByLabel } from '../../__tests__/catalogFixture.js'
import { computeOfferCheckoutVersion } from '../../lib/offers.js'
import { prisma } from '../../lib/prisma.js'
import { EMPTY_PRODUCT_DETAILS } from './templates/types.js'

let mediaSerial = 0
function uniqueObjectKey(prefix: string): string {
  mediaSerial += 1
  return `${prefix}-${Date.now()}-${mediaSerial}.webp`
}

async function seedStoredObject(objectKey: string, source = 'upload_image') {
  await prisma.storedObject.create({
    data: {
      providerConfigId: null,
      providerRef: 'env',
      bucketRole: 'public',
      objectKey,
      status: 'active',
      source,
    },
  })
}

function canonicalUploadUrl(objectKey: string): string {
  return `http://localhost:3000/uploads/${objectKey}`
}

const publishableDetails = {
  ...EMPTY_PRODUCT_DETAILS,
  purchaseNotes: '购买前请确认适用地区与兑换方式。',
  afterSalesInstructions: '订单问题请提交售后工单。',
}

async function merchantToken(email: string) {
  await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `商家-${email}`,
  })
  const { accessToken } = await loginAs(email, 'pass123')
  return accessToken
}

async function merchantSetup(email: string) {
  const { merchant } = await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `商家-${email}`,
  })
  const { accessToken } = await loginAs(email, 'pass123')
  return { token: accessToken, merchantId: merchant.id }
}

async function seedDeliveryFile(merchantId: number | null, marker: string, status = 'active') {
  const hex = Buffer.from(marker).toString('hex').padEnd(64, '0').slice(0, 64)
  return prisma.deliveryFile.create({
    data: {
      key: `${hex}.bin`,
      fileName: `${marker}.bin`,
      size: 10,
      mimeType: 'application/octet-stream',
      sha256: hex,
      merchantId,
      status,
    },
  })
}

function inventoryOffer() {
  return {
    name: '1 个兑换码',
    price: 100,
    originalPrice: null,
    attributes: { unitLabel: '1 个兑换码' },
    deliveryMode: 'instant_inventory' as const,
    stockMode: 'limited' as const,
    validityDays: null,
    fixedContentType: 'text' as const,
    fixedContent: null,
    fixedFileId: null,
    fixedStructuredContent: null,
    deliveryFields: null,
    autoProvision: false,
  }
}

function v2RedemptionBody(categoryId: number, overrides: Record<string, unknown> = {}) {
  return {
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
    offers: [inventoryOffer()],
    ...overrides,
  }
}

function v2DigitalFileBody(categoryId: number, fixedFileId: number | null, name: string) {
  return {
    editorVersion: 2,
    templateKey: 'digital_file',
    templateVersion: 1,
    name,
    categoryId,
    description: '这是用于模板创建路径的简介。',
    richDescription: null,
    descriptionImages: [],
    images: [],
    visibility: 'members_only',
    attributes: { contentCategory: '文档' },
    details: EMPTY_PRODUCT_DETAILS,
    purchaseForm: [],
    offers: [{
      name: '文件版',
      price: 100,
      originalPrice: null,
      attributes: { releaseVersion: '1.0' },
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      validityDays: null,
      fixedContentType: 'file',
      fixedContent: null,
      fixedFileId,
      fixedStructuredContent: null,
      deliveryFields: null,
      autoProvision: false,
    }],
  }
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

  it('patches content with CAS and serves an editor DTO', async () => {
    const token = await merchantToken('v2-patch@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send({
      editorVersion: 2,
      templateKey: 'redemption_code',
      templateVersion: 1,
      name: '待编辑草稿',
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

    const editor = await api.get(`/api/merchant/products/${created.body.id}/editor`)
      .set(authHeader(token))
      .expect(200)
    expect(editor.body.product.contentVersion).toBe(1)
    expect(editor.body.capabilities.editContent).toBe(true)
    expect(editor.body.offers[0].isDefault).toBe(true)
    const offerRow = await prisma.offer.findFirstOrThrow({ where: { productId: created.body.id } })
    expect(editor.body.offers[0].checkoutVersion).toBe(computeOfferCheckoutVersion(offerRow))

    const patched = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: 1,
        name: '已改名草稿',
        details: { ...EMPTY_PRODUCT_DETAILS, purchaseNotes: '购买须知示例' },
      })
      .expect(200)
    expect(patched.body.contentVersion).toBe(2)
    expect(patched.body.updatedFields).toEqual(expect.arrayContaining(['name', 'details']))

    const conflict = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({ expectedContentVersion: 1, name: '冲突写入' })
      .expect(409)
    expect(conflict.body.error.code).toBe('PRODUCT_CONTENT_CHANGED')

    const [first, second] = await Promise.all([
      api.patch(`/api/merchant/products/${created.body.id}/content`)
        .set(authHeader(token))
        .send({ expectedContentVersion: 2, description: '并发一' }),
      api.patch(`/api/merchant/products/${created.body.id}/content`)
        .set(authHeader(token))
        .send({ expectedContentVersion: 2, description: '并发二' }),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
  })

  it('rejects merchant A binding merchant B delivery file on v2 create', async () => {
    const ownerA = await merchantSetup('v2-file-owner-a@test.local')
    const ownerB = await merchantSetup('v2-file-owner-b@test.local')
    const foreignFile = await seedDeliveryFile(ownerB.merchantId, 'v2-file-b')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')

    const denied = await api.post('/api/merchant/products')
      .set(authHeader(ownerA.token))
      .send(v2DigitalFileBody(categoryId, foreignFile.id, '越权文件草稿'))
      .expect(404)
    expect(denied.body.error.message).toBe('交付文件不存在')
    expect(await prisma.product.count({
      where: { merchantId: ownerA.merchantId, name: '越权文件草稿' },
    })).toBe(0)
  })

  it('rejects a revoked delivery file on v2 create without enumerating it as missing', async () => {
    const owner = await merchantSetup('v2-file-revoked@test.local')
    const revoked = await seedDeliveryFile(owner.merchantId, 'v2-file-revoked', 'revoked')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')

    const denied = await api.post('/api/merchant/products')
      .set(authHeader(owner.token))
      .send(v2DigitalFileBody(categoryId, revoked.id, '吊销文件草稿'))
      .expect(400)
    expect(denied.body.error.message).toBe('交付文件已不可用，请重新上传')
  })

  it('persists resolved description images and strips remote ones on v2 create and content patch', async () => {
    const token = await merchantToken('v2-rich-img@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const objectKey = uniqueObjectKey('v2-rich-local')
    await seedStoredObject(objectKey)
    const clientSrc = `/uploads/${objectKey}`
    const canonicalSrc = canonicalUploadUrl(objectKey)
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send(v2RedemptionBody(categoryId, {
      name: '图文草稿',
      richDescription: `<p>介绍<img src="${clientSrc}" alt="样图"><img src="https://evil.test/a.png" onerror="steal()"></p>`,
      descriptionImages: [{ src: clientSrc, ref: { kind: 'upload', objectKey } }],
    })).expect(201)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(product.richDescription).toContain(`<img src="${canonicalSrc}"`)
    expect(product.richDescription?.toLowerCase()).not.toContain('evil.test')

    const editor = await api.get(`/api/merchant/products/${created.body.id}/editor`)
      .set(authHeader(token))
      .expect(200)
    expect(editor.body.product.descriptionImages).toEqual([
      { src: canonicalSrc, ref: { kind: 'upload', objectKey } },
    ])

    const patched = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: 1,
        richDescription: `<p>更新<img src="${clientSrc}" alt="样图"><img src="https://evil.test/b.png"></p>`,
        descriptionImages: [{ src: clientSrc, ref: { kind: 'upload', objectKey } }],
      })
      .expect(200)
    expect(patched.body.updatedFields).toEqual(expect.arrayContaining(['richDescription']))
    const after = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(after.richDescription).toContain(`<img src="${canonicalSrc}"`)
    expect(after.richDescription?.toLowerCase()).not.toContain('evil.test')
  })

  it('drops description images whose objectKey is missing, wrong source, or a fake key with an evil src', async () => {
    const token = await merchantToken('v2-rich-img-untrusted@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const missingKey = uniqueObjectKey('v2-rich-missing')
    const wrongSourceKey = uniqueObjectKey('v2-rich-wrong-source')
    await seedStoredObject(wrongSourceKey, 'delivery_file')
    const fakeKey = uniqueObjectKey('v2-rich-fake')
    const evilSrc = 'https://evil.example/x.png'

    const created = await api.post('/api/merchant/products').set(authHeader(token)).send(v2RedemptionBody(categoryId, {
      name: '不可信图文草稿',
      richDescription: `<p>介绍<img src="/uploads/${missingKey}"><img src="/uploads/${wrongSourceKey}"><img src="${evilSrc}"></p>`,
      descriptionImages: [
        { src: `/uploads/${missingKey}`, ref: { kind: 'upload', objectKey: missingKey } },
        { src: `/uploads/${wrongSourceKey}`, ref: { kind: 'upload', objectKey: wrongSourceKey } },
        { src: evilSrc, ref: { kind: 'upload', objectKey: fakeKey } },
      ],
    })).expect(201)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(product.richDescription ?? '').not.toContain('<img')
    expect(product.richDescription ?? '').not.toContain('evil.example')
    expect(product.richDescription ?? '').not.toContain(missingKey)
    expect(product.richDescription ?? '').not.toContain(wrongSourceKey)

    const patched = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: 1,
        richDescription: `<p>更新<img src="${evilSrc}"></p>`,
        descriptionImages: [{ src: evilSrc, ref: { kind: 'upload', objectKey: fakeKey } }],
      })
      .expect(200)
    const after = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(after.richDescription ?? '').not.toContain('<img')
    expect(after.richDescription ?? '').not.toContain('evil.example')
  })

  it('assigns a template on an untemplated draft and then refuses to change it', async () => {
    const token = await merchantToken('v2-template-patch@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send({
      name: '待补齐形态草稿',
      categoryId,
      price: 80,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
    }).expect(201)

    const assigned = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: 1,
        templateKey: 'redemption_code',
        templateVersion: 1,
        attributes: { serviceName: '示例软件' },
      })
      .expect(200)
    expect(assigned.body.updatedFields).toEqual(expect.arrayContaining(['templateKey', 'templateVersion', 'attributes']))
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(product.templateKey).toBe('redemption_code')
    expect(product.templateVersion).toBe(1)
    expect(product.attributes).toEqual({ serviceName: '示例软件' })

    const missingPair = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({ expectedContentVersion: assigned.body.contentVersion, templateKey: 'digital_file' })
      .expect(400)
    expect(missingPair.body.error.code).toBe('VALIDATION_ERROR')

    const locked = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: assigned.body.contentVersion,
        templateKey: 'digital_file',
        templateVersion: 1,
      })
      .expect(400)
    expect(locked.body.error.code).toBe('PRODUCT_TEMPLATE_LOCKED')
    expect(locked.body.error.message).toBe('商品形态一经设定不可更换')
  })

  it('leaves attributes empty when assigning a template without attributes', async () => {
    const token = await merchantToken('v2-template-empty-attr@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send({
      name: '空参数补齐草稿',
      categoryId,
      price: 80,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
    }).expect(201)

    await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: 1,
        templateKey: 'redemption_code',
        templateVersion: 1,
      })
      .expect(200)
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(product.templateKey).toBe('redemption_code')
    expect(product.attributes).toEqual({})
  })

  it('refuses to assign a template on an active product', async () => {
    const token = await merchantToken('v2-template-active@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send({
      name: '在售待补齐形态',
      categoryId,
      price: 80,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
    }).expect(201)

    await prisma.product.update({ where: { id: created.body.id }, data: { status: 'active' } })

    const denied = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: 1,
        templateKey: 'redemption_code',
        templateVersion: 1,
        attributes: { serviceName: '示例软件' },
      })
      .expect(400)
    expect(denied.body.error.code).toBe('PRODUCT_TEMPLATE_LOCKED')
    expect(denied.body.error.message).toBe('在售商品不能补齐形态')
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(product.templateKey).toBeNull()
    expect(product.contentVersion).toBe(1)
  })

  it('refuses to assign a template when existing offers are incompatible', async () => {
    const token = await merchantToken('v2-template-incompat@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send({
      name: '履约不相容草稿',
      categoryId,
      price: 80,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
    }).expect(201)
    const offer = await prisma.offer.findFirstOrThrow({ where: { productId: created.body.id } })

    const denied = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: 1,
        templateKey: 'digital_file',
        templateVersion: 1,
      })
      .expect(400)
    expect(denied.body.error.code).toBe('PRODUCT_TEMPLATE_INVALID')
    expect(denied.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: `/offers/${offer.id}` }),
    ]))
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(product.templateKey).toBeNull()
    expect(product.contentVersion).toBe(1)
  })

  it('refuses to assign a template when an offer has an open FakaBridge task', async () => {
    const owner = await merchantSetup('v2-template-faka@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const created = await api.post('/api/merchant/products').set(authHeader(owner.token)).send({
      name: '有未结任务草稿',
      categoryId,
      price: 80,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
    }).expect(201)
    const offer = await prisma.offer.findFirstOrThrow({ where: { productId: created.body.id } })
    const { user } = await createTestUser('v2-template-faka-buyer@test.local')
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        productId: created.body.id,
        offerId: offer.id,
        price: 80,
        status: 'pending',
        merchantId: owner.merchantId,
        deliveryModeSnapshot: 'instant_inventory',
        productNameSnapshot: '有未结任务草稿',
        holdingPoints: 80,
        fundsHeld: true,
      },
    })
    await prisma.fakaBridgeTask.create({
      data: {
        orderId: order.id,
        requestOrderNo: `MN-${order.id}`,
        emailSnapshot: user.email,
        skuSnapshot: 'test-sku',
        periodSnapshot: 'monthly',
        status: 'pending',
      },
    })

    const denied = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(owner.token))
      .send({
        expectedContentVersion: 1,
        templateKey: 'redemption_code',
        templateVersion: 1,
      })
      .expect(400)
    expect(denied.body.error.code).toBe('FAKA_OPEN_TASK')
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(product.templateKey).toBeNull()
    expect(product.contentVersion).toBe(1)
  })

  it('rejects clearing purchaseNotes on an active templated product and leaves the row unchanged', async () => {
    const token = await merchantToken('v2-active-notes@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const coverKey = uniqueObjectKey('v2-active-cover')
    await seedStoredObject(coverKey)
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send(v2RedemptionBody(categoryId, {
      name: '在售须知商品',
      attributes: { serviceName: '示例软件', redemptionMethod: '在软件的兑换入口输入卡密。' },
      details: publishableDetails,
      images: [{ kind: 'upload', objectKey: coverKey }],
    })).expect(201)
    const offer = await prisma.offer.findFirstOrThrow({ where: { productId: created.body.id } })
    await prisma.inventoryItem.create({
      data: {
        productId: created.body.id,
        offerId: offer.id,
        content: `code-active-notes-${created.body.id}`,
        status: 'available',
      },
    })
    await api.post(`/api/merchant/products/${created.body.id}/publish`)
      .set(authHeader(token))
      .expect(200)

    const before = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(before.status).toBe('active')
    expect(before.contentVersion).toBe(1)

    const denied = await api.patch(`/api/merchant/products/${created.body.id}/content`)
      .set(authHeader(token))
      .send({
        expectedContentVersion: 1,
        details: { ...publishableDetails, purchaseNotes: '' },
      })
      .expect(422)
    expect(denied.body.error.code).toBe('PRODUCT_NOT_READY')
    expect(denied.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PURCHASE_NOTES_REQUIRED' }),
    ]))

    const after = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(after.contentVersion).toBe(before.contentVersion)
    expect(after.details).toEqual(before.details)
    expect(after.status).toBe('active')
  })
})
