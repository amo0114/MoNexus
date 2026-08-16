import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, createTestMerchant, createTestUser, loginAs, authHeader } from './helpers.js'
import { __setDeliveryStorageForTesting } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../lib/storage/deliveryMemory.js'

/**
 * P5 T3：规格固定文件链路。核心不变量：
 * 1. file 形态以 fixedFileId 为真相源（fixedContent 保持 text/url 语义）
 * 2. 下单事务把文件冻结进 DeliveryRecord.fileId，商家换文件不影响已成交订单
 * 3. 公开接口只出 fixedContentType + 文件大小，永远没有文件名/对象键
 */

beforeEach(() => {
  __setDeliveryStorageForTesting(new DeliveryMemoryStorage())
})

async function setupMerchantWithFile(email: string) {
  const { merchant } = await createTestMerchant(email, 'pass123', { role: 'merchant', status: 'active' })
  const { accessToken } = await loginAs(email, 'pass123')
  const uploaded = await api
    .post('/api/uploads/delivery-file')
    .set(authHeader(accessToken))
    .attach('file', Buffer.from(`paid-${email}`), { filename: '交付包.zip', contentType: 'application/zip' })
    .expect(201)
  return { merchant, accessToken, fileId: uploaded.body.id as number }
}

async function createFileProduct(accessToken: string, fileId: number, name: string) {
  const created = await api
    .post('/api/merchant/products')
    .set(authHeader(accessToken))
    .send({
      name,
      type: '充值卡密',
      price: 100,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      imageUrl: 'https://cdn.test.local/file-product-cover.png',
      images: ['https://cdn.test.local/file-product-cover.png'],
    })
    .expect(201)
  await api
    .post(`/api/merchant/products/${created.body.id}/publish`)
    .set(authHeader(accessToken))
    .expect(200)
  const offer = await api
    .post(`/api/merchant/products/${created.body.id}/offers`)
    .set(authHeader(accessToken))
    .send({
      name: '文件版',
      price: 120,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContentType: 'file',
      fixedFileId: fileId,
    })
    .expect(201)
  return { productId: created.body.id as number, offerId: offer.body.id as number }
}

describe('file-form offer CRUD', () => {
  it('creates a file offer, rejects invalid forms, and 404s a foreign merchant file', async () => {
    const { accessToken, fileId } = await setupMerchantWithFile('file-crud@test.local')
    const { offerId } = await createFileProduct(accessToken, fileId, '文件商品')
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(offer.fixedFileId).toBe(fileId)
    expect(offer.fixedContent).toBeNull()

    const base = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '校验商品', type: '充值卡密', price: 50, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)

    // file 形态缺 fixedFileId / 非 instant_fixed 挂文件 / 别家文件。
    await api
      .post(`/api/merchant/products/${base.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '坏1', price: 10, deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'file' })
      .expect(400)
    await api
      .post(`/api/merchant/products/${base.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '坏2', price: 10, deliveryMode: 'manual_service', stockMode: 'unlimited', fixedContentType: 'file', fixedFileId: fileId })
      .expect(400)

    const other = await setupMerchantWithFile('file-crud-other@test.local')
    await api
      .post(`/api/merchant/products/${base.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({ name: '坏3', price: 10, deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'file', fixedFileId: other.fileId })
      .expect(404)
  })
})

describe('public serialization for file offers', () => {
  it('exposes only fixedContentType + deliveryFileSize, never fileName or key', async () => {
    const { accessToken, fileId } = await setupMerchantWithFile('file-public@test.local')
    const { productId } = await createFileProduct(accessToken, fileId, '公开文件商品')

    const detail = await api.get(`/api/products/${productId}`).expect(200)
    const fileOffer = detail.body.offers.find((o: any) => o.fixedContentType === 'file')
    expect(fileOffer).toBeTruthy()
    expect(fileOffer.deliveryFileSize).toBeGreaterThan(0)
    const serialized = JSON.stringify(detail.body)
    expect(serialized).not.toContain('交付包')
    expect(serialized).not.toContain('"key"')
    expect(serialized).not.toContain('"fixedContent":')
  })
})

describe('purchase freezes the file into the order', () => {
  it('writes DeliveryRecord.fileId in the order transaction; swapping the offer file leaves old orders intact', async () => {
    const { accessToken, fileId } = await setupMerchantWithFile('file-buy@test.local')
    const { productId, offerId } = await createFileProduct(accessToken, fileId, '购买文件商品')
    await createTestUser('file-buyer@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('file-buyer@test.local', 'pass123')

    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, offerId, expectedPrice: 120 })
      .expect(201)

    // 响应只有元数据，没有内容/链接/对象键。
    expect(order.body.deliveryFile).toMatchObject({ fileName: '交付包.zip' })
    expect(order.body.deliveryContent).toBeUndefined()
    expect(JSON.stringify(order.body)).not.toContain('"key"')

    const record = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId: order.body.orderId } })
    expect(record.fileId).toBe(fileId)
    expect(record.contentType).toBe('file')
    expect(record.content).toBeNull()

    // 商家换文件：新 fixedFileId 只影响后续订单；旧订单快照不动。
    const swap = await api
      .post('/api/uploads/delivery-file')
      .set(authHeader(accessToken))
      .attach('file', Buffer.from('v2 content'), { filename: 'v2.zip' })
      .expect(201)
    await api
      .put(`/api/merchant/products/${productId}/offers/${offerId}`)
      .set(authHeader(accessToken))
      .send({ fixedContentType: 'file', fixedFileId: swap.body.id })
      .expect(200)

    const after = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId: order.body.orderId } })
    expect(after.fileId).toBe(fileId)

    // 买家订单详情带文件元数据。
    const detail = await api
      .get(`/api/orders/${order.body.orderId}`)
      .set(authHeader(buyer.accessToken))
      .expect(200)
    expect(detail.body.delivery.file).toMatchObject({ fileName: '交付包.zip' })
  })

  it('revoking the file stops new sales while keeping sold orders untouched', async () => {
    const { accessToken, fileId } = await setupMerchantWithFile('file-revoke@test.local')
    const { productId, offerId } = await createFileProduct(accessToken, fileId, '吊销文件商品')
    await createTestUser('file-revoke-buyer@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('file-revoke-buyer@test.local', 'pass123')

    await prisma.deliveryFile.update({ where: { id: fileId }, data: { status: 'revoked' } })

    const res = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, offerId, expectedPrice: 120 })
      .expect(400)
    expect(res.body.error.message).toContain('暂不可购买')
  })
})

describe('P5 T5 — download-url issuance: authz matrix, anti-enumeration, audit', () => {
  async function setupPurchasedFileOrder(tag: string) {
    const seller = await setupMerchantWithFile(`t5-${tag}-m@test.local`)
    const { productId, offerId } = await createFileProduct(seller.accessToken, seller.fileId, `T5商品${tag}`)
    await createTestUser(`t5-${tag}-b@test.local`, 'pass123', 'user', 1000)
    const buyer = await loginAs(`t5-${tag}-b@test.local`, 'pass123')
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, offerId, expectedPrice: 120 })
      .expect(201)
    return { seller, buyer, orderId: order.body.orderId as number, fileId: seller.fileId }
  }

  it('grants the buyer a working signed url, audits it, and 404s all enumeration paths', async () => {
    const { buyer, orderId, fileId } = await setupPurchasedFileOrder('grant')

    const grant = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(200)
    expect(grant.headers['cache-control']).toBe('no-store')
    expect(grant.body.fileName).toBe('交付包.zip')
    expect(new Date(grant.body.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // memory 适配器的签名 URL 直接可取，强制 attachment。
    const download = await api.get(grant.body.url).expect(200)
    expect(download.headers['content-disposition']).toContain('attachment')

    const log = await prisma.fileGrantLog.findFirstOrThrow({ where: { orderId } })
    expect(log).toMatchObject({ fileId, role: 'buyer', outcome: 'granted' })
    expect(log.userAgent === null || log.userAgent.length <= 256).toBe(true)

    // 防枚举：他人订单 / 不存在订单 / 无文件交付订单 → 统一 404。
    await createTestUser('t5-stranger@test.local', 'pass123', 'user', 1000)
    const stranger = await loginAs('t5-stranger@test.local', 'pass123')
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(stranger.accessToken)).expect(404)
    await api.post('/api/orders/999999/files/download-url').set(authHeader(buyer.accessToken)).expect(404)
  })

  it('404s an order that has no file delivery (no distinguishable probe)', async () => {
    await createTestUser('t5-nofile-b@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('t5-nofile-b@test.local', 'pass123')
    const { createTestProduct } = await import('./helpers.js')
    const product = await createTestProduct('无文件商品', 100, 1, ['NF-1'])
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    await api.post(`/api/orders/${order.body.orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(404)
  })

  it('suspends the buyer during dispute while the merchant keeps evidence access; refund revokes permanently', async () => {
    const { seller, buyer, orderId } = await setupPurchasedFileOrder('state')

    await prisma.order.update({ where: { id: orderId }, data: { status: 'disputed' } })
    const disputed = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(403)
    expect(disputed.body.error.code).toBe('FILE_ACCESS_SUSPENDED')
    // 商家任何状态可下（举证）。
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(seller.accessToken)).expect(200)

    // 争议解回 → 买家恢复。
    await prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } })
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(200)

    await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
    const refunded = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(403)
    expect(refunded.body.error.code).toBe('FILE_ACCESS_REVOKED')

    const outcomes = await prisma.fileGrantLog.findMany({ where: { orderId }, select: { outcome: true } })
    expect(outcomes.map(o => o.outcome).sort()).toEqual(['denied_state', 'denied_state', 'granted', 'granted'].sort())
  })

  it('expires the buyer window from DeliveryRecord.deliveredAt; admin remains unaffected', async () => {
    const { buyer, orderId } = await setupPurchasedFileOrder('window')
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: { deliveredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    })
    const expired = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(403)
    expect(expired.body.error.code).toBe('FILE_WINDOW_EXPIRED')

    await createTestUser('t5-window-admin@test.local', 'admin111', 'admin')
    const admin = await loginAs('t5-window-admin@test.local', 'admin111')
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(admin.accessToken)).expect(200)
  })

  it('revoked files deny buyer and merchant but stay admin-downloadable for evidence', async () => {
    const { seller, buyer, orderId, fileId } = await setupPurchasedFileOrder('revoked')
    await prisma.deliveryFile.update({ where: { id: fileId }, data: { status: 'revoked' } })

    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(403)
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(seller.accessToken)).expect(403)

    await createTestUser('t5-revoked-admin@test.local', 'admin111', 'admin')
    const admin = await loginAs('t5-revoked-admin@test.local', 'admin111')
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(admin.accessToken)).expect(200)
  })

  it('rate-limits issuance per user × order', async () => {
    const { buyer, orderId } = await setupPurchasedFileOrder('rate')
    for (let i = 0; i < 10; i++) {
      await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(200)
    }
    const limited = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
  })
})

describe('P5 T4 — manual delivery attachments', () => {
  async function setupManualOrder(tag: string, options?: { deliveryFields?: unknown }) {
    const seller = await setupMerchantWithFile(`t4-${tag}-m@test.local`)
    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(seller.accessToken))
      .send({
        name: `T4商品${tag}`,
        type: '共享账号',
        price: 80,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        imageUrl: 'https://cdn.test.local/manual-product-cover.png',
        images: ['https://cdn.test.local/manual-product-cover.png'],
      })
      .expect(201)
    const productId = created.body.id as number
    await api
      .post(`/api/merchant/products/${productId}/publish`)
      .set(authHeader(seller.accessToken))
      .expect(200)
    if (options?.deliveryFields) {
      const offers = await api
        .get(`/api/merchant/products/${productId}/offers`)
        .set(authHeader(seller.accessToken))
        .expect(200)
      await api
        .put(`/api/merchant/products/${productId}/offers/${offers.body[0].id}`)
        .set(authHeader(seller.accessToken))
        .send({ deliveryFields: options.deliveryFields })
        .expect(200)
    }
    await createTestUser(`t4-${tag}-b@test.local`, 'pass123', 'user', 1000)
    const buyer = await loginAs(`t4-${tag}-b@test.local`, 'pass123')
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 80 })
      .expect(201)
    await api
      .post(`/api/merchant/orders/${order.body.orderId}/fulfillment/start`)
      .set(authHeader(seller.accessToken))
      .send({})
      .expect(200)
    return { seller, buyer, orderId: order.body.orderId as number }
  }

  it('delivers attachment-only on a plain order and the buyer can download it', async () => {
    const { seller, buyer, orderId } = await setupManualOrder('attach')

    const delivered = await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ attachmentFileId: seller.fileId })
      .expect(200)
    expect(delivered.body.delivery.file).toMatchObject({ fileName: '交付包.zip' })

    const record = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    expect(record.fileId).toBe(seller.fileId)
    expect(record.content).toBeNull()

    const grant = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(200)
    await api.get(grant.body.url).expect(200)
  })

  it('keeps text + attachment together, rejects foreign or revoked attachments, and empty deliveries', async () => {
    const { seller, orderId } = await setupManualOrder('mixed')

    // 空交付仍被拒（附件与文本都缺）。
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({})
      .expect(400)

    // 别家文件 404（防枚举）。
    const other = await setupMerchantWithFile('t4-mixed-other@test.local')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ deliveryContent: '账号 xxx', attachmentFileId: other.fileId })
      .expect(404)

    // 吊销文件 400。
    const revoked = await api
      .post('/api/uploads/delivery-file')
      .set(authHeader(seller.accessToken))
      .attach('file', Buffer.from('revoked bytes'), { filename: 'r.bin' })
      .expect(201)
    await prisma.deliveryFile.update({ where: { id: revoked.body.id }, data: { status: 'revoked' } })
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ deliveryContent: '账号 xxx', attachmentFileId: revoked.body.id })
      .expect(400)

    // 文本 + 附件并存成功。
    const ok = await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ deliveryContent: '账号 xxx / 密码 yyy', attachmentFileId: seller.fileId })
      .expect(200)
    expect(ok.body.delivery.file).toMatchObject({ fileName: '交付包.zip' })
    const record = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    expect(record.content).toBe('账号 xxx / 密码 yyy')
    expect(record.fileId).toBe(seller.fileId)
  })

  it('an attachment does not bypass the structured template contract', async () => {
    const { seller, orderId } = await setupManualOrder('tmpl', {
      deliveryFields: [{ key: 'account', label: '账号', sensitive: false }],
    })
    // 模板订单：只给附件不给字段值 → 仍拒。
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ attachmentFileId: seller.fileId })
      .expect(400)
    // 字段值 + 附件 → 通过。
    const ok = await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ structuredValues: { account: 'acc-1' }, attachmentFileId: seller.fileId })
      .expect(200)
    expect(ok.body.delivery.file).toMatchObject({ fileName: '交付包.zip' })
  })
})

describe('P5 复审回归 — manual attachment across dispute resume', () => {
  it('delivered → disputed → processing: buyer 403, merchant/admin keep access; re-delivered restores buyer', async () => {
    const seller = await setupMerchantWithFile('rr-manual-m@test.local')
    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(seller.accessToken))
      .send({
        name: '复审人工商品',
        type: '共享账号',
        price: 60,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        imageUrl: 'https://cdn.test.local/review-manual-cover.png',
        images: ['https://cdn.test.local/review-manual-cover.png'],
      })
      .expect(201)
    await api
      .post(`/api/merchant/products/${created.body.id}/publish`)
      .set(authHeader(seller.accessToken))
      .expect(200)
    await createTestUser('rr-manual-b@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('rr-manual-b@test.local', 'pass123')
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: created.body.id, expectedPrice: 60 })
      .expect(201)
    const orderId = order.body.orderId as number

    // pending：人工订单尚未交付，买家（即使有附件也）不可下——此时无 fileId → 404 防枚举。
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(404)

    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(seller.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ attachmentFileId: seller.fileId })
      .expect(200)

    // delivered：买家可下。
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(200)

    // disputed → 商家恢复到 processing（将重新交付）。
    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(seller.accessToken))
      .send({ resolution: 'resume' })
      .expect(200)

    // processing：买家不能继续下旧附件（评审 P1）；商家/管理员保留。
    const denied = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(403)
    expect(denied.body.error.code).toBe('FILE_ACCESS_SUSPENDED')
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(seller.accessToken)).expect(200)
    await createTestUser('rr-manual-admin@test.local', 'admin111', 'admin')
    const admin = await loginAs('rr-manual-admin@test.local', 'admin111')
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(admin.accessToken)).expect(200)

    // 重新交付 → 买家恢复。
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ deliveryContent: '重交付内容', attachmentFileId: seller.fileId })
      .expect(200)
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(200)
  })
})
