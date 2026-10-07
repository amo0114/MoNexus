import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { config } from '../../../config/index.js'
import { prisma } from '../../../lib/prisma.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, getDefaultOfferId, loginAs } from '../../../__tests__/helpers.js'
import * as readiness from '../../catalog/publicationReadiness.js'
import * as repository from './repository.js'
import { getAvailability, getDrafts, getItem, getUrgent } from './service.js'
import { deadlineBand, DUE_WINDOW_MS, readinessAction } from './rules.js'
import { draftQuery } from './schema.js'

const NOW = new Date('2026-10-07T10:00:00.000Z')
const base = '/api/merchant/workbench'
const originalEnabled = config.merchantWorkbenchEnabled
beforeEach(() => { config.merchantWorkbenchEnabled = true })
afterEach(() => { config.merchantWorkbenchEnabled = originalEnabled; vi.restoreAllMocks() })

async function fixture() {
  const owner = await createTestMerchant('workbench-owner@test.local', 'pass123', { status: 'active' })
  const product = await createTestProduct('Safe product', 100, 0, [], owner.merchant.id)
  const offerId = await getDefaultOfferId(product.id)
  return { owner, product, offerId }
}

describe('merchant workbench PR1', () => {
  it('uses strict SLA boundaries and closed navigation for every readiness code', () => {
    expect(deadlineBand(null, NOW)).toBeNull()
    expect(deadlineBand(new Date(+NOW - 1), NOW)).toBe('overdue')
    expect(deadlineBand(NOW, NOW)).toBe('due_soon')
    expect(deadlineBand(new Date(+NOW + DUE_WINDOW_MS), NOW)).toBe('due_soon')
    expect(deadlineBand(new Date(+NOW + DUE_WINDOW_MS + 1), NOW)).toBeNull()
    const codes = {
      COVER_REQUIRED: 'images', PURCHASE_NOTES_REQUIRED: 'purchase-notes', AFTER_SALES_REQUIRED: 'after-sales',
      TEMPLATE_FIELDS_REQUIRED: 'attributes', CATEGORY_INACTIVE: 'category',
      FULFILLMENT_CONFIG_INVALID: 'offers', EXTERNAL_IDENTITY_INVALID: 'offers', OFFER_NOT_SELLABLE: 'offers',
    } as const
    for (const [code, focus] of Object.entries(codes)) {
      expect(readinessAction(1, { code: code as keyof typeof codes, field: 'unused', offerId: null, reason: 'untrusted /url' }, []))
        .toMatchObject({ kind: 'edit_product', focus })
    }
    expect(readinessAction(1, { code: 'TEMPLATE_FIELDS_REQUIRED', field: 'offers', offerId: 4 }, []))
      .toMatchObject({ focus: 'offers', offerId: 4 })
    expect(readinessAction(1, { code: 'OFFER_NOT_SELLABLE', field: 'offers', offerId: 4 }, [4]))
      .toEqual({ kind: 'manage_availability', productId: 1, offerId: 4 })
    expect(readinessAction(1, { code: 'OFFER_NOT_SELLABLE', field: 'offers', offerId: 4 }, []))
      .toMatchObject({ kind: 'edit_product', focus: 'offers' })
    for (const value of ['0', '-1', '1.5', '1e2', '2147483648']) expect(draftQuery.safeParse({ beforeProductId: value }).success).toBe(false)
    expect(draftQuery.safeParse({ beforeProductId: ['1', '2'] }).success).toBe(false)
  })

  it('enforces auth, active merchant ownership, strict queries and distinct 404/503/200', async () => {
    const { owner, product, offerId } = await fixture()
    const other = await createTestMerchant('workbench-other@test.local', 'pass123', { status: 'active' })
    const foreign = await createTestProduct('Foreign', 100, 0, [], other.merchant.id)
    const token = (await loginAs(owner.user.email, 'pass123')).accessToken
    const auth = authHeader(token)
    await api.get(`${base}/urgent`).expect(401)
    config.merchantWorkbenchEnabled = false
    await api.get(`${base}/urgent`).set(auth).expect(404)
    config.merchantWorkbenchEnabled = true
    const response = await api.get(`${base}/urgent`).set(auth).expect(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.urgentTotal).toBe(1)
    expect(response.body.soldOut.items[0].targetId).toBe(offerId)
    for (const path of ['urgent', 'availability', 'drafts', `items/low_availability/${offerId}`]) {
      await api.get(`${base}/${path}`).query({ merchantId: other.merchant.id }).set(auth).expect(400)
    }
    await api.get(`${base}/items/draft_incomplete/${foreign.id}`).set(auth).expect(404)
    await api.get(`${base}/items/low_availability/${await getDefaultOfferId(foreign.id)}`).set(auth).expect(404)
    await api.get(`${base}/items/draft_incomplete/${product.id}`).set(auth).expect(200)
    const failedAvailability = vi.spyOn(repository, 'queryAvailability').mockRejectedValue(new Error('PRIVATE_DATABASE_ERROR'))
    const partial = await api.get(`${base}/urgent`).set(auth).expect(200)
    expect(partial.body).toMatchObject({ urgentTotal: null, urgentKnownCount: 0, soldOut: { status: 'failed', matchedTotal: null } })
    vi.spyOn(repository, 'queryFulfillment').mockRejectedValue(new Error('PRIVATE_DATABASE_ERROR'))
    const failed = await api.get(`${base}/urgent`).set(auth).expect(503)
    expect(JSON.stringify(failed.body)).not.toContain('PRIVATE_DATABASE_ERROR')
    failedAvailability.mockRestore()
    await prisma.merchant.update({ where: { id: owner.merchant.id }, data: { status: 'suspended' } })
    await api.get(`${base}/urgent`).set(auth).expect(403)
  })

  it('counts available inventory rather than stock and excludes inactive, archived, unlimited and external offers', async () => {
    const { owner, product, offerId } = await fixture()
    await prisma.offer.update({ where: { id: offerId }, data: { stock: 99 } })
    await prisma.inventoryItem.createMany({ data: [
      { productId: product.id, offerId, content: 'SECRET_CARD_AVAILABLE', status: 'available' },
      { productId: product.id, offerId, content: 'SECRET_CARD_SOLD', status: 'sold' },
    ] })
    const capacity = await prisma.offer.create({ data: { productId: product.id, name: 'Capacity', price: 100, deliveryMode: 'manual_service', stockMode: 'limited', stock: 2 } })
    await prisma.offer.createMany({ data: [
      { productId: product.id, name: 'Unlimited', price: 100, deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0 },
      { productId: product.id, name: 'External', price: 100, deliveryMode: 'manual_service', stock: 0, externalIntegration: 'faka_bridge', externalSku: 'SECRET_EXTERNAL_SKU' },
      { productId: product.id, name: 'Disabled', price: 100, status: 'inactive', stock: 0 },
      { productId: product.id, name: 'Fixed', price: 100, deliveryMode: 'instant_fixed', fixedContent: 'SECRET_FIXED_CONTENT', stock: 1 },
    ] })
    const report = await getAvailability(owner.merchant.id, NOW)
    expect(report.matchedTotal).toBe(3)
    expect(report.items.find(item => item.targetId === offerId)?.evidence).toMatchObject({ available: 1, kind: 'inventory' })
    expect(report.items.find(item => item.targetId === capacity.id)?.evidence).toMatchObject({ available: 2, kind: 'capacity' })
    expect(JSON.stringify(report)).not.toContain('SECRET_')
    expect((await repository.readSnapshot(db => repository.queryAvailability(db, owner.merchant.id, 0))).matchedTotal).toBe(0)
    await prisma.inventoryItem.updateMany({ where: { offerId }, data: { status: 'sold' } })
    expect((await repository.readSnapshot(db => repository.queryAvailability(db, owner.merchant.id, 0))).matchedTotal).toBe(1)
    await prisma.product.update({ where: { id: product.id }, data: { archivedAt: NOW, status: 'inactive' } })
    expect((await getAvailability(owner.merchant.id, NOW)).items).toEqual([])
    expect((await getItem(owner.merchant.id, 'low_availability', offerId, NOW)).state).toBe('ineligible')
  })

  it('caps each urgent group at 200 while preserving full counts; never runs readiness or writes business data', async () => {
    const { owner, product, offerId } = await fixture()
    await prisma.offer.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ productId: product.id, name: `Offer ${i}`, price: 100, stock: 0 })) })
    await prisma.order.createMany({ data: Array.from({ length: 201 }, () => ({ userId: owner.user.id, merchantId: owner.merchant.id, productId: product.id, offerId, price: 100,
      status: 'processing', deliveryModeSnapshot: 'manual_service', fulfillmentDeadline: NOW, purchaseFormAnswers: { account: 'SECRET_ANSWER' }, productNameSnapshot: 'Snapshot' })) })
    const spy = vi.spyOn(readiness, 'inspectProductReadiness')
    for (let tick = 0; tick < 3; tick++) {
      const report = await getUrgent(owner.merchant.id, NOW)
      expect(report.urgentTotal).toBe(402)
      expect(report.fulfillment).toMatchObject({ truncated: true, matchedTotal: 201 })
      expect(report.soldOut).toMatchObject({ truncated: true, matchedTotal: 201 })
      expect(report.fulfillment.items).toHaveLength(200)
      expect(report.soldOut.items).toHaveLength(200)
      expect(report.fulfillment.items[0].evidence).toMatchObject({ productName: 'Snapshot', band: 'due_soon' })
      expect(JSON.stringify(report)).not.toContain('SECRET_')
    }
    expect(spy).not.toHaveBeenCalled()
    expect(await prisma.order.count()).toBe(201)
    expect(await prisma.offer.count()).toBe(201)
    expect(await prisma.notification.count()).toBe(0)
    expect(await prisma.orderStatusEvent.count()).toBe(0)
    expect(await prisma.inventoryLog.count()).toBe(0)
  })

  it('queries the same SLA instants under UTC and Shanghai DB sessions, scopes orders by snapshot merchant', async () => {
    const { owner, product, offerId } = await fixture()
    const other = await createTestMerchant('workbench-new-owner@test.local', 'pass123', { status: 'active' })
    const dates = [new Date(+NOW - 1), NOW, new Date(+NOW + DUE_WINDOW_MS), new Date(+NOW + DUE_WINDOW_MS + 1), null]
    for (const fulfillmentDeadline of dates) await prisma.order.create({ data: { userId: owner.user.id, merchantId: owner.merchant.id,
      productId: product.id, offerId, price: 100, status: 'processing', deliveryModeSnapshot: 'manual_service', fulfillmentDeadline } })
    await prisma.order.create({ data: { userId: owner.user.id, merchantId: owner.merchant.id, productId: product.id, price: 100,
      status: 'closed', deliveryModeSnapshot: 'manual_service', fulfillmentDeadline: new Date(+NOW - 1) } })
    await prisma.product.update({ where: { id: product.id }, data: { merchantId: other.merchant.id } })
    const reports = []
    for (const zone of ['UTC', 'Asia/Shanghai']) {
      reports.push(await prisma.$transaction(async db => {
        await db.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`
        return repository.queryFulfillment(db, owner.merchant.id, NOW)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }))
    }
    expect(reports[0]).toEqual(reports[1])
    expect(reports[0].matchedTotal).toBe(3)
    expect(reports[0].items.map(row => row.fulfillmentDeadline)).toEqual(dates.slice(0, 3))
    expect((await getUrgent(other.merchant.id, NOW)).fulfillment.matchedTotal).toBe(0)
    await expect(getItem(other.merchant.id, 'fulfillment_due', reports[0].items[0].id, NOW)).rejects.toMatchObject({ status: 404 })
    const first = await getItem(owner.merchant.id, 'fulfillment_due', reports[0].items[0].id, NOW)
    expect(first.state).toBe('match')
  })

  it('checks 25 drafts in bounded batches with publish defaults and explicit coverage', async () => {
    const { owner, product } = await fixture()
    await prisma.product.update({ where: { id: product.id }, data: { status: 'draft' } })
    await prisma.product.createMany({ data: Array.from({ length: 24 }, (_, i) => ({ name: `Draft ${i}`, type: product.type,
      categoryId: product.categoryId, merchantId: owner.merchant.id, price: 100, status: 'draft' })) })
    const first = await getDrafts(owner.merchant.id, undefined, NOW)
    expect(first).toMatchObject({ scannedCount: 20, checkedCount: 20, hasMore: true, failedProductIds: [] })
    expect(first.results.every(row => row.state === 'match')).toBe(true)
    const second = await getDrafts(owner.merchant.id, first.nextBeforeProductId!, NOW)
    expect(second).toMatchObject({ scannedCount: 5, checkedCount: 5, hasMore: false, nextBeforeProductId: null })
    expect(new Set([...first.results, ...second.results].map(row => row.targetId)).size).toBe(25)
    const real = await getItem(owner.merchant.id, 'draft_incomplete', product.id, NOW)
    if (real.state !== 'match' || real.item.evidence.kind !== 'draft') throw Error('Expected draft')
    expect(real.item.evidence.issues.find(issue => issue.code === 'OFFER_NOT_SELLABLE')?.action.kind).toBe('manage_availability')
    expect(real.item.evidence.issues.every(issue => !Object.hasOwn(issue, 'reason'))).toBe(true)
    await prisma.product.update({ where: { id: product.id }, data: { status: 'active' } })
    expect((await getItem(owner.merchant.id, 'draft_incomplete', product.id, NOW)).state).toBe('ineligible')
  })

  it('preserves unknown draft failures and caps concurrent readiness work at four', async () => {
    vi.spyOn(repository, 'queryDraftIds').mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ id: 30 - i })))
    let concurrent = 0, maximum = 0
    vi.spyOn(repository, 'queryDraftTarget').mockImplementation(async (_merchant, id) => {
      concurrent++; maximum = Math.max(maximum, concurrent)
      await new Promise(resolve => setTimeout(resolve, 2))
      concurrent--
      if (id === 25) throw Error('READ_FAILURE')
      return { targetId: id, state: 'clear' }
    })
    const result = await getDrafts(1, undefined, NOW)
    expect(result).toMatchObject({ scannedCount: 20, checkedCount: 19, failedProductIds: [25], hasMore: true, nextBeforeProductId: 11 })
    expect(maximum).toBe(4)
    expect(result.results.find(row => row.targetId === 25)?.state).toBe('unknown')
  })

  it('reuses publication evaluation to distinguish invalid config from empty valid offers without changing its DTO', async () => {
    const { owner, product, offerId } = await fixture()
    await prisma.product.update({ where: { id: product.id }, data: { status: 'draft', imageUrl: '/cover.webp', images: ['/cover.webp'] } })
    // A missing manual-service webhook is invalid configuration, not a request to add capacity.
    await prisma.offer.update({ where: { id: offerId }, data: { deliveryMode: 'manual_service', autoProvision: true, stock: 0 } })
    const invalid = await getItem(owner.merchant.id, 'draft_incomplete', product.id, NOW)
    if (invalid.state !== 'match') throw Error('Expected match')
    expect(invalid.item.action).toMatchObject({ kind: 'edit_product', focus: 'offers', offerId })
    await prisma.offer.update({ where: { id: offerId }, data: { autoProvision: false } })
    const empty = await getItem(owner.merchant.id, 'draft_incomplete', product.id, NOW)
    if (empty.state !== 'match') throw Error('Expected match')
    expect(empty.item.action).toMatchObject({ kind: 'manage_availability', offerId })
    const publishResult = await readiness.checkProductReadiness(product.id)
    expect(Object.keys(publishResult).sort()).toEqual(['details', 'isFirstPublish', 'ready'])
    expect(publishResult.details).toHaveLength(1)
    expect((await readiness.checkProductReadiness(product.id, prisma, { requireCurrentlySellable: false })).ready).toBe(true)
    await prisma.offer.update({ where: { id: offerId }, data: { stock: 2 } })
    expect((await getItem(owner.merchant.id, 'draft_incomplete', product.id, NOW)).state).toBe('clear')
    await prisma.offer.update({ where: { id: offerId }, data: { status: 'inactive' } })
    const none = await getItem(owner.merchant.id, 'draft_incomplete', product.id, NOW)
    if (none.state !== 'match') throw Error('Expected match')
    expect(none.item.action).toMatchObject({ kind: 'edit_product', focus: 'offers', offerId: null })
  })
})

describe('merchant workbench PR3 evidence', () => {
  const keysOf = (items: Array<{ key: string }>) => items.map(item => item.key).sort()

  it('AC03: cards follow unpublish, archive/restore and offer disable/enable done through business APIs', async () => {
    const { owner, product, offerId } = await fixture()
    const merchant = authHeader((await loginAs(owner.user.email, 'pass123')).accessToken)
    await createTestUser('workbench-admin@test.local', 'admin123', 'admin')
    const admin = authHeader((await loginAs('workbench-admin@test.local', 'admin123')).accessToken)
    // Sold-out inventory offer (default) plus a low capacity offer; a draft with a missing cover.
    await prisma.inventoryItem.deleteMany({ where: { offerId } })
    const low = await prisma.offer.create({ data: { productId: product.id, name: 'Low', price: 100, deliveryMode: 'manual_service', stockMode: 'limited', stock: 2 } })
    await api.put(`/api/merchant/products/${product.id}`).set(merchant)
      .send({ imageUrl: '/assets/e2e-cover.png', images: ['/assets/e2e-cover.png'] }).expect(200)
    const draft = await createTestProduct('Draft target', 100, 0, [], owner.merchant.id)
    await prisma.product.update({ where: { id: draft.id }, data: { status: 'draft' } })

    const urgent = async () => (await api.get(`${base}/urgent`).set(merchant).expect(200)).body
    const availability = async () => keysOf((await api.get(`${base}/availability`).set(merchant).expect(200)).body.items)
    const draftIds = async () => (await api.get(`${base}/drafts`).set(merchant).expect(200)).body.results
      .filter((row: { state: string }) => row.state === 'match').map((row: { targetId: number }) => row.targetId)
    const item = async (rule: string, id: number) => (await api.get(`${base}/items/${rule}/${id}`).set(merchant).expect(200)).body.state
    const soldKey = `low_availability:${offerId}`, lowKey = `low_availability:${low.id}`

    expect(keysOf((await urgent()).soldOut.items)).toEqual([soldKey])
    expect(await availability()).toEqual([soldKey, lowKey].sort())
    expect(await draftIds()).toEqual([draft.id])

    // Offer disable / enable (merchant offer API).
    await api.put(`/api/merchant/products/${product.id}/offers/${low.id}`).set(merchant).send({ status: 'inactive' }).expect(200)
    expect(await availability()).toEqual([soldKey])
    expect(await item('low_availability', low.id)).toBe('ineligible')
    await api.put(`/api/merchant/products/${product.id}/offers/${low.id}`).set(merchant).send({ status: 'active' }).expect(200)
    expect(await availability()).toEqual([soldKey, lowKey].sort())

    // Unpublish removes every availability card of the product; publishing again restores them.
    await api.post(`/api/merchant/products/${product.id}/unpublish`).set(merchant).expect(200)
    expect((await urgent()).soldOut.items).toEqual([])
    expect(await availability()).toEqual([])
    expect(await item('low_availability', low.id)).toBe('ineligible')
    await api.post(`/api/merchant/products/${product.id}/publish`).set(merchant).expect(200)
    expect(await availability()).toEqual([soldKey, lowKey].sort())

    // Platform archive / restore (admin product lifecycle API) for an active product and a draft.
    await api.post(`/api/admin/products/${product.id}/archive`).set(admin).send({ reason: 'workbench AC03' }).expect(200)
    expect(await availability()).toEqual([])
    expect(await item('low_availability', offerId)).toBe('ineligible')
    await api.post(`/api/admin/products/${draft.id}/archive`).set(admin).send({ reason: 'workbench AC03' }).expect(200)
    expect(await draftIds()).toEqual([])
    expect(await item('draft_incomplete', draft.id)).toBe('ineligible')
    // Restore: a never-published draft returns as a draft card; a published product returns inactive
    // (no cards) until the merchant re-enables its offers and publishes it again.
    await api.post(`/api/admin/products/${draft.id}/restore`).set(admin).expect(200)
    expect(await draftIds()).toEqual([draft.id])
    await api.post(`/api/admin/products/${product.id}/restore`).set(admin).expect(200)
    expect(await availability()).toEqual([])
    // Archive also deactivated the offers; the merchant re-enables them before publishing again.
    for (const id of [offerId, low.id]) {
      await api.put(`/api/merchant/products/${product.id}/offers/${id}`).set(merchant).send({ status: 'active' }).expect(200)
    }
    expect(await availability()).toEqual([])
    await api.post(`/api/merchant/products/${product.id}/publish`).set(merchant).expect(200)
    expect(await availability()).toEqual([soldKey, lowKey].sort())
  })

  it('AC10: buyer email and order internal notes never reach workbench responses', async () => {
    const { owner, product, offerId } = await fixture()
    const merchant = authHeader((await loginAs(owner.user.email, 'pass123')).accessToken)
    const { user: buyer } = await createTestUser('secret-buyer-sentinel@test.local', 'pass123', 'user', 5000)
    await prisma.user.update({ where: { id: buyer.id }, data: { nickname: 'SECRET_BUYER_NICKNAME' } })
    const order = await prisma.order.create({ data: { userId: buyer.id, merchantId: owner.merchant.id, productId: product.id, offerId, price: 100,
      status: 'processing', deliveryModeSnapshot: 'manual_service', fulfillmentDeadline: new Date(Date.now() + 60 * 60 * 1000),
      purchaseFormAnswers: { account: 'SECRET_ANSWER' }, productNameSnapshot: 'Snapshot' } })
    await prisma.orderStatusEvent.create({ data: { orderId: order.id, actorUserId: owner.user.id, actorRole: 'merchant', fromStatus: 'pending',
      toStatus: 'processing', action: 'start_fulfillment', publicNote: 'visible progress', internalNote: 'SECRET_INTERNAL_NOTE' } })

    const bodies = await Promise.all(['urgent', 'availability', 'drafts', `items/fulfillment_due/${order.id}`]
      .map(async path => (await api.get(`${base}/${path}`).set(merchant).expect(200)).body))
    expect(bodies[0].fulfillment.items.map((row: { targetId: number }) => row.targetId)).toEqual([order.id])
    expect(bodies[3].state).toBe('match')
    const fieldNames = new Set<string>()
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { fieldNames.add(key); walk(child) }
    }
    for (const body of bodies) {
      const text = JSON.stringify(body)
      for (const sentinel of ['secret-buyer-sentinel', 'SECRET_INTERNAL_NOTE', 'SECRET_BUYER_NICKNAME', 'SECRET_ANSWER', 'visible progress', owner.user.email]) {
        expect(text).not.toContain(sentinel)
      }
      walk(body)
    }
    for (const forbidden of ['email', 'nickname', 'userId', 'internalNote', 'publicNote', 'purchaseFormAnswers', 'content', 'fixedContent']) {
      expect(fieldNames.has(forbidden)).toBe(false)
    }
  })
})
