import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  configureDefaultOffer,
  getDefaultOfferId,
  loginAs,
  authHeader,
} from './helpers.js'
import { __setDeliveryStorageForTesting } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../lib/storage/deliveryMemory.js'

/**
 * P6a T2：到期强制。核心不变量：
 * 1. 遮蔽只发生在买家视角（内容已泄露，遮蔽是提示性承诺）；商家/管理员
 *    永远看履约凭据；
 * 2. 文件发放：订阅到期与 fileAccessWindowDays 窗口取较严者，买家 403
 *    FILE_SUBSCRIPTION_EXPIRED，商家不受限；
 * 3. 到期不引入订单状态——列表/详情只多 expiresAt/expired 标志。
 */

const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(() => {
  __setDeliveryStorageForTesting(new DeliveryMemoryStorage())
})

/** 建一个挂在商家名下、默认规格带 validityDays 的订阅商品并完成购买。 */
async function buySubscription(tag: string, options?: { validityDays?: number | null }) {
  const { merchant } = await createTestMerchant(`sub-exp-${tag}-m@test.local`, 'pass123', {
    role: 'merchant',
    status: 'active',
  })
  const seller = await loginAs(`sub-exp-${tag}-m@test.local`, 'pass123')
  const product = await createTestProduct(`订阅商品${tag}`, 100, 3, ['secret-1', 'secret-2', 'secret-3'], merchant.id)
  const offerId = await getDefaultOfferId(product.id)
  await prisma.offer.update({
    where: { id: offerId },
    data: { validityDays: options?.validityDays === undefined ? 30 : options.validityDays },
  })

  await createTestUser(`sub-exp-${tag}-b@test.local`, 'pass123', 'user', 1000)
  const buyer = await loginAs(`sub-exp-${tag}-b@test.local`, 'pass123')
  const order = await api
    .post('/api/orders')
    .set(authHeader(buyer.accessToken))
    .send({ productId: product.id, expectedPrice: 100 })
    .expect(201)
  return { seller, buyer, productId: product.id, offerId, orderId: order.body.orderId as number }
}

describe('buyer masking matrix (text / url / structured)', () => {
  it('text delivery: unexpired shows content; past expiresAt masks content and flags expired', async () => {
    const { seller, buyer, orderId } = await buySubscription('text')

    // 未过期：内容可见，expired=false，无遮蔽标志。
    const fresh = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(fresh.body.delivery.content).toBe('secret-1')
    expect(fresh.body.delivery.expired).toBe(false)
    expect(fresh.body.delivery.contentMasked).toBeUndefined()
    expect(new Date(fresh.body.delivery.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // 直接把到期时刻拨到过去（不依赖真实等待）。
    const pastExpiry = new Date(Date.now() - DAY_MS)
    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: pastExpiry } })

    const expired = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(expired.body.delivery.content).toBeNull()
    expect(expired.body.delivery.structuredContent).toBeNull()
    expect(expired.body.delivery.contentMasked).toBe(true)
    expect(expired.body.delivery.expired).toBe(true)
    expect(new Date(expired.body.delivery.expiresAt).getTime()).toBe(pastExpiry.getTime())
    // 明文绝不出现在响应任何角落。
    expect(JSON.stringify(expired.body)).not.toContain('secret-1')

    // 列表行带 expiresAt/expired 供徽标；内容照旧剥离。
    const list = await api.get('/api/orders').set(authHeader(buyer.accessToken)).expect(200)
    const row = list.body.find((o: { id: number }) => o.id === orderId)
    expect(row.delivery.expired).toBe(true)
    expect(new Date(row.delivery.expiresAt).getTime()).toBe(pastExpiry.getTime())
    expect(row.delivery.content).toBeUndefined()

    // 商家视角永不遮蔽（履约凭据）：到期时刻可见，无遮蔽标志。
    const merchantView = await api
      .get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(seller.accessToken))
      .expect(200)
    expect(new Date(merchantView.body.delivery.expiresAt).getTime()).toBe(pastExpiry.getTime())
    expect(merchantView.body.delivery.contentMasked).toBeUndefined()
  })

  it('url fixed content is masked after expiry while contentType stays visible', async () => {
    const { merchant } = await createTestMerchant('sub-exp-url-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const product = await createTestProduct('URL订阅', 100, 0, [], merchant.id)
    await configureDefaultOffer(product.id, {
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'https://portal.example.com/activate',
      fixedContentType: 'url',
    })
    await prisma.offer.update({ where: { id: await getDefaultOfferId(product.id) }, data: { validityDays: 7 } })

    await createTestUser('sub-exp-url-b@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('sub-exp-url-b@test.local', 'pass123')
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, expectedPrice: 100 })
      .expect(201)

    await prisma.deliveryRecord.update({
      where: { orderId: order.body.orderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const detail = await api.get(`/api/orders/${order.body.orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.delivery.content).toBeNull()
    expect(detail.body.delivery.contentMasked).toBe(true)
    expect(detail.body.delivery.contentType).toBe('url')
    expect(JSON.stringify(detail.body)).not.toContain('portal.example.com')
  })

  it('structured content is masked after expiry', async () => {
    const { buyer, orderId } = await buySubscription('structured')
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: {
        structuredContent: {
          fields: [{ key: 'account', label: '账号', sensitive: true }],
          values: { account: 'acct-secret' },
        },
      },
    })

    const fresh = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(fresh.body.delivery.structuredContent).toBeTruthy()

    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const expired = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(expired.body.delivery.structuredContent).toBeNull()
    expect(expired.body.delivery.contentMasked).toBe(true)
    expect(JSON.stringify(expired.body)).not.toContain('acct-secret')
  })

  it('non-subscription delivery (expiresAt null) never masks and reports expired=false', async () => {
    const { buyer, orderId } = await buySubscription('perpetual', { validityDays: null })
    const detail = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.delivery.expiresAt).toBeNull()
    expect(detail.body.delivery.expired).toBe(false)
    expect(detail.body.delivery.content).toBe('secret-1')
    expect(detail.body.delivery.contentMasked).toBeUndefined()
  })
})

describe('file issuance under subscription expiry', () => {
  /** 文件形态订阅：商家上传文件 → instant_fixed file 规格（validityDays 30）→ 购买。 */
  async function buyFileSubscription(tag: string) {
    await createTestMerchant(`sub-file-${tag}-m@test.local`, 'pass123', { role: 'merchant', status: 'active' })
    const seller = await loginAs(`sub-file-${tag}-m@test.local`, 'pass123')
    const uploaded = await api
      .post('/api/uploads/delivery-file')
      .set(authHeader(seller.accessToken))
      .attach('file', Buffer.from(`sub-bytes-${tag}`), { filename: '订阅包.zip', contentType: 'application/zip' })
      .expect(201)
    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(seller.accessToken))
      .send({ name: `文件订阅${tag}`, type: '充值卡密', price: 100, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)
    const offer = await api
      .post(`/api/merchant/products/${created.body.id}/offers`)
      .set(authHeader(seller.accessToken))
      .send({
        name: '文件月卡',
        price: 120,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContentType: 'file',
        fixedFileId: uploaded.body.id,
        validityDays: 30,
      })
      .expect(201)

    await createTestUser(`sub-file-${tag}-b@test.local`, 'pass123', 'user', 1000)
    const buyer = await loginAs(`sub-file-${tag}-b@test.local`, 'pass123')
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: created.body.id, offerId: offer.body.id, expectedPrice: 120 })
      .expect(201)
    return { seller, buyer, orderId: order.body.orderId as number }
  }

  it('denies the buyer with FILE_SUBSCRIPTION_EXPIRED inside the window; merchant still downloads', async () => {
    const { seller, buyer, orderId } = await buyFileSubscription('expired')

    // 订阅已过期，但 deliveredAt 是刚才——下载窗口（默认 30 天）仍然有效，
    // 拒绝必须归因于订阅到期而非窗口。
    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: new Date(Date.now() - 1000) } })

    const denied = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(403)
    expect(denied.body.error.code).toBe('FILE_SUBSCRIPTION_EXPIRED')

    // 审计 outcome 复用 denied_window（FileGrantLog CHECK 不含新值，见 fileAccess.ts）。
    const log = await prisma.fileGrantLog.findFirstOrThrow({ where: { orderId, role: 'buyer' } })
    expect(log.outcome).toBe('denied_window')

    // 商家不受订阅到期限制（履约凭据）。
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(seller.accessToken)).expect(200)

    // 文件元数据在买家详情仍可见（遮蔽只针对 content/structuredContent）。
    const detail = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.delivery.contentMasked).toBe(true)
    expect(detail.body.delivery.file).toMatchObject({ fileName: '订阅包.zip' })
    expect(detail.body.delivery.file.size).toBeGreaterThan(0)
  })

  it('takes the stricter of window and subscription: window expiry still wins when subscription is alive', async () => {
    const { buyer, orderId } = await buyFileSubscription('window')

    // 订阅还在有效期内，但 deliveredAt 已超出默认 30 天窗口 → 窗口拒绝。
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: {
        deliveredAt: new Date(Date.now() - 31 * DAY_MS),
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
      },
    })
    const denied = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(403)
    expect(denied.body.error.code).toBe('FILE_WINDOW_EXPIRED')

    // 两个界限都未到 → 正常签发。
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: { deliveredAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY_MS) },
    })
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(200)
  })
})
