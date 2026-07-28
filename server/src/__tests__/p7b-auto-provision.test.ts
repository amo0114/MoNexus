import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// callWebhook 是唯一被 mock 的出口——签名/分类/超时常量保持真实实现。
// provisionCron 与 webhookConfig 都按名引入 callWebhook,此处 mock 同时命中。
vi.mock('../lib/outboundWebhook.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/outboundWebhook.js')>()
  return { ...actual, callWebhook: vi.fn() }
})

import { prisma } from '../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  getDefaultOfferId,
  loginAs,
  makeManualService,
} from './helpers.js'
import * as outbound from '../lib/outboundWebhook.js'
import { computeOfferCheckoutVersion } from '../lib/offers.js'
import { runProvisionBatch } from '../modules/orders/provisionCron.js'
import * as webhookConfigService from '../modules/merchant/webhookConfig.js'
import { transitionOrderStatus } from '../modules/orders/fulfillment.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'

/**
 * P7b B-T6 状态机与安全边界(DB 支撑):认领/退避/降级/取消、启动事件、
 * maxAttempts=0 刹车、租约排除与 CAS、配置轮换降级、下单冻结 409、
 * secret 序列化边界、手工/自动交付竞争。callWebhook mock 保证确定性。
 */

const callWebhookMock = vi.mocked(outbound.callWebhook)
let mailer: CaptureMailer
let seq = 0

const flushImmediate = () => new Promise<void>(resolve => setImmediate(() => resolve()))

/** 直接写 SystemConfig 行(getSystemConfigValue 无缓存,即时生效)。 */
async function setMaxAttempts(value: number) {
  await prisma.systemConfig.upsert({
    where: { key: 'autoProvisionMaxAttempts' },
    update: { value },
    create: { key: 'autoProvisionMaxAttempts', value, description: 'test' },
  })
}

interface Seed {
  tag: string
  merchant: Awaited<ReturnType<typeof createTestMerchant>>['merchant']
  merchantPassword: string
  merchantEmail: string
  product: Awaited<ReturnType<typeof createTestProduct>>
  offerId: number
  configId: number | null
  buyerEmail: string
  buyer: Awaited<ReturnType<typeof loginAs>>
}

/** 建一条 manual_service + autoProvision + active webhook 配置的可下单场景。 */
async function seedAutoProvision(opts?: { withConfig?: boolean; autoProvision?: boolean }): Promise<Seed> {
  const tag = `ap${seq++}`
  const merchantEmail = `${tag}-m@test.local`
  const { merchant } = await createTestMerchant(merchantEmail, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `AP商家-${tag}`,
    contactEmail: merchantEmail,
  })
  const product = await createTestProduct(`AP服务-${tag}`, 300, 0, [], merchant.id)
  await makeManualService(product.id)
  const offerId = await getDefaultOfferId(product.id)

  let configId: number | null = null
  if (opts?.withConfig !== false) {
    await webhookConfigService.saveMyWebhookConfig(merchant.id, `https://hook-${tag}.example.test/provision`)
    const cfg = await prisma.merchantWebhookConfig.findFirstOrThrow({
      where: { merchantId: merchant.id, status: 'active' },
      select: { id: true },
    })
    configId = cfg.id
  }
  if (opts?.autoProvision !== false) {
    await prisma.offer.update({ where: { id: offerId }, data: { autoProvision: true } })
  }

  const buyerEmail = `${tag}-b@test.local`
  await createTestUser(buyerEmail, 'pass123', 'user', 5000)
  const buyer = await loginAs(buyerEmail, 'pass123')
  return { tag, merchant, merchantPassword: 'pass123', merchantEmail, product, offerId, configId, buyerEmail, buyer }
}

/** 下单(maxAttempts 已在 beforeEach 置 0,即时首呼是 no-op),返回 orderId。 */
async function purchase(seed: Seed): Promise<number> {
  const res = await api
    .post('/api/orders')
    .set(authHeader(seed.buyer.accessToken))
    .send({ productId: seed.product.id })
    .expect(201)
  await flushImmediate()
  return res.body.orderId as number
}

function taskByOrder(orderId: number) {
  return prisma.provisionTask.findUniqueOrThrow({ where: { orderId } })
}

beforeEach(async () => {
  callWebhookMock.mockReset()
  mailer = new CaptureMailer()
  __setMailerForTesting(mailer)
  // 建单期一律刹车,任务停在 pending;各用例再按需放开并显式跑批。
  await setMaxAttempts(0)
})

afterEach(() => {
  __setMailerForTesting(null)
})

describe('P7b 下单冻结与任务建立', () => {
  it('autoProvision 订单在下单事务内建 pending 任务并冻结当前 active 配置', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    const task = await taskByOrder(orderId)
    expect(task.status).toBe('pending')
    expect(task.attempts).toBe(0)
    expect(task.webhookConfigId).toBe(seed.configId)
    expect(task.leaseToken).toBeNull()
    expect(task.leaseUntil).toBeNull()
  })

  it('硬验收 ⑤:开了 autoProvision 但无 active 配置 → 整单 409,绝不静默转人工', async () => {
    const seed = await seedAutoProvision({ withConfig: false }) // offer.autoProvision=true, 无配置
    const res = await api
      .post('/api/orders')
      .set(authHeader(seed.buyer.accessToken))
      .send({ productId: seed.product.id })
      .expect(409)
    expect(res.body.error.code).toBe('AUTO_PROVISION_UNAVAILABLE')
    // 事务回滚:既无订单也无任务。
    expect(await prisma.order.count({ where: { productId: seed.product.id } })).toBe(0)
    expect(await prisma.provisionTask.count()).toBe(0)
  })

  it('硬验收 ④:autoProvision 开关进 checkoutVersion,买家预览随之失效', async () => {
    const seed = await seedAutoProvision({ autoProvision: false })
    const before = computeOfferCheckoutVersion(await prisma.offer.findUniqueOrThrow({ where: { id: seed.offerId } }))
    await prisma.offer.update({ where: { id: seed.offerId }, data: { autoProvision: true } })
    const after = computeOfferCheckoutVersion(await prisma.offer.findUniqueOrThrow({ where: { id: seed.offerId } }))
    expect(after).not.toBe(before)
  })
})

describe('P7b 认领/启动/退避/降级状态机', () => {
  it('硬验收 ⑧:maxAttempts=0 = 运维刹车,不认领/不外呼/不转状态', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    await setMaxAttempts(0)
    await runProvisionBatch()
    expect(callWebhookMock).not.toHaveBeenCalled()
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('pending')
    const task = await taskByOrder(orderId)
    expect(task.status).toBe('pending')
    expect(task.attempts).toBe(0)
    const startEvents = await prisma.orderStatusEvent.count({
      where: { orderId, action: 'system.auto_provision.start' },
    })
    expect(startEvents).toBe(0)
  })

  it('硬验收 ⑧:首个真实认领 system pending→processing 并发 start 事件,成功交付复用交付链路', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'ACCOUNT-XYZ-9' }) })
    await setMaxAttempts(5)
    await runProvisionBatch()

    expect(callWebhookMock).toHaveBeenCalledTimes(1)
    const task = await taskByOrder(orderId)
    expect(task.status).toBe('succeeded')
    expect(task.attempts).toBe(1)
    expect(task.leaseUntil).toBeNull()
    expect(task.lastHttpStatus).toBe(200)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('delivered')
    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    expect(delivery.content).toBe('ACCOUNT-XYZ-9')

    const events = await prisma.orderStatusEvent.findMany({ where: { orderId }, orderBy: { id: 'asc' } })
    const actions = events.map(e => e.action)
    expect(actions).toContain('system.auto_provision.start')
    expect(actions).toContain('system.auto_provision.deliver')

    // 外发载荷绝不含买家邮箱(身份信息不外发)。
    const rawBody = callWebhookMock.mock.calls[0][1]
    const payload = JSON.parse(rawBody)
    expect(payload.taskId).toBe(task.id)
    expect(payload.orderId).toBe(orderId)
    expect(payload.price).toBe(300)
    expect(rawBody).not.toContain(seed.buyerEmail)
  })

  it('失败后停在 pending、预写退避 nextAttemptAt、落脱敏诊断码,订单留在 processing', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    callWebhookMock.mockResolvedValue({ status: 500, body: 'upstream boom' })
    await setMaxAttempts(5)
    const t0 = Date.now()
    await runProvisionBatch()

    const task = await taskByOrder(orderId)
    expect(task.status).toBe('pending')
    expect(task.attempts).toBe(1)
    expect(task.lastError).toBe('http_500')
    expect(task.lastHttpStatus).toBe(500)
    expect(task.leaseUntil).toBeNull()
    // 第一档退避 60s:下次尝试时刻在未来。
    expect(task.nextAttemptAt.getTime()).toBeGreaterThan(t0 + 30_000)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('processing')
  })

  it('硬验收 ⑥:尝试次数耗尽即降级,并经 merchantNotifiedAt 通道发人工履约邮件', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    callWebhookMock.mockResolvedValue({ status: 502, body: '' })
    await setMaxAttempts(1) // 一次失败即耗尽
    await runProvisionBatch()

    const task = await taskByOrder(orderId)
    expect(task.status).toBe('degraded')
    expect(task.attempts).toBe(1)
    expect(task.lastError).toBe('http_502')
    expect(task.merchantNotifiedAt).not.toBeNull()

    const mail = mailer.lastTo(seed.merchantEmail)
    expect(mail).toBeDefined()
    expect(mail!.subject).toContain(`#${orderId}`)
    // 订单不因降级回退,仍为 processing 等人工交付。
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('processing')
  })
})

describe('P7b 租约与结果 CAS (硬验收 ⑨)', () => {
  it('未过期 leaseUntil 的任务不被二次认领;租约到期后可重新认领', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    const task = await taskByOrder(orderId)
    // 模拟 HTTP 在途:持有未过期租约。
    await prisma.provisionTask.update({
      where: { id: task.id },
      data: { leaseToken: 'in-flight', leaseUntil: new Date(Date.now() + 60_000) },
    })
    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'X' }) })
    await setMaxAttempts(5)
    await runProvisionBatch()
    expect(callWebhookMock).not.toHaveBeenCalled()
    expect((await taskByOrder(orderId)).status).toBe('pending')

    // 租约过期 → 重新认领并交付。
    await prisma.provisionTask.update({
      where: { id: task.id },
      data: { leaseUntil: new Date(Date.now() - 1_000) },
    })
    await runProvisionBatch()
    expect(callWebhookMock).toHaveBeenCalledTimes(1)
    expect((await taskByOrder(orderId)).status).toBe('succeeded')
  })
})

describe('P7b 配置轮换/撤销 (硬验收 ⑤)', () => {
  it('轮换配置即降级旧 pending 任务,任务绝不解析到新配置', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    // 轮换:撤销旧 active + 新建 active,旧引用任务同事务降级。
    await webhookConfigService.saveMyWebhookConfig(seed.merchant.id, `https://hook-${seed.tag}-v2.example.test/x`)

    const task = await taskByOrder(orderId)
    expect(task.status).toBe('degraded')
    expect(task.lastError).toBe('config_revoked')
    expect(task.leaseUntil).toBeNull()
    // 仍指向旧配置行——绝不切到新配置。
    expect(task.webhookConfigId).toBe(seed.configId)

    // 即便放开并跑批,降级任务不再被认领,不外呼。
    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'X' }) })
    await setMaxAttempts(5)
    await runProvisionBatch()
    expect(callWebhookMock).not.toHaveBeenCalled()
  })

  it('撤销配置原子关闭该商家全部 autoProvision 开关并降级 pending 任务', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    const result = await webhookConfigService.revokeMyWebhookConfig(seed.merchant.id)
    expect(result.revoked).toBe(true)
    expect(result.disabledOffers).toBe(1)

    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: seed.offerId } })
    expect(offer.autoProvision).toBe(false)
    const task = await taskByOrder(orderId)
    expect(task.status).toBe('degraded')
    expect(task.lastError).toBe('config_revoked')
  })
})

describe('P7b 手工/自动交付竞争', () => {
  it('商家抢先手工交付后,认领复查订单终态 → 任务取消,绝不重复交付', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    // 商家手工履约:pending→processing→delivered。
    await transitionOrderStatus({ orderId, toStatus: 'processing', actorRole: 'merchant', action: 'merchant.fulfillment.start' })
    await transitionOrderStatus({
      orderId,
      toStatus: 'delivered',
      actorRole: 'merchant',
      action: 'merchant.fulfillment.deliver',
      deliveryContent: 'MANUAL-CONTENT',
    })

    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'WEBHOOK-CONTENT' }) })
    await setMaxAttempts(5)
    await runProvisionBatch()

    expect(callWebhookMock).not.toHaveBeenCalled()
    const task = await taskByOrder(orderId)
    expect(task.status).toBe('cancelled')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('delivered')
    // 交付内容仍是商家手工的,自动开通内容被弃用。
    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    expect(delivery.content).toBe('MANUAL-CONTENT')
  })
})

describe('P7b secret 与任务序列化边界 (硬验收 ⑤)', () => {
  it('saveMyWebhookConfig 一次性回明文;getMyWebhookConfig 只回尾 4 位,绝不泄明文/密文', async () => {
    const { merchant } = await createTestMerchant('sec-boundary@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '密钥边界商家',
    })
    const saved = await webhookConfigService.saveMyWebhookConfig(merchant.id, 'https://hook.example.com/p')
    expect(saved.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.secretLast4).toBe(saved.secret.slice(-4))

    const got = await webhookConfigService.getMyWebhookConfig(merchant.id)
    expect(got).not.toBeNull()
    expect(got!.secretLast4).toBe(saved.secret.slice(-4))
    const serialized = JSON.stringify(got)
    expect(serialized).not.toContain(saved.secret) // 全明文绝不出现
    expect(serialized.toLowerCase()).not.toContain('ciphertext')
    expect(serialized).not.toContain('secretCiphertext')
    // 只暴露 url / secretLast4 / createdAt 三个键。
    expect(Object.keys(got!).sort()).toEqual(['createdAt', 'secretLast4', 'url'])
  })

  it('商家订单详情透出任务态徽标,但绝不含 leaseToken / webhookConfigId / 密文', async () => {
    const seed = await seedAutoProvision()
    const orderId = await purchase(seed)
    // 给任务塞一个 leaseToken,确认它不出现在响应里。
    await prisma.provisionTask.update({ where: { orderId }, data: { leaseToken: 'SECRET-LEASE-TOKEN' } })
    const cfg = await prisma.merchantWebhookConfig.findFirstOrThrow({ where: { id: seed.configId! } })

    const merchantLogin = await loginAs(seed.merchantEmail, seed.merchantPassword)
    const res = await api
      .get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)

    expect(res.body.provisionTask).toBeDefined()
    expect(res.body.provisionTask.status).toBe('pending')
    expect(res.body.provisionTask).not.toHaveProperty('leaseToken')
    expect(res.body.provisionTask).not.toHaveProperty('webhookConfigId')
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('SECRET-LEASE-TOKEN')
    expect(raw).not.toContain(cfg.secretCiphertext)
  })
})

describe('P7b webhook 配置 API 契约', () => {
  it('PUT 保存一次性回明文;GET 只回尾 4 位;test 走同一外呼路径;DELETE 撤销;非法 URL 400', async () => {
    const { merchant } = await createTestMerchant('api-contract@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: 'API 契约商家',
    })
    const login = await loginAs('api-contract@test.local', 'pass123')
    const auth = authHeader(login.accessToken)

    // PUT 保存。
    const put = await api.put('/api/merchant/webhook-config').set(auth).send({ url: 'https://hook.example.com/p' }).expect(200)
    expect(put.body.url).toBe('https://hook.example.com/p')
    expect(put.body.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(put.body.secretLast4).toBe(put.body.secret.slice(-4))

    // GET 只回尾 4 位,不含明文。
    const get = await api.get('/api/merchant/webhook-config').set(auth).expect(200)
    expect(get.body.secretLast4).toBe(put.body.secret.slice(-4))
    expect(JSON.stringify(get.body)).not.toContain(put.body.secret)

    // test 事件:mock 成功 → { ok:true, httpStatus:200 }。
    callWebhookMock.mockResolvedValue({ status: 200, body: 'ok' })
    const test = await api.post('/api/merchant/webhook-config/test').set(auth).send({}).expect(200)
    expect(test.body).toEqual({ ok: true, httpStatus: 200 })
    expect(callWebhookMock).toHaveBeenCalledTimes(1)

    // 非法 URL(http)→ 400。
    await api.put('/api/merchant/webhook-config').set(auth).send({ url: 'http://hook.example.com/p' }).expect(400)

    // DELETE 撤销。
    const del = await api.delete('/api/merchant/webhook-config').set(auth).expect(200)
    expect(del.body.revoked).toBe(true)
    // 撤销后 GET 为 null。
    const after = await api.get('/api/merchant/webhook-config').set(auth).expect(200)
    expect(after.body).toBeNull()
  })
})
