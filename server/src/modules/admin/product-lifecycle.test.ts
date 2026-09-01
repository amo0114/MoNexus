import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, authHeader, createTestProduct, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { __setExternalCatalogClientOverridesForTests } from '../catalog/externalCatalog.js'
import type { FakaPlanCatalogItem, FakaTransport } from '../../lib/fakaBridge/types.js'

async function adminAuth(email: string) {
  const { user } = await createTestUser(email, 'admin123', 'admin')
  const auth = await loginAs(email, 'admin123')
  return { user, auth }
}

describe('admin product archive lifecycle (REAL-PG)', () => {
  it('archives a product with historical orders, hides it publicly, and keeps the order readable', async () => {
    const { user: buyer } = await createTestUser('archive-buyer@test.local', 'pass123', 'user', 5000)
    const buyerAuth = await loginAs('archive-buyer@test.local', 'pass123')
    const { auth } = await adminAuth('archive-admin@test.local')
    const product = await createTestProduct('归档有单商品', 100, 2, ['card-a', 'card-b'])

    const created = await api.post('/api/orders').set(authHeader(buyerAuth.accessToken))
      .send({ productId: product.id }).expect(201)
    const publicBefore = await api.get('/api/products').expect(200)
    expect(publicBefore.body.items.some((item: { id: number }) => item.id === product.id)).toBe(true)

    const archived = await api.post(`/api/admin/products/${product.id}/archive`)
      .set(authHeader(auth.accessToken)).send({ reason: '下线' }).expect(200)
    expect(archived.body).toMatchObject({ mode: 'archived', productId: product.id, status: 'inactive', idempotent: false })

    const listed = await api.get('/api/admin/products').set(authHeader(auth.accessToken)).expect(200)
    expect(listed.body.some((item: { id: number }) => item.id === product.id)).toBe(false)
    const onlyArchived = await api.get('/api/admin/products?archived=only').set(authHeader(auth.accessToken)).expect(200)
    expect(onlyArchived.body.some((item: { id: number; archivedAt: string | null }) => item.id === product.id && item.archivedAt)).toBe(true)

    const publicAfter = await api.get('/api/products').expect(200)
    expect(publicAfter.body.items.some((item: { id: number }) => item.id === product.id)).toBe(false)
    await api.get(`/api/products/${product.id}`).expect(400)

    const order = await api.get(`/api/orders/${created.body.orderId}`).set(authHeader(buyerAuth.accessToken)).expect(200)
    expect(order.body.id ?? order.body.orderId ?? created.body.orderId).toBeTruthy()
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: created.body.orderId } })
    expect(stored.productId).toBe(product.id)
    expect(stored.price).toBe(100)
    expect(stored.userId).toBe(buyer.id)

    const replay = await api.post(`/api/admin/products/${product.id}/archive`)
      .set(authHeader(auth.accessToken)).send({}).expect(200)
    expect(replay.body.idempotent).toBe(true)

    const restored = await api.post(`/api/admin/products/${product.id}/restore`)
      .set(authHeader(auth.accessToken)).expect(200)
    expect(restored.body.status).not.toBe('active')
    expect(['draft', 'inactive']).toContain(restored.body.status)
    expect(restored.body.archivedAt).toBeNull()
    const offers = await prisma.offer.findMany({ where: { productId: product.id } })
    expect(offers.every((offer) => offer.status === 'inactive')).toBe(true)
    const publicRestored = await api.get('/api/products').expect(200)
    expect(publicRestored.body.items.some((item: { id: number }) => item.id === product.id)).toBe(false)
  })

  it('proxies DELETE to archive and refuses purge when orders exist', async () => {
    const { auth } = await adminAuth('purge-admin@test.local')
    await createTestUser('purge-buyer@test.local', 'pass123', 'user', 5000)
    const buyerAuth = await loginAs('purge-buyer@test.local', 'pass123')
    const product = await createTestProduct('不可清除商品', 80, 1, ['only-card'])
    await api.post('/api/orders').set(authHeader(buyerAuth.accessToken)).send({ productId: product.id }).expect(201)

    const deleted = await api.delete(`/api/admin/products/${product.id}`).set(authHeader(auth.accessToken)).expect(200)
    expect(deleted.body.mode).toBe('archived')
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull()

    const purged = await api.delete(`/api/admin/products/${product.id}/purge`).set(authHeader(auth.accessToken)).expect(409)
    expect(purged.body.error.code).toBe('PRODUCT_PURGE_BLOCKED')
  })

  it('purges a never-published draft with no historical dependencies', async () => {
    const { auth } = await adminAuth('purge-draft-admin@test.local')
    const created = await api.post('/api/admin/products').set(authHeader(auth.accessToken))
      .send({ name: '可清除草稿', type: '邀请码', price: 50 }).expect(201)
    const purged = await api.delete(`/api/admin/products/${created.body.id}/purge`)
      .set(authHeader(auth.accessToken)).expect(200)
    expect(purged.body.mode).toBe('purged')
    expect(await prisma.product.findUnique({ where: { id: created.body.id } })).toBeNull()
  })
})

describe('admin offer edit and archive (REAL-PG)', () => {
  it('applies new offer prices only to new orders and archives offers that have history', async () => {
    const { auth } = await adminAuth('offer-admin@test.local')
    await createTestUser('offer-buyer@test.local', 'pass123', 'user', 8000)
    const buyerAuth = await loginAs('offer-buyer@test.local', 'pass123')
    const product = await createTestProduct('改价商品', 100, 3, ['sku-1', 'sku-2', 'sku-3'])
    const offer = await prisma.offer.findFirstOrThrow({ where: { productId: product.id, isDefault: true } })

    const first = await api.post('/api/orders').set(authHeader(buyerAuth.accessToken))
      .send({ productId: product.id, offerId: offer.id }).expect(201)
    await api.patch(`/api/admin/products/${product.id}/offers/${offer.id}`)
      .set(authHeader(auth.accessToken)).send({ price: 180 }).expect(200)
    const second = await api.post('/api/orders').set(authHeader(buyerAuth.accessToken))
      .send({ productId: product.id, offerId: offer.id }).expect(201)

    const oldOrder = await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })
    const newOrder = await prisma.order.findUniqueOrThrow({ where: { id: second.body.orderId } })
    expect(oldOrder.price).toBe(100)
    expect(newOrder.price).toBe(180)
    expect(oldOrder.offerNameSnapshot).toBe(offer.name)

    const archived = await api.post(`/api/admin/products/${product.id}/offers/${offer.id}/archive`)
      .set(authHeader(auth.accessToken)).expect(400)
    expect(archived.body.error.code).toBe('DEFAULT_OFFER_ARCHIVE_BLOCKED')

    await prisma.offer.create({
      data: {
        productId: product.id,
        name: '备用规格',
        price: 90,
        isDefault: false,
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
        stock: 0,
        status: 'active',
      },
    })
    const extra = await prisma.offer.findFirstOrThrow({ where: { productId: product.id, name: '备用规格' } })
    await api.post(`/api/admin/products/${product.id}/offers/${extra.id}/make-default`)
      .set(authHeader(auth.accessToken)).expect(200)
    await api.post(`/api/admin/products/${product.id}/offers/${offer.id}/archive`)
      .set(authHeader(auth.accessToken)).expect(200)
    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })
    expect(after.status).toBe('inactive')
    expect(after.id).toBe(offer.id)
  })
})

describe('Xboard incremental sync and archived re-import (REAL-PG)', () => {
  let catalogPlan: FakaPlanCatalogItem
  function transport(): FakaTransport {
    return async () => ({
      status: 200,
      text: JSON.stringify({ success: true, plans: [catalogPlan] }),
      headers: {},
    })
  }

  beforeEach(() => {
    catalogPlan = {
      plan_id: 91,
      name: 'Sync Plan',
      content: '<p>sync</p>',
      show: true,
      sell: true,
      renew: true,
      group_id: 1,
      transfer_enable: 0,
      capacity_limit: null,
      active_users: 0,
      remaining: null,
      periods: [
        { period: 'monthly', price: 10, sku_alias: 'plan-91-monthly' },
        { period: 'yearly', price: 100, sku_alias: 'plan-91-yearly' },
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

  async function importPlan(auth: { accessToken: string }, categoryId: number) {
    const body = {
      planId: 91,
      productName: 'Sync Plan',
      categoryId,
      cover: { mode: 'category_default' as const },
      offers: [
        { period: 'monthly', offerName: '月付', pricePoints: 1000 },
        { period: 'yearly', offerName: '年付', pricePoints: 10000 },
      ],
    }
    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken)).send(body).expect(200)
    const created = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', `faka:91:${Date.now()}`)
      .send({ ...body, sourceHash: preview.body.sourceHash }).expect(201)
    return { body, preview, created }
  }

  it('rejects confirm when sourceHash changed and does not duplicate archived imports', async () => {
    const { auth } = await adminAuth('sync-admin@test.local')
    const category = await prisma.productCategory.findFirstOrThrow({ where: { status: 'active' } })
    await prisma.productCategory.update({
      where: { id: category.id },
      data: { defaultCoverUrl: '/assets/category-default.webp' },
    })
    const imported = await importPlan(auth, category.id)

    const stale = await api.post(`/api/admin/products/${imported.created.body.productId}/faka-sync`)
      .set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'sync:stale')
      .send({ sourceHash: 'a'.repeat(64), actions: [] })
      .expect(409)
    expect(stale.body.error.code).toBe('FAKA_SOURCE_CHANGED')

    await api.post(`/api/admin/products/${imported.created.body.productId}/archive`)
      .set(authHeader(auth.accessToken)).send({}).expect(200)

    const preview = await api.post('/api/admin/faka/import/preview').set(authHeader(auth.accessToken))
      .send(imported.body).expect(200)
    expect(preview.body.archived).toBe(true)
    expect(preview.body.existingProductId).toBe(imported.created.body.productId)
    expect(preview.body.canConfirm).toBe(false)
    expect(preview.body.suggestedActions).toEqual(expect.arrayContaining(['restore_product', 'sync']))

    const confirm = await api.post('/api/admin/faka/import').set(authHeader(auth.accessToken))
      .set('Idempotency-Key', 'faka:91:archived-dup')
      .send({ ...imported.body, sourceHash: preview.body.sourceHash })
      .expect(409)
    expect(confirm.body.error.code).toBe('PRODUCT_ARCHIVED')
    expect(await prisma.product.count({ where: { name: 'Sync Plan' } })).toBe(1)
  })
})
