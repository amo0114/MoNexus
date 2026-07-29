import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// callWebhook mock 同惯例;transitionOrderStatus 用可注入的透传包装——
// 按需注入一次"瞬时 DB 故障",其余调用走真实实现。
vi.mock('../lib/outboundWebhook.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/outboundWebhook.js')>()
  return { ...actual, callWebhook: vi.fn() }
})
vi.mock('../modules/orders/fulfillment.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../modules/orders/fulfillment.js')>()
  return { ...actual, transitionOrderStatus: vi.fn(actual.transitionOrderStatus) }
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
import * as fulfillment from '../modules/orders/fulfillment.js'
import { runProvisionBatch } from '../modules/orders/provisionCron.js'
import * as webhookConfigService from '../modules/merchant/webhookConfig.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'

/**
 * P7b 复审 R2-P1 回归:2xx 外呼后的**结果落库异常分类**。
 * 契约:只有业务性竞争(transitionOrderStatus 抛 HttpError——状态 CAS
 * 竞争/非法流转)才允许 cancelled;瞬时基础设施故障必须保留 pending 并
 * 至少重试一次(接收端以 taskId 幂等去重)。
 */

const actualFulfillment = await vi.importActual<typeof import('../modules/orders/fulfillment.js')>(
  '../modules/orders/fulfillment.js'
)
const callWebhookMock = vi.mocked(outbound.callWebhook)
const transitionMock = vi.mocked(fulfillment.transitionOrderStatus)
let seq = 0

const flushImmediate = () => new Promise<void>(resolve => setImmediate(() => resolve()))

async function setMaxAttempts(value: number) {
  await prisma.systemConfig.upsert({
    where: { key: 'autoProvisionMaxAttempts' },
    update: { value },
    create: { key: 'autoProvisionMaxAttempts', value, description: 'test' },
  })
}

async function seedAndPurchase() {
  const tag = `rs${seq++}`
  const merchantEmail = `${tag}-m@test.local`
  const { merchant } = await createTestMerchant(merchantEmail, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `结果落库商家-${tag}`,
    contactEmail: merchantEmail,
  })
  const product = await createTestProduct(`结果落库服务-${tag}`, 300, 0, [], merchant.id)
  await makeManualService(product.id)
  const offerId = await getDefaultOfferId(product.id)
  await webhookConfigService.saveMyWebhookConfig(merchant.id, `https://hook-${tag}.example.test/provision`)
  await prisma.offer.update({ where: { id: offerId }, data: { autoProvision: true } })
  const buyerEmail = `${tag}-b@test.local`
  await createTestUser(buyerEmail, 'pass123', 'user', 5000)
  const buyer = await loginAs(buyerEmail, 'pass123')
  const res = await api
    .post('/api/orders')
    .set(authHeader(buyer.accessToken))
    .send({ productId: product.id })
    .expect(201)
  await flushImmediate()
  return { orderId: res.body.orderId as number, merchantEmail }
}

beforeEach(async () => {
  callWebhookMock.mockReset()
  transitionMock.mockImplementation(actualFulfillment.transitionOrderStatus)
  __setMailerForTesting(new CaptureMailer())
  outbound.__setWebhookDnsResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }])
  await setMaxAttempts(0)
})

afterEach(() => {
  transitionMock.mockImplementation(actualFulfillment.transitionOrderStatus)
  __setMailerForTesting(null)
  outbound.__setWebhookDnsResolverForTests(null)
})

describe('R2-P1 结果落库异常分类', () => {
  it('瞬时 DB 故障:保留 pending(绝不 cancelled),下轮重呼后交付成功(至少一次)', async () => {
    const { orderId } = await seedAndPurchase()
    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'ACCOUNT-1' }) })
    await setMaxAttempts(5)

    // 注入:首次 delivered 转移抛"连接中断"(非 HttpError = 瞬时故障);
    // 认领事务里的 pending→processing 转移不受影响。
    let injected = false
    transitionMock.mockImplementation(async (input, client) => {
      if (input.toStatus === 'delivered' && !injected) {
        injected = true
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'P1001' })
      }
      return actualFulfillment.transitionOrderStatus(input, client)
    })

    await runProvisionBatch()
    expect(injected).toBe(true)
    expect(callWebhookMock).toHaveBeenCalledTimes(1)

    // 复审场景断言:任务必须还在 pending(而非 cancelled),租约已释放,
    // 诊断码 result_write_failed;订单停在 processing 等待重试。
    const task = await prisma.provisionTask.findUniqueOrThrow({ where: { orderId } })
    expect(task.status).toBe('pending')
    expect(task.lastError).toBe('result_write_failed')
    expect(task.lastHttpStatus).toBe(200)
    expect(task.leaseUntil).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('processing')

    // 让退避到点 → 重呼(接收端按 taskId 幂等)→ 这次落库成功。
    await prisma.provisionTask.update({ where: { orderId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    await runProvisionBatch()
    expect(callWebhookMock).toHaveBeenCalledTimes(2)
    const settled = await prisma.provisionTask.findUniqueOrThrow({ where: { orderId } })
    expect(settled.status).toBe('succeeded')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('delivered')
    expect((await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })).content).toBe('ACCOUNT-1')
  })

  it('瞬时故障反复发生:attempts 递增,耗尽后走正常降级 + 商家邮件(不静默卡死)', async () => {
    const { orderId, merchantEmail } = await seedAndPurchase()
    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'X' }) })
    const mailer = new CaptureMailer()
    __setMailerForTesting(mailer)
    await setMaxAttempts(1) // 一次机会:落库失败后耗尽

    transitionMock.mockImplementation(async (input, client) => {
      if (input.toStatus === 'delivered') {
        throw Object.assign(new Error('deadlock detected'), { code: 'P2034' })
      }
      return actualFulfillment.transitionOrderStatus(input, client)
    })

    await runProvisionBatch()
    // 第一轮:外呼成功但落库失败 → pending;attempts=1 已达上限。
    expect((await prisma.provisionTask.findUniqueOrThrow({ where: { orderId } })).status).toBe('pending')

    // 下一轮认领:attempts >= maxAttempts → 降级 + 邮件(而非永远 pending)。
    await prisma.provisionTask.update({ where: { orderId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    await runProvisionBatch()
    const task = await prisma.provisionTask.findUniqueOrThrow({ where: { orderId } })
    expect(task.status).toBe('degraded')
    expect(task.merchantNotifiedAt).not.toBeNull()
    expect(mailer.lastTo(merchantEmail)).toBeDefined()
  })

  it('业务性竞争(HttpError)仍取消:商家手工交付先落定 → cancelled,内容弃用', async () => {
    const { orderId } = await seedAndPurchase()
    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'WEBHOOK-CONTENT' }) })
    await setMaxAttempts(5)

    // 注入:delivered 转移前,商家手工交付真实落定(产生真实 HttpError CAS 竞争)。
    let injected = false
    transitionMock.mockImplementation(async (input, client) => {
      if (input.toStatus === 'delivered' && input.actorRole === 'system' && !injected) {
        injected = true
        await actualFulfillment.transitionOrderStatus({
          orderId,
          toStatus: 'delivered',
          actorRole: 'merchant',
          action: 'merchant.fulfillment.deliver',
          deliveryContent: 'MANUAL-CONTENT',
        })
      }
      return actualFulfillment.transitionOrderStatus(input, client)
    })

    await runProvisionBatch()
    const task = await prisma.provisionTask.findUniqueOrThrow({ where: { orderId } })
    expect(task.status).toBe('cancelled')
    expect((await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })).content).toBe('MANUAL-CONTENT')
  })
})
