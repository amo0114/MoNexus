import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { __setExternalCatalogClientOverridesForTests } from './externalCatalog.js'
import type { FakaPlanCatalogItem, FakaTransport } from '../../lib/fakaBridge/types.js'

let catalogPlan: FakaPlanCatalogItem

function transport(): FakaTransport {
  return async () => ({
    status: 200,
    text: JSON.stringify({ success: true, plans: [catalogPlan] }),
    headers: {},
  })
}

async function adminAuth() {
  const { user } = await createTestUser('faka-preview-admin@test.local', 'pass123', 'admin')
  const auth = await loginAs('faka-preview-admin@test.local', 'pass123')
  const category = await prisma.productCategory.findFirstOrThrow({ where: { status: 'active' } })
  await prisma.productCategory.update({ where: { id: category.id }, data: { defaultCoverUrl: '/assets/category-default.webp' } })
  return { user, auth, category }
}

function request(categoryId: number) {
  return {
    planId: 77,
    productName: 'Xboard Gold',
    categoryId,
    cover: { mode: 'category_default' },
    offers: [
      { period: 'monthly', offerName: '月付', pricePoints: 120 },
      { period: 'yearly', offerName: '年付', pricePoints: 999 },
    ],
  }
}

describe('Xboard preview → idempotent confirm (REAL-PG)', () => {
  beforeEach(() => {
    catalogPlan = {
      plan_id: 77,
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
        { period: 'monthly', price: 1, sku_alias: 'plan-77-monthly' },
        { period: 'yearly', price: 1, sku_alias: 'plan-77-yearly' },
      ],
      named_skus: [],
    }
    __setExternalCatalogClientOverridesForTests({
      catalogUrl: 'https://xboard.test/api/plan-catalog',
      secret: 'test-only-secret',
      transport: transport(),
    })
  })

  afterEach(() => __setExternalCatalogClientOverridesForTests())

  it('preview is zero-write and returns sanitized normalized data', async () => {
    const { auth, category } = await adminAuth()
    const before = await Promise.all([
      prisma.product.count(), prisma.offer.count(), prisma.externalCatalogLink.count(), prisma.adminLog.count(),
    ])
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(request(category.id)).expect(200)
    expect(preview.body).toMatchObject({ canConfirm: true, productName: 'Xboard Gold' })
    expect(preview.body.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.body.richDescription).toContain('<h2>套餐</h2>')
    expect(JSON.stringify(preview.body)).not.toContain('credential')
    expect(JSON.stringify(preview.body)).not.toContain('<img')
    expect(await Promise.all([
      prisma.product.count(), prisma.offer.count(), prisma.externalCatalogLink.count(), prisma.adminLog.count(),
    ])).toEqual(before)
  })

  it('confirm creates one platform draft/link atomically and same key replays it', async () => {
    const { user, auth, category } = await adminAuth()
    const body = request(category.id)
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(body).expect(200)
    const confirmBody = { ...body, sourceHash: preview.body.sourceHash }
    const first = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:77:first').send(confirmBody).expect(201)
    const replay = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:77:first').send(confirmBody).expect(200)
    expect(replay.body).toMatchObject({ productId: first.body.productId, replayed: true })

    const product = await prisma.product.findUniqueOrThrow({ where: { id: first.body.productId } })
    expect(product).toMatchObject({ status: 'draft', merchantId: null, imageUrl: '/assets/category-default.webp' })
    expect(product.images).toEqual(['/assets/category-default.webp'])
    expect(product.richDescription).not.toContain('script')
    expect(await prisma.offer.count({ where: { productId: product.id } })).toBe(2)
    const link = await prisma.externalCatalogLink.findUniqueOrThrow({ where: { productId: product.id } })
    expect(link).toMatchObject({ externalProductId: '77', importedByUserId: user.id })
    expect(JSON.stringify(link.sourceSnapshot)).not.toContain('credential')
    expect(await prisma.adminLog.count({ where: { targetType: 'product', targetId: product.id } })).toBe(1)

    await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:77:first')
      .send({ ...confirmBody, productName: 'different' }).expect(409)
    expect(await prisma.product.count()).toBe(1)
  })

  it('rejects a changed source and writes nothing', async () => {
    const { auth, category } = await adminAuth()
    const body = request(category.id)
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(body).expect(200)
    catalogPlan = { ...catalogPlan, content: '<p>changed</p>' }
    const rejected = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:77:changed')
      .send({ ...body, sourceHash: preview.body.sourceHash }).expect(409)
    expect(rejected.body.error.code).toBe('FAKA_SOURCE_CHANGED')
    expect(await prisma.product.count()).toBe(0)
    expect(await prisma.externalCatalogLink.count()).toBe(0)
  })

  it('accepts only an active registered uploaded cover and snapshots its URL', async () => {
    const { auth, category } = await adminAuth()
    await prisma.storedObject.create({
      data: {
        providerConfigId: null,
        providerRef: 'env',
        bucketRole: 'public',
        objectKey: 'xboard-cover.webp',
        status: 'active',
        source: 'upload_image',
      },
    })
    const body = {
      ...request(category.id),
      cover: {
        mode: 'uploaded',
        imageUrl: '/uploads/xboard-cover.webp',
        images: ['/uploads/xboard-cover.webp'],
      },
    }
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(body).expect(200)
    expect(preview.body).toMatchObject({
      canConfirm: true,
      cover: { imageUrl: '/uploads/xboard-cover.webp', images: ['/uploads/xboard-cover.webp'] },
    })
    const created = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:77:uploaded')
      .send({ ...body, sourceHash: preview.body.sourceHash }).expect(201)
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.productId } })
    expect(product.imageUrl).toBe('/uploads/xboard-cover.webp')

    await prisma.storedObject.updateMany({ where: { objectKey: 'xboard-cover.webp' }, data: { status: 'deleted' } })
    const invalidBody = { ...body, planId: 78 }
    catalogPlan = { ...catalogPlan, plan_id: 78 }
    const invalid = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(invalidBody).expect(200)
    expect(invalid.body.canConfirm).toBe(false)
    expect(invalid.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COVER_INVALID' })]))
  })

  it('provider failure during confirm leaves every business table untouched', async () => {
    const { auth, category } = await adminAuth()
    const body = request(category.id)
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(body).expect(200)
    __setExternalCatalogClientOverridesForTests({
      catalogUrl: 'https://xboard.test/api/plan-catalog',
      secret: 'test-only-secret',
      transport: async () => { throw new Error('network unavailable') },
    })
    await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:77:network')
      .send({ ...body, sourceHash: preview.body.sourceHash }).expect(503)
    expect(await prisma.product.count()).toBe(0)
    expect(await prisma.offer.count()).toBe(0)
    expect(await prisma.externalCatalogLink.count()).toBe(0)
    expect(await prisma.adminLog.count()).toBe(0)
  })

  it('uses database uniqueness for concurrent different-key confirms', async () => {
    const { auth, category } = await adminAuth()
    const body = request(category.id)
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(body).expect(200)
    const confirmBody = { ...body, sourceHash: preview.body.sourceHash }
    const responses = await Promise.all([
      api.post('/api/admin/faka/import').set(authHeader(auth.accessToken)).set('Idempotency-Key', 'faka:77:a').send(confirmBody),
      api.post('/api/admin/faka/import').set(authHeader(auth.accessToken)).set('Idempotency-Key', 'faka:77:b').send(confirmBody),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    expect(await prisma.product.count()).toBe(1)
    expect(await prisma.externalCatalogLink.count()).toBe(1)
    expect(await prisma.offer.count()).toBe(2)
  })
})
