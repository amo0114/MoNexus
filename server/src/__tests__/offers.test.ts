import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  getDefaultOfferId,
  loginAs,
  loginAsMerchant,
  authHeader,
} from './helpers.js'

/**
 * P4a T6：SKU/套餐(Offer)行为回归。锁定 spec §5 不变量在多 SKU 维度下逐条成立,
 * 且单 SKU 商品对既有购买链路完全透明(不传 offerId 行为与 P3 前一致)。
 */

async function setupMerchant(email: string, name = 'SKU 商家') {
  const { merchant } = await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name,
  })
  const { accessToken } = await loginAsMerchant(email, 'pass123')
  return { merchant, accessToken }
}

/** 在指定 Offer 下直插即时库存条目(测试构造用)。 */
async function seedInventory(productId: number, offerId: number, contents: string[]) {
  await prisma.inventoryItem.createMany({
    data: contents.map(content => ({ productId, offerId, content, status: 'available' })),
  })
}

describe('P4a Offers — default offer & product projection', () => {
  it('creating a product through the merchant API provisions a default offer mirroring commercial fields', async () => {
    const { accessToken } = await setupMerchant('offer-create@test.local')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '默认规格商品',
        type: '充值卡密',
        price: 300,
        originalPrice: 400,
        deliveryMode: 'instant_inventory',
      })
      .expect(201)

    const offers = await prisma.offer.findMany({ where: { productId: created.body.id } })
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({
      name: '默认规格',
      price: 300,
      originalPrice: 400,
      deliveryMode: 'instant_inventory',
      status: 'active',
    })
  })

  it('exposes active offers on the public product detail without leaking fixedContent', async () => {
    const { merchant, accessToken } = await setupMerchant('offer-public@test.local')
    const product = await createTestProduct('公开规格商品', 100, 2, ['pub-1', 'pub-2'], merchant.id)

    // 追加一个 instant_fixed 规格(带付费内容),验证公开序列化剥离 fixedContent。
    await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '固定内容规格',
        price: 150,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'SECRET-FIXED-CONTENT',
        fixedContentType: 'text',
      })
      .expect(201)

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(Array.isArray(detail.body.offers)).toBe(true)
    expect(detail.body.offers.length).toBe(2)
    const serialized = JSON.stringify(detail.body.offers)
    expect(serialized).not.toContain('SECRET-FIXED-CONTENT')
    // 精确匹配键名：公开序列化出 fixedContentType（形态元数据），
    // 但绝不能出现 fixedContent 本体键。
    expect(serialized).not.toContain('"fixedContent":')
    // 即时库存规格的公开 stock = 实际可用条目数。
    const inventoryOffer = detail.body.offers.find((o: { deliveryMode: string }) => o.deliveryMode === 'instant_inventory')
    expect(inventoryOffer.stock).toBe(2)
  })

  it('projects product.price as the cheapest active offer and restores it when the cheaper offer is deactivated', async () => {
    const { merchant, accessToken } = await setupMerchant('offer-projection@test.local')
    const product = await createTestProduct('投影商品', 100, 1, ['proj-1'], merchant.id)

    const cheaper = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '促销规格', price: 60, deliveryMode: 'instant_inventory' })
      .expect(201)

    let row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(row.price).toBe(60) // 最低 active 价

    // 下架促销规格 → 投影回退到剩余 active 的最低价(100)。
    await api
      .put(`/api/merchant/products/${product.id}/offers/${cheaper.body.id}`)
      .set(authHeader(accessToken))
      .send({ status: 'inactive' })
      .expect(200)

    row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(row.price).toBe(100)
  })
})

describe('P4a Offers — public availability from active offers (not the projection)', () => {
  it('a mixed-mode product with an unlimited offer never reads as sold out, even when the default offer is out of stock', async () => {
    const { merchant, accessToken } = await setupMerchant('avail-mixed@test.local')
    // 默认规格：即时库存，0 条可用 → 投影 stockMode='limited'、库存 0
    const product = await createTestProduct('混合可售商品', 100, 0, [], merchant.id)
    await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '不限量人工档', price: 200, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)

    // 列表与详情都不能把它当售罄（前端契约：stockMode !== 'unlimited' && stock === 0）
    const list = await api.get('/api/products').expect(200)
    const listItem = list.body.items.find((item: { id: number }) => item.id === product.id)
    expect(listItem.stockMode).toBe('unlimited')

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(detail.body.stockMode).toBe('unlimited')
  })

  it('an inactive default offer no longer dictates availability; remaining instant offer uses its real item count', async () => {
    const { merchant, accessToken } = await setupMerchant('avail-inactive@test.local')
    // 默认规格：不限量人工服务（随后下架）；第二规格：即时库存 2 条
    const product = await createTestProduct('下架默认档商品', 100, 0, [], merchant.id)
    const defaultOfferId = await getDefaultOfferId(product.id)
    await api
      .put(`/api/merchant/products/${product.id}/offers/${defaultOfferId}`)
      .set(authHeader(accessToken))
      .send({ deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(200)
    const inv = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '卡密档', price: 150, deliveryMode: 'instant_inventory' })
      .expect(201)
    await seedInventory(product.id, inv.body.id, ['AV-1', 'AV-2'])
    await api
      .put(`/api/merchant/products/${product.id}/offers/${defaultOfferId}`)
      .set(authHeader(accessToken))
      .send({ status: 'inactive' })
      .expect(200)

    // 投影 stockMode 仍是已下架默认档的 'unlimited'；公开可售状态必须无视它
    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(detail.body.stockMode).toBe('limited')
    expect(detail.body.stock).toBe(2)

    const list = await api.get('/api/products').expect(200)
    const listItem = list.body.items.find((item: { id: number }) => item.id === product.id)
    expect(listItem.stockMode).toBe('limited')
    expect(listItem.stock).toBe(2)
  })
})

describe('P4a Offers — single-SKU transparency', () => {
  it('orders a single-SKU product without an offerId and snapshots the resolved offer', async () => {
    await createTestUser('single-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('单规格商品', 200, 2, ['single-1', 'single-2'])
    const { accessToken } = await loginAs('single-buyer@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    const defaultOfferId = await getDefaultOfferId(product.id)
    expect(order.offerId).toBe(defaultOfferId)
    expect(order.offerNameSnapshot).toBe('默认规格')
    expect(order.price).toBe(200)
  })

  it('returns offer identity in the checkout preview when offerId is omitted', async () => {
    await createTestUser('single-preview@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('单规格预览', 250, 1, ['sp-1'])
    const { accessToken } = await loginAs('single-preview@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: product.id })
      .set(authHeader(accessToken))
      .expect(200)

    const defaultOfferId = await getDefaultOfferId(product.id)
    expect(preview.body.offerId).toBe(defaultOfferId)
    expect(preview.body.offerName).toBe('默认规格')
    expect(preview.body.price).toBe(250)
  })
})

describe('P4a Offers — multi-SKU selection & isolation', () => {
  async function setupMultiSku(email: string) {
    await createTestUser(email, 'pass123', 'user', 5000)
    const { merchant, accessToken } = await setupMerchant(`m-${email}`)
    const product = await createTestProduct('多规格商品', 100, 2, ['A-1', 'A-2'], merchant.id)
    const offerA = await getDefaultOfferId(product.id)

    const offerBRes = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '高级规格', price: 300, deliveryMode: 'instant_inventory' })
      .expect(201)
    const offerB = offerBRes.body.id as number
    await seedInventory(product.id, offerB, ['B-1', 'B-2'])

    const buyer = await loginAs(email, 'pass123')
    return { product, offerA, offerB, buyer }
  }

  it('requires an explicit offer when multiple active offers exist', async () => {
    const { product, buyer } = await setupMultiSku('multi-requires@test.local')
    const res = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(400)
    expect(res.body.error.message).toContain('请选择商品规格')
  })

  it('claims inventory only from the selected offer, leaving the other offer untouched', async () => {
    const { product, offerA, offerB, buyer } = await setupMultiSku('multi-isolation@test.local')

    const res = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, offerId: offerB, expectedPrice: 300 })
      .expect(201)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(order.offerId).toBe(offerB)
    expect(order.price).toBe(300)

    // 只有 B 的一条被领取为 sold;A 的库存完全不受影响。
    const soldB = await prisma.inventoryItem.count({ where: { offerId: offerB, status: 'sold' } })
    const availableB = await prisma.inventoryItem.count({ where: { offerId: offerB, status: 'available' } })
    const availableA = await prisma.inventoryItem.count({ where: { offerId: offerA, status: 'available' } })
    expect(soldB).toBe(1)
    expect(availableB).toBe(1)
    expect(availableA).toBe(2)
  })

  it('prices the checkout preview by the selected offer', async () => {
    const { product, offerB, buyer } = await setupMultiSku('multi-preview@test.local')
    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: product.id, offerId: offerB })
      .set(authHeader(buyer.accessToken))
      .expect(200)
    expect(preview.body.offerId).toBe(offerB)
    expect(preview.body.price).toBe(300)
  })
})

describe('P4a Offers — inactive & cross-product rejection', () => {
  it('rejects ordering an explicitly selected inactive offer', async () => {
    await createTestUser('inactive-buyer@test.local', 'pass123', 'user', 5000)
    const { merchant, accessToken } = await setupMerchant('inactive-offer-m@test.local')
    const product = await createTestProduct('含下架规格商品', 100, 2, ['I-1', 'I-2'], merchant.id)

    const offerRes = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '待下架规格', price: 200, deliveryMode: 'instant_inventory' })
      .expect(201)
    const offerId = offerRes.body.id as number
    await api
      .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ status: 'inactive' })
      .expect(200)

    const buyer = await loginAs('inactive-buyer@test.local', 'pass123')
    const res = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, offerId })
      .expect(400)
    expect(res.body.error.message).toContain('已下架')
  })

  it('rejects an offerId that belongs to a different product with 404', async () => {
    await createTestUser('cross-buyer@test.local', 'pass123', 'user', 5000)
    const foreign = await createTestProduct('他商品', 100, 1, ['foreign-1'])
    const foreignOffer = await getDefaultOfferId(foreign.id)
    const target = await createTestProduct('本商品', 100, 1, ['target-1'])

    const buyer = await loginAs('cross-buyer@test.local', 'pass123')
    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: target.id, offerId: foreignOffer })
      .expect(404)
  })
})

describe('P4a Offers — cross-offer idempotency', () => {
  it('replays the same order for an identical key+offer and conflicts (409) when the key is reused for a different offer', async () => {
    await createTestUser('idem-offer@test.local', 'pass123', 'user', 5000)
    const { merchant, accessToken } = await setupMerchant('idem-offer-m@test.local')
    const product = await createTestProduct('幂等多规格', 100, 2, ['IA-1', 'IA-2'], merchant.id)
    const offerA = await getDefaultOfferId(product.id)
    const offerBRes = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: 'B 规格', price: 200, deliveryMode: 'instant_inventory' })
      .expect(201)
    const offerB = offerBRes.body.id as number
    await seedInventory(product.id, offerB, ['IB-1', 'IB-2'])

    const buyer = await loginAs('idem-offer@test.local', 'pass123')
    const key = randomUUID()

    const first = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: product.id, offerId: offerA, expectedPrice: 100 })
      .expect(201)

    // 同 key + 同 offer + 同意图 → 重放同一订单,不新增订单。
    const replay = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: product.id, offerId: offerA, expectedPrice: 100 })
    expect(replay.status).toBeLessThan(300)
    expect(replay.body.orderId).toBe(first.body.orderId)

    // 同 key 换 SKU → 与换商品同理必须 409。
    const conflict = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: product.id, offerId: offerB, expectedPrice: 200 })
      .expect(409)
    expect(conflict.body.error.code).toBe('CONFLICT')

    // 换 SKU 冲突不得落单:仍然只有第一笔 offerA 订单。
    expect(await prisma.order.count({ where: { productId: product.id } })).toBe(1)
  })
})

describe('P4a Offers — merchant CRUD guards', () => {
  it('lists offers, updates price, and blocks deleting the last remaining offer', async () => {
    const { merchant, accessToken } = await setupMerchant('crud-guard@test.local')
    const product = await createTestProduct('CRUD 商品', 100, 1, ['crud-1'], merchant.id)
    const defaultOfferId = await getDefaultOfferId(product.id)

    const list = await api
      .get(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(list.body).toHaveLength(1)

    await api
      .put(`/api/merchant/products/${product.id}/offers/${defaultOfferId}`)
      .set(authHeader(accessToken))
      .send({ price: 130 })
      .expect(200)
    const bumped = await prisma.offer.findUniqueOrThrow({ where: { id: defaultOfferId } })
    expect(bumped.price).toBe(130)

    // 唯一规格不能删除,只能下架。
    const res = await api
      .delete(`/api/merchant/products/${product.id}/offers/${defaultOfferId}`)
      .set(authHeader(accessToken))
      .expect(400)
    expect(res.body.error.message).toContain('至少保留一个规格')
  })

  it('deletes an unused extra offer but forces inactive-only for offers with orders', async () => {
    await createTestUser('crud-order@test.local', 'pass123', 'user', 5000)
    const { merchant, accessToken } = await setupMerchant('crud-order-m@test.local')
    const product = await createTestProduct('带单规格商品', 100, 2, ['CO-1', 'CO-2'], merchant.id)
    const offerA = await getDefaultOfferId(product.id)

    // 无库存无订单的额外规格 → 可直接删除。
    const spare = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '临时规格', price: 500, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)
    await api
      .delete(`/api/merchant/products/${product.id}/offers/${spare.body.id}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(await prisma.offer.count({ where: { id: spare.body.id } })).toBe(0)

    // 给 offerA 下一笔订单后,它只能下架不能删除。
    const buyer = await loginAs('crud-order@test.local', 'pass123')
    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, offerId: offerA, expectedPrice: 100 })
      .expect(201)

    // 需要至少两个规格才能触发"订单保护"而非"最后一个规格"分支。
    await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '保留规格', price: 100, deliveryMode: 'instant_inventory' })
      .expect(201)

    const res = await api
      .delete(`/api/merchant/products/${product.id}/offers/${offerA}`)
      .set(authHeader(accessToken))
      .expect(400)
    expect(res.body.error.message).toContain('只能下架不能删除')
  })
})

describe('P4a F1 — explicit default offer (isDefault)', () => {
  it('transfers the default via isDefault:true and keeps exactly one default per product', async () => {
    const { merchant, accessToken } = await setupMerchant('default-transfer@test.local')
    const product = await createTestProduct('默认转移商品', 100, 1, ['DT-1'], merchant.id)
    const original = await getDefaultOfferId(product.id)

    const extra = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '高级规格', price: 200, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)
    // 新建规格不抢默认。
    expect(extra.body.isDefault).toBe(false)

    await api
      .put(`/api/merchant/products/${product.id}/offers/${extra.body.id}`)
      .set(authHeader(accessToken))
      .send({ isDefault: true })
      .expect(200)

    const offers = await prisma.offer.findMany({ where: { productId: product.id } })
    expect(offers.filter(o => o.isDefault).map(o => o.id)).toEqual([extra.body.id])
    expect(offers.find(o => o.id === original)?.isDefault).toBe(false)
    // 投影列跟随新默认（deliveryMode 取默认 Offer 的配置）。
    const projected = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(projected.deliveryMode).toBe('manual_service')
  })

  it('rejects directly unsetting the default (isDefault:false) with 400', async () => {
    const { merchant, accessToken } = await setupMerchant('default-unset@test.local')
    const product = await createTestProduct('默认取消商品', 100, 1, ['DU-1'], merchant.id)
    const defaultOfferId = await getDefaultOfferId(product.id)

    const res = await api
      .put(`/api/merchant/products/${product.id}/offers/${defaultOfferId}`)
      .set(authHeader(accessToken))
      .send({ isDefault: false })
      .expect(400)
    expect(res.body.error.message).toContain('不能直接取消默认规格')

    // 非默认规格传 false 是幂等空操作。
    const extra = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '次要规格', price: 300, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)
    await api
      .put(`/api/merchant/products/${product.id}/offers/${extra.body.id}`)
      .set(authHeader(accessToken))
      .send({ isDefault: false })
      .expect(200)
    expect(await prisma.offer.count({ where: { productId: product.id, isDefault: true } })).toBe(1)
  })

  it('auto-promotes the lowest-sortOrder survivor when the default offer is deleted', async () => {
    const { merchant, accessToken } = await setupMerchant('default-promote@test.local')
    // manual_service 默认规格：无库存条目，允许删除。
    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '默认删除商品', type: '共享账号', price: 100, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)
    const productId = created.body.id
    const defaultOfferId = await getDefaultOfferId(productId)

    const late = await api
      .post(`/api/merchant/products/${productId}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '排序靠后', price: 200, deliveryMode: 'manual_service', stockMode: 'unlimited', sortOrder: 20 })
      .expect(201)
    const early = await api
      .post(`/api/merchant/products/${productId}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '排序靠前', price: 300, deliveryMode: 'manual_service', stockMode: 'unlimited', sortOrder: 5 })
      .expect(201)

    await api
      .delete(`/api/merchant/products/${productId}/offers/${defaultOfferId}`)
      .set(authHeader(accessToken))
      .expect(200)

    const offers = await prisma.offer.findMany({ where: { productId } })
    expect(offers.filter(o => o.isDefault).map(o => o.id)).toEqual([early.body.id])
    expect(offers.find(o => o.id === late.body.id)?.isDefault).toBe(false)
  })
})

describe('P4a F3 — atomic wizard publish (product + offers in one transaction)', () => {
  it('creates the product, renamed primary offer, and extra offers in one call', async () => {
    const { accessToken } = await setupMerchant('atomic-publish@test.local')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '原子发布商品',
        type: '共享账号',
        price: 100,
        deliveryMode: 'instant_inventory',
        primaryOfferName: '月卡',
        offers: [
          { name: '季卡', price: 270, deliveryMode: 'instant_inventory' },
          { name: '年卡', price: 900, deliveryMode: 'manual_service', stockMode: 'unlimited', sortOrder: 10 },
        ],
      })
      .expect(201)

    const offers = await prisma.offer.findMany({
      where: { productId: created.body.id },
      orderBy: { id: 'asc' },
    })
    expect(offers.map(o => o.name)).toEqual(['月卡', '季卡', '年卡'])
    // 主规格是默认规格；附加规格不抢默认。
    expect(offers.filter(o => o.isDefault).map(o => o.name)).toEqual(['月卡'])
    // 返回的投影已按全部规格同步（最低价 = 月卡 100）。
    expect(created.body.price).toBe(100)
  })

  it('rolls back the whole creation when any extra offer is invalid', async () => {
    const { merchant, accessToken } = await setupMerchant('atomic-rollback@test.local')

    const res = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '回滚商品',
        type: '共享账号',
        price: 100,
        deliveryMode: 'instant_inventory',
        offers: [
          // instant_fixed 必须携带 fixedContent —— 服务层校验失败。
          { name: '坏规格', price: 200, deliveryMode: 'instant_fixed' },
        ],
      })
      .expect(400)
    expect(res.body.error.message).toBeTruthy()

    // 无孤儿商品、无孤儿规格。
    expect(await prisma.product.count({ where: { merchantId: merchant.id } })).toBe(0)
    const products = await prisma.product.findMany({ where: { merchantId: merchant.id }, select: { id: true } })
    expect(await prisma.offer.count({ where: { productId: { in: products.map(p => p.id) } } })).toBe(0)
  })
})

describe('P5 T2 — checkoutVersion covers fixedFileId', () => {
  it('changes the version when the fixed file changes and stays byte-stable for non-file offers', async () => {
    const { computeOfferCheckoutVersion } = await import('../lib/offers.js')
    const base = {
      id: 1, productId: 1, name: '文件规格', price: 100, originalPrice: null,
      status: 'active', deliveryMode: 'instant_fixed', stockMode: 'unlimited',
      stock: 0, fixedContent: null, fixedContentType: 'file', deliveryFields: null,
      sales: 0, sortOrder: 0, isDefault: false, createdAt: new Date(0),
    }
    const v1 = computeOfferCheckoutVersion({ ...base, fixedFileId: 11 } as any)
    const v2 = computeOfferCheckoutVersion({ ...base, fixedFileId: 12 } as any)
    const vNull = computeOfferCheckoutVersion({ ...base, fixedFileId: null } as any)
    expect(v1).not.toBe(v2)          // 换文件 → 版本变 → 下单 409 重新确认
    expect(v1).not.toBe(vNull)

    // 幂等兼容：null 不进 canonical——与"字段不存在的旧对象"逐字节同摘要。
    const legacy = computeOfferCheckoutVersion(base as any)
    expect(vNull).toBe(legacy)
  })
})
