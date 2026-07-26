import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  getDefaultOfferId,
  makeManualService,
  loginAs,
  loginAsMerchant,
  authHeader,
} from './helpers.js'
import {
  canonicalDeliveryText,
  parseStructuredImportRow,
  deliveryFieldsSchema,
  type DeliveryField,
} from '../lib/deliveryFields.js'

/**
 * P4b T5：结构化库存导入与结构化交付。锁定契约、canonical 文本与唯一约束互动、
 * 快照隔离(商家改模板不影响已导入/已交付)、敏感值序列化边界。
 * 纯文本(无模板)回归由既有全量用例覆盖——模板为空时所有路径行为不变。
 */

const TEMPLATE: DeliveryField[] = [
  { key: 'account', label: '账号', sensitive: false },
  { key: 'password', label: '密码', sensitive: true },
  { key: 'region', label: '地区', sensitive: false },
]

async function setupMerchant(email: string) {
  const { merchant } = await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: '结构化商家',
  })
  const { accessToken } = await loginAsMerchant(email, 'pass123')
  return { merchant, accessToken }
}

/** 建一个默认规格带模板的即时库存商品，返回 { product, offerId }。 */
async function setupTemplatedProduct(accessToken: string, merchantId: number, name: string) {
  const product = await createTestProduct(name, 100, 0, [], merchantId)
  const offerId = await getDefaultOfferId(product.id)
  await api
    .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
    .set(authHeader(accessToken))
    .send({ deliveryFields: TEMPLATE })
    .expect(200)
  return { product, offerId }
}

describe('P4b — delivery fields contract', () => {
  it('parses import rows with | separator and \\| escaping', () => {
    const ok = parseStructuredImportRow(TEMPLATE, 'user@a.com | p\\|wd | US')
    expect(ok).toEqual({ values: { account: 'user@a.com', password: 'p|wd', region: 'US' } })

    expect(parseStructuredImportRow(TEMPLATE, 'only | two')).toHaveProperty('error')
    expect(parseStructuredImportRow(TEMPLATE, 'a |  | US')).toHaveProperty('error')
  })

  it('rejects invalid templates (dup keys, bad identifiers, >8 fields)', () => {
    expect(deliveryFieldsSchema.safeParse([
      { key: 'a', label: 'A', sensitive: false },
      { key: 'a', label: 'B', sensitive: false },
    ]).success).toBe(false)
    expect(deliveryFieldsSchema.safeParse([{ key: '1bad', label: 'A', sensitive: false }]).success).toBe(false)
    expect(deliveryFieldsSchema.safeParse(
      Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, sensitive: false }))
    ).success).toBe(false)
  })

  it('rejects a delivery-fields template on instant_fixed offers', async () => {
    const { merchant, accessToken } = await setupMerchant('sd-fixed@test.local')
    const product = await createTestProduct('固定内容模板拒绝', 100, 1, ['f-1'], merchant.id)

    const res = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '固定档',
        price: 100,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'FIXED',
        deliveryFields: TEMPLATE,
      })
      .expect(400)
    expect(res.body.error.message).toContain('不支持交付字段模板')
  })
})

describe('P4b — structured import', () => {
  it('imports template rows as canonical text + snapshot, and dedupes on canonical text', async () => {
    const { merchant, accessToken } = await setupMerchant('sd-import@test.local')
    const { product, offerId } = await setupTemplatedProduct(accessToken, merchant.id, '结构化导入商品')

    const res = await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ offerId, items: ['u1@a.com | pw1 | US', 'u2@a.com | pw2 | JP'] })
      .expect(200)
    expect(res.body.imported).toBe(2)

    const items = await prisma.inventoryItem.findMany({ where: { offerId }, orderBy: { id: 'asc' } })
    expect(items).toHaveLength(2)
    // content = 规范化文本（权威形态），structuredContent = 自包含快照
    expect(items[0].content).toBe(canonicalDeliveryText(TEMPLATE, { account: 'u1@a.com', password: 'pw1', region: 'US' }))
    expect(items[0].structuredContent).toMatchObject({ values: { account: 'u1@a.com', password: 'pw1', region: 'US' } })

    // 同一 canonical 文本再次导入 → 与既有库存重复被拒
    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ offerId, items: ['u1@a.com | pw1 | US'] })
      .expect(400)
  })

  it('rejects malformed rows with row-level errors and imports nothing', async () => {
    const { merchant, accessToken } = await setupMerchant('sd-rows@test.local')
    const { product, offerId } = await setupTemplatedProduct(accessToken, merchant.id, '行错误商品')

    const res = await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ offerId, items: ['good@a.com | pw | US', 'missing-parts'] })
      .expect(400)
    expect(JSON.stringify(res.body.error.details ?? res.body.error)).toContain('第 2 行')
    expect(await prisma.inventoryItem.count({ where: { offerId } })).toBe(0)
  })

  it('preview returns the parsed table and row errors without writing', async () => {
    const { merchant, accessToken } = await setupMerchant('sd-preview@test.local')
    const { product, offerId } = await setupTemplatedProduct(accessToken, merchant.id, '预览商品')

    const res = await api
      .post(`/api/merchant/products/${product.id}/inventory/preview`)
      .set(authHeader(accessToken))
      .send({ offerId, text: 'u@a.com | pw | US\nbad-row' })
      .expect(200)
    expect(res.body.canImport).toBe(false)
    expect(res.body.rowErrors).toHaveLength(1)
    expect(res.body.structured.fields.map((f: { key: string }) => f.key)).toEqual(['account', 'password', 'region'])
    expect(res.body.structured.rows[0]).toEqual({ account: 'u@a.com', password: 'pw', region: 'US' })
    expect(await prisma.inventoryItem.count({ where: { offerId } })).toBe(0)
  })
})

describe('P4b — structured claim & snapshot isolation', () => {
  it('delivers the item snapshot on purchase and keeps it after the merchant edits the template', async () => {
    await createTestUser('sd-buyer@test.local', 'pass123', 'user', 1000)
    const { merchant, accessToken } = await setupMerchant('sd-claim@test.local')
    const { product, offerId } = await setupTemplatedProduct(accessToken, merchant.id, '结构化购买商品')
    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ offerId, items: ['buyer@a.com | secret | EU'] })
      .expect(200)

    const buyer = await loginAs('sd-buyer@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    // 下单响应携带结构化交付（成功弹窗字段化展示的数据源）
    expect(created.body.deliveryStructuredContent.values).toEqual({
      account: 'buyer@a.com', password: 'secret', region: 'EU',
    })

    // 商家改模板：不影响已成交订单的快照
    await api
      .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ deliveryFields: [{ key: 'newkey', label: '新字段', sensitive: false }] })
      .expect(200)

    const detail = await api
      .get(`/api/orders/${created.body.orderId}`)
      .set(authHeader(buyer.accessToken))
      .expect(200)
    expect(detail.body.delivery.structuredContent.fields.map((f: { key: string }) => f.key))
      .toEqual(['account', 'password', 'region'])
    expect(detail.body.delivery.structuredContent.values.password).toBe('secret')
  })

  it('strips structuredContent from the order LIST (same boundary as content)', async () => {
    await createTestUser('sd-list@test.local', 'pass123', 'user', 1000)
    const { merchant, accessToken } = await setupMerchant('sd-listm@test.local')
    const { product, offerId } = await setupTemplatedProduct(accessToken, merchant.id, '列表边界商品')
    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ offerId, items: ['leak@a.com | topsecret | KR'] })
      .expect(200)

    const buyer = await loginAs('sd-list@test.local', 'pass123')
    await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)

    const list = await api.get('/api/orders').set(authHeader(buyer.accessToken)).expect(200)
    const body = JSON.stringify(list.body)
    expect(body).not.toContain('topsecret')
    expect(body).not.toContain('structuredContent')
  })

  it('manual_service structured deliver validates fields, snapshots them, and writes canonical text', async () => {
    await createTestUser('sd-manual-buyer@test.local', 'pass123', 'user', 1000)
    const { merchant, accessToken } = await setupMerchant('sd-manual@test.local')
    const product = await createTestProduct('结构化人工服务', 200, 0, [], merchant.id)
    await makeManualService(product.id)
    const offerId = await getDefaultOfferId(product.id)
    await api
      .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ deliveryFields: TEMPLATE })
      .expect(200)

    const buyer = await loginAs('sd-manual-buyer@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/start`)
      .set(authHeader(accessToken))
      .send({})
      .expect(200)

    // 缺字段 → 400
    await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/deliver`)
      .set(authHeader(accessToken))
      .send({ structuredValues: { account: 'm@a.com' } })
      .expect(400)

    await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/deliver`)
      .set(authHeader(accessToken))
      .send({ structuredValues: { account: 'm@a.com', password: 'mpw', region: 'HK' } })
      .expect(200)

    const record = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId: created.body.orderId } })
    expect(record.content).toBe(canonicalDeliveryText(TEMPLATE, { account: 'm@a.com', password: 'mpw', region: 'HK' }))
    expect(record.structuredContent).toMatchObject({ values: { password: 'mpw' } })
  })

  it('rejects import rows containing newlines via the items array path', async () => {
    const { merchant, accessToken } = await setupMerchant('sd-newline@test.local')
    const { product, offerId } = await setupTemplatedProduct(accessToken, merchant.id, '换行拒绝商品')

    // items 数组允许单条字符串携带换行——必须按行级错误拒绝，否则破坏
    // "一行一条库存"语义与规范化文本唯一性。
    const res = await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ offerId, items: ['a@b.com | pw | US\nsneaky@b.com | pw2 | JP'] })
      .expect(400)
    expect(JSON.stringify(res.body.error)).toContain('换行')
    expect(await prisma.inventoryItem.count({ where: { offerId } })).toBe(0)
  })

  it('public offer serialization exposes the template but plain-template products stay unchanged', async () => {
    const { merchant, accessToken } = await setupMerchant('sd-public@test.local')
    const { product } = await setupTemplatedProduct(accessToken, merchant.id, '模板公开商品')

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(detail.body.offers[0].deliveryFields.map((f: { key: string }) => f.key))
      .toEqual(['account', 'password', 'region'])

    // 无模板商品：deliveryFields 为空数组，其余契约不变
    const plain = await createTestProduct('纯文本商品', 100, 1, ['plain-1'], merchant.id)
    const plainDetail = await api.get(`/api/products/${plain.id}`).expect(200)
    expect(plainDetail.body.offers[0].deliveryFields).toEqual([])
  })
})

describe('P4b review fixes — offer checkout version', () => {
  it('rejects a stale checkout version with 409 CHECKOUT_CHANGED after the merchant edits the template', async () => {
    await createTestUser('cv-buyer@test.local', 'pass123', 'user', 1000)
    const { merchant, accessToken } = await setupMerchant('cv-merchant@test.local')
    const { product, offerId } = await setupTemplatedProduct(accessToken, merchant.id, '版本锁定商品')
    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ offerId, items: ['cv@a.com | pw | US'] })
      .expect(200)

    const buyer = await loginAs('cv-buyer@test.local', 'pass123')
    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: product.id })
      .set(authHeader(buyer.accessToken))
      .expect(200)
    const staleVersion = preview.body.checkoutVersion as string
    expect(staleVersion).toBeTruthy()

    // 买家确认前商家改模板：买家看到的"将获得账号/密码/地区"已不成立
    await api
      .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ deliveryFields: [{ key: 'card', label: '卡密', sensitive: true }] })
      .expect(200)

    const rejected = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, expectedPrice: 100, expectedCheckoutVersion: staleVersion })
      .expect(409)
    expect(rejected.body.error.code).toBe('CHECKOUT_CHANGED')

    // 重新报价拿到新版本后成交
    const fresh = await api
      .get('/api/checkout/preview')
      .query({ productId: product.id })
      .set(authHeader(buyer.accessToken))
      .expect(200)
    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, expectedPrice: 100, expectedCheckoutVersion: fresh.body.checkoutVersion })
      .expect(201)
  })

  it('rejects a stale version when the delivery mode / fixed content changes at the same price', async () => {
    await createTestUser('cv-mode-buyer@test.local', 'pass123', 'user', 1000)
    const { merchant, accessToken } = await setupMerchant('cv-mode@test.local')
    const product = await createTestProduct('模式变更商品', 100, 0, [], merchant.id)
    await makeManualService(product.id)
    const offerId = await getDefaultOfferId(product.id)

    const buyer = await loginAs('cv-mode-buyer@test.local', 'pass123')
    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: product.id })
      .set(authHeader(buyer.accessToken))
      .expect(200)

    // 价格不变，仅换履约方式（无库存无订单的规格允许换模式）
    await api
      .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContent: 'FIXED-AFTER-PREVIEW' })
      .expect(200)

    const rejected = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, expectedPrice: 100, expectedCheckoutVersion: preview.body.checkoutVersion })
      .expect(409)
    expect(rejected.body.error.code).toBe('CHECKOUT_CHANGED')
  })

  it('old clients that omit the version keep working', async () => {
    await createTestUser('cv-legacy@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('旧客户端商品', 100, 1, ['legacy-cv-1'])
    const buyer = await loginAs('cv-legacy@test.local', 'pass123')
    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
  })
})

describe('P4b review fixes — deliver enforcement by order snapshot', () => {
  async function setupPendingManualOrder(prefix: string, withTemplate: boolean) {
    await createTestUser(`${prefix}-buyer@test.local`, 'pass123', 'user', 1000)
    const { merchant, accessToken } = await setupMerchant(`${prefix}-merchant@test.local`)
    const product = await createTestProduct(`${prefix}-商品`, 200, 0, [], merchant.id)
    await makeManualService(product.id)
    const offerId = await getDefaultOfferId(product.id)
    if (withTemplate) {
      await api
        .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
        .set(authHeader(accessToken))
        .send({ deliveryFields: TEMPLATE })
        .expect(200)
    }
    const buyer = await loginAs(`${prefix}-buyer@test.local`, 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/start`)
      .set(authHeader(accessToken))
      .send({})
      .expect(200)
    return { accessToken, product, offerId, orderId: created.body.orderId as number }
  }

  it('templated order: rejects {}, plain text, and both-submitted; accepts full structured values', async () => {
    const { accessToken, orderId } = await setupPendingManualOrder('enf-tpl', true)
    const deliver = (body: Record<string, unknown>) =>
      api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`).set(authHeader(accessToken)).send(body)

    // 空对象：不能把必填模板订单标记为已发货且内容为空
    await deliver({}).expect(400)
    // 纯文本：模板订单必须逐字段交付
    await deliver({ deliveryContent: 'plain text delivery' }).expect(400)
    // 双传：意图不明确
    await deliver({
      deliveryContent: 'plain',
      structuredValues: { account: 'a@b.com', password: 'pw', region: 'US' },
    }).expect(400)
    // 完整结构化 → 成交
    await deliver({ structuredValues: { account: 'a@b.com', password: 'pw', region: 'US' } }).expect(200)
  })

  it('plain-text order: rejects structuredValues and empty submissions', async () => {
    const { accessToken, orderId } = await setupPendingManualOrder('enf-plain', false)
    const deliver = (body: Record<string, unknown>) =>
      api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`).set(authHeader(accessToken)).send(body)

    await deliver({ structuredValues: { account: 'x' } }).expect(400)
    await deliver({}).expect(400)
    await deliver({ deliveryContent: 'ok-content' }).expect(200)
  })

  it('a pending manual order keeps its template snapshot after the merchant edits the template', async () => {
    const { accessToken, product, offerId, orderId } = await setupPendingManualOrder('enf-snap', true)

    // 商家改模板：已购未发货订单的契约不变
    await api
      .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ deliveryFields: [{ key: 'newkey', label: '新字段', sensitive: false }] })
      .expect(200)

    // 按"新模板"发货 → 缺旧模板必填字段被拒
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(accessToken))
      .send({ structuredValues: { newkey: 'value' } })
      .expect(400)
    // 按下单时快照的旧模板发货 → 成交，交付记录快照为旧模板
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(accessToken))
      .send({ structuredValues: { account: 's@a.com', password: 'spw', region: 'TW' } })
      .expect(200)

    const record = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    expect((record.structuredContent as { fields: Array<{ key: string }> }).fields.map(f => f.key))
      .toEqual(['account', 'password', 'region'])
  })

  it('merchant and admin order lists never leak structuredContent', async () => {
    await createTestUser('leak-admin@test.local', 'admin123', 'admin')
    await createTestUser('leak-buyer@test.local', 'pass123', 'user', 1000)
    const { merchant, accessToken } = await setupMerchant('leak-merchant@test.local')
    const { product, offerId } = await setupTemplatedProduct(accessToken, merchant.id, '列表泄漏检查商品')
    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ offerId, items: ['leakcheck@a.com | ULTRASECRET | SG'] })
      .expect(200)

    const buyer = await loginAs('leak-buyer@test.local', 'pass123')
    await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)

    const merchantList = await api.get('/api/merchant/orders').set(authHeader(accessToken)).expect(200)
    const merchantBody = JSON.stringify(merchantList.body)
    expect(merchantBody).not.toContain('ULTRASECRET')
    expect(merchantBody).not.toContain('structuredContent')

    const admin = await loginAs('leak-admin@test.local', 'admin123')
    const adminList = await api.get('/api/admin/orders').set(authHeader(admin.accessToken)).expect(200)
    const adminBody = JSON.stringify(adminList.body)
    expect(adminBody).not.toContain('ULTRASECRET')
    expect(adminBody).not.toContain('structuredContent')
  })
})

describe('P4b round-2 fixes — version guard precedes inactive rejection', () => {
  it('deactivating an explicitly selected offer after preview yields 409 CHECKOUT_CHANGED, not 400', async () => {
    await createTestUser('r2-multi-buyer@test.local', 'pass123', 'user', 5000)
    const { merchant, accessToken } = await setupMerchant('r2-multi@test.local')
    // 两个 active 规格，买家显式选第二个
    const product = await createTestProduct('二轮下架商品', 100, 1, ['r2-a-1'], merchant.id)
    const second = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '高级档', price: 300, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)
    const offerId = second.body.id as number

    const buyer = await loginAs('r2-multi-buyer@test.local', 'pass123')
    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: product.id, offerId })
      .set(authHeader(buyer.accessToken))
      .expect(200)

    // 预览后商家下架该规格
    await api
      .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ status: 'inactive' })
      .expect(200)

    // 携带版本 → 409 重新报价（版本判定先于"已下架"400）
    const rejected = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({
        productId: product.id,
        offerId,
        expectedPrice: 300,
        expectedCheckoutVersion: preview.body.checkoutVersion,
      })
      .expect(409)
    expect(rejected.body.error.code).toBe('CHECKOUT_CHANGED')

    // 旧客户端（无版本）语义保持：仍是 400 已下架
    const legacy = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, offerId })
      .expect(400)
    expect(legacy.body.error.message).toContain('已下架')
  })

  it('deactivating the sole active offer after a no-offerId preview yields 409, not 400', async () => {
    await createTestUser('r2-single-buyer@test.local', 'pass123', 'user', 1000)
    const { merchant, accessToken } = await setupMerchant('r2-single@test.local')
    const product = await createTestProduct('二轮单规格下架', 100, 1, ['r2-s-1'], merchant.id)
    const offerId = await getDefaultOfferId(product.id)

    const buyer = await loginAs('r2-single-buyer@test.local', 'pass123')
    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: product.id })
      .set(authHeader(buyer.accessToken))
      .expect(200)

    await api
      .put(`/api/merchant/products/${product.id}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ status: 'inactive' })
      .expect(200)

    const rejected = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({
        productId: product.id,
        expectedPrice: 100,
        expectedCheckoutVersion: preview.body.checkoutVersion,
      })
      .expect(409)
    expect(rejected.body.error.code).toBe('CHECKOUT_CHANGED')
  })
})
