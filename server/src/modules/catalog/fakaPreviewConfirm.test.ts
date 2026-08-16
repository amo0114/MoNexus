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

let serial = 0
function uniq(prefix: string): string {
  serial += 1
  return `${prefix}-${Date.now()}-${serial}`
}

async function createNoCoverCategory(ownerId: number) {
  const code = uniq('nocover')
  const label = uniq('无默认封面')
  return prisma.productCategory.create({
    data: {
      code,
      label,
      normalizedLabel: label,
      status: 'active',
      sortOrder: 9999,
      defaultCoverUrl: null,
      createdByUserId: ownerId,
      updatedByUserId: ownerId,
    },
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
      cover: { mode: 'uploaded', objectKey: 'xboard-cover.webp' },
    }
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(body).expect(200)
    expect(preview.body).toMatchObject({
      canConfirm: true,
      cover: { imageUrl: 'http://localhost:3000/uploads/xboard-cover.webp', images: ['http://localhost:3000/uploads/xboard-cover.webp'] },
    })
    const created = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:77:uploaded')
      .send({ ...body, sourceHash: preview.body.sourceHash }).expect(201)
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.productId } })
    expect(product.imageUrl).toBe('http://localhost:3000/uploads/xboard-cover.webp')

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
    const created = responses.find(response => response.status === 201)!
    const conflicted = responses.find(response => response.status === 409)!
    // CHK-XBD-009: the stable conflict body carries the existing product id so
    // the UI can surface the winner — never a raw DB constraint name.
    expect(conflicted.body.error.code).toBe('CONFLICT')
    expect(conflicted.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'existingProductId', message: String(created.body.productId) }),
    ]))
    expect(await prisma.product.count()).toBe(1)
    expect(await prisma.externalCatalogLink.count()).toBe(1)
    expect(await prisma.offer.count()).toBe(2)
  })

  it('rejects confirm with 400 COVER_INVALID when the category has no default cover and no uploaded cover, writing nothing', async () => {
    const { user } = await createTestUser('faka-preview-nocover@test.local', 'pass123', 'admin')
    const auth = await loginAs('faka-preview-nocover@test.local', 'pass123')
    const category = await createNoCoverCategory(user.id)
    const body = { ...request(category.id), planId: 79 }
    catalogPlan = { ...catalogPlan, plan_id: 79 }

    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(body).expect(200)
    expect(preview.body.canConfirm).toBe(false)
    expect(preview.body.cover).toBeNull()
    expect(preview.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COVER_INVALID' })]))

    const before = await Promise.all([
      prisma.product.count(), prisma.offer.count(), prisma.externalCatalogLink.count(), prisma.adminLog.count(),
    ])
    const rejected = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:79:nocover')
      .send({ ...body, sourceHash: preview.body.sourceHash }).expect(400)
    // Confirm repeats the analysis and refuses with a stable, leak-free
    // detail (COVER_INVALID) instead of creating a product without a cover.
    expect(rejected.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'cover', message: expect.stringContaining('COVER_INVALID') }),
    ]))
    expect(await Promise.all([
      prisma.product.count(), prisma.offer.count(), prisma.externalCatalogLink.count(), prisma.adminLog.count(),
    ])).toEqual(before)
  })

  it('never exposes stored-object internals (objectKey/providerRef) in preview/confirm responses or audit rows', async () => {
    const { auth, category } = await adminAuth()
    // Register a real uploaded cover so the preview/confirm path serializes
    // stored-object-backed data (CHK-XBD-002 / CHK-SEC-002 absence side).
    await prisma.storedObject.create({
      data: {
        providerConfigId: null,
        providerRef: 'env',
        bucketRole: 'public',
        objectKey: 'xboard-cover-absence.webp',
        status: 'active',
        source: 'upload_image',
      },
    })
    const body = {
      ...request(category.id),
      planId: 80,
      cover: { mode: 'uploaded', objectKey: 'xboard-cover-absence.webp' },
    }
    catalogPlan = { ...catalogPlan, plan_id: 80 }
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(body).expect(200)
    const created = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:80:absence')
      .send({ ...body, sourceHash: preview.body.sourceHash }).expect(201)

    for (const payload of [preview.body, created.body]) {
      expect(JSON.stringify(payload)).not.toContain('objectKey')
      expect(JSON.stringify(payload)).not.toContain('providerRef')
    }
    const link = await prisma.externalCatalogLink.findUniqueOrThrow({ where: { productId: created.body.productId } })
    expect(JSON.stringify(link.sourceSnapshot)).not.toContain('objectKey')
    expect(JSON.stringify(link.sourceSnapshot)).not.toContain('providerRef')
    const logs = await prisma.adminLog.findMany({ where: { targetType: 'product', targetId: created.body.productId } })
    expect(logs.length).toBeGreaterThan(0)
    for (const log of logs) {
      expect(JSON.stringify(log)).not.toContain('objectKey')
      expect(JSON.stringify(log)).not.toContain('providerRef')
    }
  })

  it('enforces @@unique([externalIntegration, externalSku]) at the DB layer on colliding-SKU concurrent confirms', async () => {
    const { auth, category } = await adminAuth()
    // Plan 78 mirrors plan 77 (same periods/sku_alias) so its offers collide
    // on externalSku; a different externalProductId means the link unique is
    // never the arbiter — only the Offer unique can reject it (CHK-XBD-008).
    const plan78 = { ...catalogPlan, plan_id: 78 }
    __setExternalCatalogClientOverridesForTests({
      catalogUrl: 'https://xboard.test/api/plan-catalog',
      secret: 'test-only-secret',
      transport: async () => ({
        status: 200,
        text: JSON.stringify({ success: true, plans: [catalogPlan, plan78] }),
        headers: {},
      }),
    })
    const bodyA = request(category.id)
    const previewA = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(bodyA).expect(200)
    const bodyB = { ...request(category.id), planId: 78 }
    const previewB = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(bodyB).expect(200)
    const responses = await Promise.all([
      api.post('/api/admin/faka/import').set(authHeader(auth.accessToken)).set('Idempotency-Key', 'faka:77:sku-a')
        .send({ ...bodyA, sourceHash: previewA.body.sourceHash }),
      api.post('/api/admin/faka/import').set(authHeader(auth.accessToken)).set('Idempotency-Key', 'faka:78:sku-b')
        .send({ ...bodyB, sourceHash: previewB.body.sourceHash }),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    const created = responses.find(response => response.status === 201)!
    const conflicted = responses.find(response => response.status === 409)!
    expect(conflicted.body.error.code).toBe('CONFLICT')
    expect(conflicted.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'existingProductId', message: String(created.body.productId) }),
    ]))
    expect(await prisma.product.count()).toBe(1)
    expect(await prisma.externalCatalogLink.count()).toBe(1)
    expect(await prisma.offer.count()).toBe(2)
  })
})
