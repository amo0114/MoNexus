import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  configureDefaultOffer,
  getDefaultOfferId,
  makeManualService,
  loginAs,
  authHeader,
} from './helpers.js'
import { __setDeliveryStorageForTesting } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../lib/storage/deliveryMemory.js'

/**
 * P6a T2：到期强制。核心不变量：
 * 1. 遮蔽只发生在买家视角（内容已泄露，遮蔽是提示性承诺）；商家/管理员
 *    永远看履约凭据；
 * 2. 文件发放：订阅交付（expiresAt 非空）只受自身有效期约束（复审 P2-3，
 *    平台默认窗口不得截断商家售出的长订阅），买家 403
 *    FILE_SUBSCRIPTION_EXPIRED，商家不受限；非订阅交付才受
 *    fileAccessWindowDays 窗口；
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

    // 复审 P2-4：订阅到期的拒绝独立审计为 denied_subscription——仲裁"付费期
    // 内无法下载"投诉时必须与窗口规则的拒绝可区分（CHECK 词表已扩迁移）。
    const log = await prisma.fileGrantLog.findFirstOrThrow({ where: { orderId, role: 'buyer' } })
    expect(log.outcome).toBe('denied_subscription')

    // 商家不受订阅到期限制（履约凭据）。
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(seller.accessToken)).expect(200)

    // 文件元数据在买家详情仍可见（遮蔽只针对 content/structuredContent）。
    const detail = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.delivery.contentMasked).toBe(true)
    expect(detail.body.delivery.file).toMatchObject({ fileName: '订阅包.zip' })
    expect(detail.body.delivery.file.size).toBeGreaterThan(0)
  })

  it('subscription delivery skips the generic window: old deliveredAt still issues while expiresAt is in the future', async () => {
    const { buyer, orderId } = await buyFileSubscription('window')

    // 复审 P2-3：expiresAt 非空即订阅自治——deliveredAt 已超出平台默认
    // 30 天窗口也照常签发，默认窗口不得截断商家售出的更长订阅承诺。
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: {
        deliveredAt: new Date(Date.now() - 31 * DAY_MS),
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
      },
    })
    await api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken)).expect(200)

    // 订阅到期后拒新签发，审计 outcome 细分为 denied_subscription。
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const denied = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(403)
    expect(denied.body.error.code).toBe('FILE_SUBSCRIPTION_EXPIRED')
    const deniedLog = await prisma.fileGrantLog.findFirstOrThrow({
      where: { orderId, outcome: 'denied_subscription' },
    })
    expect(deniedLog.role).toBe('buyer')

    // 非订阅交付（expiresAt 为空）才落回平台窗口规则 → denied 语义保留。
    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: null } })
    const windowDenied = await api
      .post(`/api/orders/${orderId}/files/download-url`)
      .set(authHeader(buyer.accessToken))
      .expect(403)
    expect(windowDenied.body.error.code).toBe('FILE_WINDOW_EXPIRED')
  })
})

describe('expired masking covers delivery publicNote and delivered-transition timeline notes', () => {
  it('masks delivery.publicNote and the delivered event note for the buyer; progress note and merchant view stay intact', async () => {
    // 人工服务单走完整履约链：接单 → 进度更新 → 携附言交付。
    const { merchant } = await createTestMerchant('sub-note-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const seller = await loginAs('sub-note-m@test.local', 'pass123')
    await createTestUser('sub-note-b@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('人工订阅服务', 200, 0, [], merchant.id)
    await makeManualService(product.id)

    const buyer = await loginAs('sub-note-b@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId as number

    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(seller.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(seller.accessToken))
      .send({ note: '进度说明-已完成一半' })
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken))
      .send({ deliveryContent: '交付内容-账号密码', publicNote: '交付附言-账号使用说明' })
      .expect(200)

    // 未过期基线：交付附言与交付事件附言均可见。
    const fresh = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(fresh.body.delivery.publicNote).toBe('交付附言-账号使用说明')
    const freshDelivered = fresh.body.timeline.find((e: { toStatus: string }) => e.toStatus === 'delivered')
    expect(freshDelivered.publicNote).toBe('交付附言-账号使用说明')

    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: new Date(Date.now() - 1000) } })

    // 复审 P2-1：交付附言常放账号/说明，与 content 同级遮蔽；交付事件的
    // publicNote 与交付附言同源同值，只遮一处等于没遮——一并置空。
    const expired = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(expired.body.delivery.contentMasked).toBe(true)
    expect(expired.body.delivery.content).toBeNull()
    expect(expired.body.delivery.publicNote).toBeNull()
    const deliveredEvent = expired.body.timeline.find((e: { toStatus: string }) => e.toStatus === 'delivered')
    expect(deliveredEvent.publicNote).toBeNull()
    // 进度类事件（from=to='processing'）的附言不是交付凭据，保留可见。
    const progressEvent = expired.body.timeline.find((e: { action: string }) => e.action === 'merchant.progress')
    expect(progressEvent.publicNote).toBe('进度说明-已完成一半')
    // 交付内容与交付附言绝不出现在响应任何角落；买家契约只有 timeline，
    // 原始 statusEvents 已整体剥离（复审补丁——此前附言经由它绕过遮蔽）。
    expect(expired.body.statusEvents).toBeUndefined()
    expect(JSON.stringify(expired.body)).not.toContain('交付内容-账号密码')
    expect(JSON.stringify(expired.body)).not.toContain('交付附言-账号使用说明')

    // 商家视角是履约凭据，永不遮蔽：交付附言与事件附言原样可见。
    const merchantView = await api
      .get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(seller.accessToken))
      .expect(200)
    expect(merchantView.body.delivery.publicNote).toBe('交付附言-账号使用说明')
    const merchantDelivered = merchantView.body.statusEvents.find(
      (e: { toStatus: string }) => e.toStatus === 'delivered'
    )
    expect(merchantDelivered.publicNote).toBe('交付附言-账号使用说明')
  })
})

describe('idempotent replay under subscription expiry', () => {
  /** 造一个带 Idempotency-Key 的即时订阅订单（validityDays 30）。 */
  async function buyWithKey(tag: string) {
    await createTestUser(`sub-idem-${tag}-b@test.local`, 'pass123', 'user', 1000)
    const product = await createTestProduct(`幂等订阅${tag}`, 100, 3, [`${tag}-secret-1`, `${tag}-secret-2`, `${tag}-secret-3`])
    await prisma.offer.update({
      where: { id: await getDefaultOfferId(product.id) },
      data: { validityDays: 30 },
    })
    const buyer = await loginAs(`sub-idem-${tag}-b@test.local`, 'pass123')
    const key = randomUUID()
    const send = () =>
      api
        .post('/api/orders')
        .set(authHeader(buyer.accessToken))
        .set('Idempotency-Key', key)
        .send({ productId: product.id, expectedPrice: 100 })
    const first = await send().expect(201)
    return { buyer, key, send, orderId: first.body.orderId as number, first }
  }

  it('replay after expiry omits deliveryContent and deliveryStructuredContent', async () => {
    const { send, orderId, first } = await buyWithKey('replay')
    expect(first.body.deliveryContent).toBe('replay-secret-1')

    // 补一份结构化交付：重放遮蔽必须同时覆盖两种形态。
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: {
        structuredContent: {
          fields: [{ key: 'account', label: '账号', sensitive: true }],
          values: { account: 'replay-acct-secret' },
        },
      },
    })

    // 未过期基线：重放照常回传交付内容。
    const freshReplay = await send().expect(201)
    expect(freshReplay.body.idempotentReplay).toBe(true)
    expect(freshReplay.body.deliveryContent).toBe('replay-secret-1')
    expect(freshReplay.body.deliveryStructuredContent).toBeTruthy()

    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: new Date(Date.now() - 1000) } })

    // 复审 P2-2：重放是唯一绕过遮蔽序列化器的买家可达投影——到期后
    // 重放同样不回明文（重放窗口内的短订阅可能已过期）。
    const expiredReplay = await send().expect(201)
    expect(expiredReplay.body.idempotentReplay).toBe(true)
    expect(expiredReplay.body.orderId).toBe(orderId)
    expect(expiredReplay.body.deliveryContent).toBeUndefined()
    expect(expiredReplay.body.deliveryStructuredContent).toBeUndefined()
    expect(JSON.stringify(expiredReplay.body)).not.toContain('replay-secret-1')
    expect(JSON.stringify(expiredReplay.body)).not.toContain('replay-acct-secret')
  })

  it('an expired completed idempotency record yields 409 IDEMPOTENCY_KEY_EXPIRED and never re-executes', async () => {
    const { key, send } = await buyWithKey('expkey')
    expect(await prisma.order.count()).toBe(1)

    // 复审 P2-2：重放窗口以记录 expiresAt 为准。过期的 completed 记录
    // 绝不落入"接管租约重新执行"分支——那会对同一 key 重复下单。
    await prisma.idempotencyRecord.updateMany({
      where: { key },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const res = await send().expect(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_EXPIRED')

    // 既不重放也不重下单：订单数不变，余额只扣了一次。
    expect(await prisma.order.count()).toBe(1)
    const account = await prisma.pointAccount.findFirstOrThrow()
    expect(account.balance).toBe(900)
  })
})
