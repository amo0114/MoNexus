import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, authHeader, createTestProduct, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { __setExternalCatalogClientOverridesForTests } from './externalCatalog.js'
import { hashSourceDescriptionHtml } from './sourceDescription.js'
import type { FakaPlanCatalogItem, FakaTransport } from '../../lib/fakaBridge/types.js'

let catalogPlan: FakaPlanCatalogItem

function transport(): FakaTransport {
  return async () => ({
    status: 200,
    text: JSON.stringify({ success: true, plans: [catalogPlan] }),
    headers: {},
  })
}

function goldPlan(planId = 81): FakaPlanCatalogItem {
  return {
    plan_id: planId,
    name: 'Gold Plan',
    content: '<h2>套餐</h2><p>安全正文<img src="https://remote.test/x.png"></p><script>credential</script>',
    show: true,
    sell: true,
    renew: true,
    group_id: 1,
    transfer_enable: 0,
    capacity_limit: null,
    active_users: 0,
    remaining: null,
    periods: [
      { period: 'monthly', price: 1, sku_alias: `plan-${planId}-monthly` },
      { period: 'yearly', price: 1, sku_alias: `plan-${planId}-yearly` },
    ],
    named_skus: [],
  }
}

async function adminAuth(email: string) {
  const { user } = await createTestUser(email, 'pass123', 'admin')
  const auth = await loginAs(email, 'pass123')
  const category = await prisma.productCategory.findFirstOrThrow({ where: { status: 'active' } })
  await prisma.productCategory.update({
    where: { id: category.id },
    data: { defaultCoverUrl: '/assets/category-default.webp' },
  })
  return { user, auth, category }
}

function importBody(categoryId: number, planId: number) {
  return {
    planId,
    productName: 'Xboard Gold',
    categoryId,
    cover: { mode: 'category_default' as const },
    offers: [
      { period: 'monthly', offerName: '月付', pricePoints: 120 },
      { period: 'yearly', offerName: '年付', pricePoints: 999 },
    ],
  }
}

async function importPlan(auth: { accessToken: string }, categoryId: number, planId: number) {
  const body = importBody(categoryId, planId)
  const preview = await api.post('/api/admin/faka/import/preview')
    .set(authHeader(auth.accessToken)).send(body).expect(200)
  const created = await api.post('/api/admin/faka/import')
    .set(authHeader(auth.accessToken))
    .set('Idempotency-Key', `faka:${planId}:src-desc`)
    .send({ ...body, sourceHash: preview.body.sourceHash })
    .expect(201)
  return { body, preview, created, productId: created.body.productId as number }
}

describe('Xboard source-description preview/apply (REAL-PG)', () => {
  beforeEach(() => {
    catalogPlan = goldPlan(81)
    __setExternalCatalogClientOverridesForTests({
      catalogUrl: 'https://xboard.test/api/plan-catalog',
      secret: 'test-only-secret',
      transport: transport(),
    })
  })

  afterEach(() => __setExternalCatalogClientOverridesForTests())

  it('hashes empty sanitized HTML as the SHA-256 of an empty string', () => {
    expect(hashSourceDescriptionHtml(null)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(hashSourceDescriptionHtml('')).toBe(hashSourceDescriptionHtml(null))
  })

  it('preview writes nothing and compares against accepted hash', async () => {
    const { auth, category } = await adminAuth('src-desc-preview@test.local')
    const imported = await importPlan(auth, category.id, 81)
    const productBefore = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    const linkBefore = await prisma.externalCatalogLink.findUniqueOrThrow({
      where: { productId: imported.productId },
    })
    const adminLogBefore = await prisma.adminLog.count({
      where: { targetType: 'product', targetId: imported.productId },
    })

    const preview = await api.post(`/api/admin/products/${imported.productId}/source-description/preview`)
      .set(authHeader(auth.accessToken)).expect(200)

    expect(preview.body).toEqual({
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      descriptionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      source: {
        description: expect.any(String),
        richDescription: expect.any(String),
      },
      local: {
        description: productBefore.description,
        richDescription: productBefore.richDescription,
        contentVersion: productBefore.contentVersion,
      },
      changedSinceAccepted: null,
    })
    expect(preview.body.sourceHash).toBe(imported.preview.body.sourceHash)
    expect(preview.body.descriptionHash).toBe(hashSourceDescriptionHtml(preview.body.source.richDescription))
    expect(preview.body.source.richDescription).toContain('<h2>套餐</h2>')
    expect(JSON.stringify(preview.body)).not.toContain('credential')
    expect(JSON.stringify(preview.body)).not.toContain('<img')

    const productAfter = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    const linkAfter = await prisma.externalCatalogLink.findUniqueOrThrow({
      where: { productId: imported.productId },
    })
    expect(productAfter).toMatchObject({
      description: productBefore.description,
      richDescription: productBefore.richDescription,
      contentVersion: productBefore.contentVersion,
    })
    expect(linkAfter).toMatchObject({
      latestDescriptionHash: linkBefore.latestDescriptionHash,
      latestDescriptionHtml: linkBefore.latestDescriptionHtml,
      latestDescriptionText: linkBefore.latestDescriptionText,
      descriptionCheckedAt: linkBefore.descriptionCheckedAt,
      acceptedDescriptionHash: linkBefore.acceptedDescriptionHash,
      sourceHash: linkBefore.sourceHash,
    })
    expect(await prisma.adminLog.count({
      where: { targetType: 'product', targetId: imported.productId },
    })).toBe(adminLogBefore)
  })

  it('apply CAS rejects a stale contentVersion without changing Product copy', async () => {
    const { auth, category } = await adminAuth('src-desc-cas@test.local')
    const imported = await importPlan(auth, category.id, 81)
    const preview = await api.post(`/api/admin/products/${imported.productId}/source-description/preview`)
      .set(authHeader(auth.accessToken)).expect(200)
    const before = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })

    await prisma.product.update({
      where: { id: imported.productId },
      data: { contentVersion: { increment: 1 } },
    })

    const rejected = await api.post(`/api/admin/products/${imported.productId}/source-description/apply`)
      .set(authHeader(auth.accessToken))
      .send({
        sourceHash: preview.body.sourceHash,
        descriptionHash: preview.body.descriptionHash,
        expectedContentVersion: preview.body.local.contentVersion,
        fields: ['description', 'richDescription'],
      })
      .expect(409)
    expect(rejected.body.error.code).toBe('PRODUCT_CONTENT_CHANGED')

    const after = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    expect(after.description).toBe(before.description)
    expect(after.richDescription).toBe(before.richDescription)
    expect(after.contentVersion).toBe(before.contentVersion + 1)
    const link = await prisma.externalCatalogLink.findUniqueOrThrow({
      where: { productId: imported.productId },
    })
    expect(link.acceptedDescriptionHash).toBeNull()
    expect(await prisma.adminLog.count({
      where: { targetType: 'product', targetId: imported.productId, action: '采纳Xboard源介绍' },
    })).toBe(0)
  })

  it('returns 409 FAKA_SOURCE_CHANGED on hash mismatch with zero Product copy change', async () => {
    const { auth, category } = await adminAuth('src-desc-hash@test.local')
    const imported = await importPlan(auth, category.id, 81)
    const preview = await api.post(`/api/admin/products/${imported.productId}/source-description/preview`)
      .set(authHeader(auth.accessToken)).expect(200)
    const before = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    const linkBefore = await prisma.externalCatalogLink.findUniqueOrThrow({
      where: { productId: imported.productId },
    })

    catalogPlan = { ...catalogPlan, content: '<p>changed</p>' }
    const rejected = await api.post(`/api/admin/products/${imported.productId}/source-description/apply`)
      .set(authHeader(auth.accessToken))
      .send({
        sourceHash: preview.body.sourceHash,
        descriptionHash: preview.body.descriptionHash,
        expectedContentVersion: preview.body.local.contentVersion,
        fields: ['description'],
      })
      .expect(409)
    expect(rejected.body.error.code).toBe('FAKA_SOURCE_CHANGED')

    const after = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    expect(after.description).toBe(before.description)
    expect(after.richDescription).toBe(before.richDescription)
    expect(after.contentVersion).toBe(before.contentVersion)
    const linkAfter = await prisma.externalCatalogLink.findUniqueOrThrow({
      where: { productId: imported.productId },
    })
    expect(linkAfter.latestDescriptionHash).toBe(linkBefore.latestDescriptionHash)
    expect(linkAfter.acceptedDescriptionHash).toBe(linkBefore.acceptedDescriptionHash)
    expect(linkAfter.descriptionCheckedAt).toBe(linkBefore.descriptionCheckedAt)
  })

  it('apply overwrites only selected fields, records observation, and never logs HTML', async () => {
    const { auth, category } = await adminAuth('src-desc-apply@test.local')
    const imported = await importPlan(auth, category.id, 81)
    await prisma.product.update({
      where: { id: imported.productId },
      data: {
        description: '本地简介',
        richDescription: '<p>本地正文</p>',
      },
    })
    const preview = await api.post(`/api/admin/products/${imported.productId}/source-description/preview`)
      .set(authHeader(auth.accessToken)).expect(200)
    expect(preview.body.changedSinceAccepted).toBeNull()
    expect(preview.body.local).toMatchObject({
      description: '本地简介',
      richDescription: '<p>本地正文</p>',
    })

    const applied = await api.post(`/api/admin/products/${imported.productId}/source-description/apply`)
      .set(authHeader(auth.accessToken))
      .send({
        sourceHash: preview.body.sourceHash,
        descriptionHash: preview.body.descriptionHash,
        expectedContentVersion: preview.body.local.contentVersion,
        fields: ['description'],
      })
      .expect(200)
    expect(applied.body).toMatchObject({
      id: imported.productId,
      contentVersion: preview.body.local.contentVersion + 1,
      appliedFields: ['description'],
      sourceHash: preview.body.sourceHash,
      descriptionHash: preview.body.descriptionHash,
    })

    const product = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    expect(product.description).toBe(preview.body.source.description)
    expect(product.richDescription).toBe('<p>本地正文</p>')
    expect(product.contentVersion).toBe(preview.body.local.contentVersion + 1)

    const link = await prisma.externalCatalogLink.findUniqueOrThrow({
      where: { productId: imported.productId },
    })
    expect(link.acceptedDescriptionHash).toBe(preview.body.descriptionHash)
    expect(link.latestDescriptionHash).toBe(preview.body.descriptionHash)
    expect(link.latestDescriptionHtml).toBe(preview.body.source.richDescription)
    expect(link.latestDescriptionText).toBe(preview.body.source.description)
    expect(link.descriptionCheckedAt).toBeInstanceOf(Date)

    const logs = await prisma.adminLog.findMany({
      where: { targetType: 'product', targetId: imported.productId, action: '采纳Xboard源介绍' },
    })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.detail).toContain('description')
    expect(logs[0]!.detail).toContain(preview.body.sourceHash)
    expect(logs[0]!.detail).toContain(preview.body.descriptionHash)
    expect(logs[0]!.detail).not.toContain('<h2>')
    expect(logs[0]!.detail).not.toContain('安全正文')
    expect(JSON.stringify(logs[0])).not.toContain('credential')

    const afterApply = await api.post(`/api/admin/products/${imported.productId}/source-description/preview`)
      .set(authHeader(auth.accessToken)).expect(200)
    expect(afterApply.body.changedSinceAccepted).toBe(false)
  })

  it('rejects a product without ExternalCatalogLink with 400', async () => {
    const { auth } = await adminAuth('src-desc-nolink@test.local')
    const product = await createTestProduct('普通商品', 50, 1, ['CODE-1'])
    const rejected = await api.post(`/api/admin/products/${product.id}/source-description/preview`)
      .set(authHeader(auth.accessToken)).expect(400)
    expect(rejected.body.error.message).toContain('Xboard')
  })

  it('does not treat a provider failure as an empty description success', async () => {
    const { auth, category } = await adminAuth('src-desc-provider@test.local')
    const imported = await importPlan(auth, category.id, 81)
    const preview = await api.post(`/api/admin/products/${imported.productId}/source-description/preview`)
      .set(authHeader(auth.accessToken)).expect(200)
    const before = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    __setExternalCatalogClientOverridesForTests({
      catalogUrl: 'https://xboard.test/api/plan-catalog',
      secret: 'test-only-secret',
      transport: async () => { throw new Error('network unavailable') },
    })
    await api.post(`/api/admin/products/${imported.productId}/source-description/apply`)
      .set(authHeader(auth.accessToken))
      .send({
        sourceHash: preview.body.sourceHash,
        descriptionHash: preview.body.descriptionHash,
        expectedContentVersion: preview.body.local.contentVersion,
        fields: ['description', 'richDescription'],
      })
      .expect(503)
    const after = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    expect(after.description).toBe(before.description)
    expect(after.richDescription).toBe(before.richDescription)
    expect(after.contentVersion).toBe(before.contentVersion)
  })
})

describe('Xboard incremental sync observation (REAL-PG)', () => {
  beforeEach(() => {
    catalogPlan = goldPlan(82)
    __setExternalCatalogClientOverridesForTests({
      catalogUrl: 'https://xboard.test/api/plan-catalog',
      secret: 'test-only-secret',
      transport: transport(),
    })
  })

  afterEach(() => __setExternalCatalogClientOverridesForTests())

  it('sync confirm updates latest* but not accepted hash or Product copy', async () => {
    const { auth, category } = await adminAuth('src-desc-sync@test.local')
    const imported = await importPlan(auth, category.id, 82)
    await prisma.product.update({
      where: { id: imported.productId },
      data: {
        description: '本地已编辑简介',
        richDescription: '<p>本地已编辑正文</p>',
      },
    })
    await prisma.externalCatalogLink.update({
      where: { productId: imported.productId },
      data: { acceptedDescriptionHash: 'accepted-sentinel' },
    })

    const preview = await api.post(`/api/admin/products/${imported.productId}/source-description/preview`)
      .set(authHeader(auth.accessToken)).expect(200)
    const syncPreview = await api.post(`/api/admin/products/${imported.productId}/faka-sync/preview`)
      .set(authHeader(auth.accessToken)).expect(200)
    const confirmed = await api.post(`/api/admin/products/${imported.productId}/faka-sync`)
      .set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'sync:src-desc-observe')
      .send({ sourceHash: syncPreview.body.sourceHash, actions: [] })
      .expect(200)
    expect(confirmed.body.replayed).toBe(false)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: imported.productId } })
    expect(product.description).toBe('本地已编辑简介')
    expect(product.richDescription).toBe('<p>本地已编辑正文</p>')

    const link = await prisma.externalCatalogLink.findUniqueOrThrow({
      where: { productId: imported.productId },
    })
    expect(link.acceptedDescriptionHash).toBe('accepted-sentinel')
    expect(link.latestDescriptionHash).toBe(preview.body.descriptionHash)
    expect(link.latestDescriptionHtml).toBe(preview.body.source.richDescription)
    expect(link.latestDescriptionText).toBe(preview.body.source.description)
    expect(link.descriptionCheckedAt).toBeInstanceOf(Date)
    expect(link.sourceHash).toBe(syncPreview.body.sourceHash)
  })
})
