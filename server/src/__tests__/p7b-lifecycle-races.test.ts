import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 与 p7b-auto-provision.test.ts 同款:只 mock callWebhook,其余保持真实实现。
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
import { runProvisionBatch, __setPreDispatchHookForTests } from '../modules/orders/provisionCron.js'
import * as webhookConfigService from '../modules/merchant/webhookConfig.js'
import { __setActiveConfigLockHooksForTests } from '../modules/merchant/webhookConfig.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'

/**
 * P7b 复审 P1 回归:配置生命周期的**受控并发**验证。
 *
 * 线性化模型(webhookConfig.ts 文件头):active 配置行的行锁是唯一线性化
 * 点——下单冻结/开关启用/dispatch gate 拿 FOR SHARE,轮换/撤销拿 FOR
 * UPDATE。测试用注入缝把"另一侧"精确插到临界区前后,构造两种时序:
 * - 撤销先胜:下单必须 409 / 开关启用必须被拒 / callWebhook 必须零调用;
 * - 读侧先胜:撤销在行锁上排队,恢复后其扫描必然覆盖读侧刚提交的产物。
 */

const callWebhookMock = vi.mocked(outbound.callWebhook)
let mailer: CaptureMailer
let seq = 0

const flushImmediate = () => new Promise<void>(resolve => setImmediate(() => resolve()))

/** barrier:轮询 pg_stat_activity 直到至少 min 个会话在锁上排队(惯例样板 p6-review-fixes)。 */
async function waitForLockWaiters(min: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const rows = await prisma.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`
    if (rows.length >= min) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`barrier: 没有观察到 ${min} 个在锁上排队的会话`)
}

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
  merchantEmail: string
  product: Awaited<ReturnType<typeof createTestProduct>>
  offerId: number
  buyer: Awaited<ReturnType<typeof loginAs>>
}

async function seedAutoProvision(opts?: { autoProvision?: boolean }): Promise<Seed> {
  const tag = `race${seq++}`
  const merchantEmail = `${tag}-m@test.local`
  const { merchant } = await createTestMerchant(merchantEmail, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `竞态商家-${tag}`,
    contactEmail: merchantEmail,
  })
  const product = await createTestProduct(`竞态服务-${tag}`, 300, 0, [], merchant.id)
  await makeManualService(product.id)
  const offerId = await getDefaultOfferId(product.id)
  await webhookConfigService.saveMyWebhookConfig(merchant.id, `https://hook-${tag}.example.test/provision`)
  if (opts?.autoProvision !== false) {
    await prisma.offer.update({ where: { id: offerId }, data: { autoProvision: true } })
  }
  const buyerEmail = `${tag}-b@test.local`
  await createTestUser(buyerEmail, 'pass123', 'user', 5000)
  const buyer = await loginAs(buyerEmail, 'pass123')
  return { tag, merchant, merchantEmail, product, offerId, buyer }
}

beforeEach(async () => {
  callWebhookMock.mockReset()
  mailer = new CaptureMailer()
  __setMailerForTesting(mailer)
  outbound.__setWebhookDnsResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }])
  await setMaxAttempts(0)
})

afterEach(() => {
  __setMailerForTesting(null)
  __setActiveConfigLockHooksForTests(null)
  __setPreDispatchHookForTests(null)
  outbound.__setWebhookDnsResolverForTests(null)
})

describe('P1 复审回归:下单冻结 × 撤销 的线性化', () => {
  it('撤销先胜:冻结锁必见 revoked → 整单 409,绝不提交引用已撤销配置的任务', async () => {
    const seed = await seedAutoProvision()
    // 时序注入:下单事务已读到 offer.autoProvision=true、行至冻结锁**之前**,
    // 一次完整撤销先提交——这正是复审指出的竞态窗口。
    let fired = false
    __setActiveConfigLockHooksForTests({
      beforeLock: async () => {
        if (fired) return
        fired = true
        await webhookConfigService.revokeMyWebhookConfig(seed.merchant.id)
      },
    })

    const res = await api
      .post('/api/orders')
      .set(authHeader(seed.buyer.accessToken))
      .send({ productId: seed.product.id })
      .expect(409)
    expect(res.body.error.code).toBe('AUTO_PROVISION_UNAVAILABLE')
    expect(fired).toBe(true)
    // 整单回滚:无订单、无任务——绝不静默转人工。
    expect(await prisma.order.count({ where: { productId: seed.product.id } })).toBe(0)
    expect(await prisma.provisionTask.count()).toBe(0)
  })

  it('下单先胜:撤销在配置行锁上排队,恢复后降级扫描覆盖刚提交的新任务', async () => {
    const seed = await seedAutoProvision()
    // 时序注入:下单事务持有 FOR SHARE 时发起撤销,barrier 确认撤销已在
    // FOR UPDATE 上排队,再放行下单提交。
    let revokePromise: Promise<{ revoked: boolean; disabledOffers: number }> | null = null
    __setActiveConfigLockHooksForTests({
      afterLock: async locked => {
        if (revokePromise) return
        expect(locked).not.toBeNull()
        revokePromise = webhookConfigService.revokeMyWebhookConfig(seed.merchant.id)
        await waitForLockWaiters(1)
      },
    })

    const res = await api
      .post('/api/orders')
      .set(authHeader(seed.buyer.accessToken))
      .send({ productId: seed.product.id })
      .expect(201)
    await flushImmediate()
    const revoked = await revokePromise!
    expect(revoked.disabledOffers).toBe(1)

    // 新任务被撤销的降级扫描覆盖:degraded + config_revoked,开关已关。
    const task = await prisma.provisionTask.findUniqueOrThrow({ where: { orderId: res.body.orderId } })
    expect(task.status).toBe('degraded')
    expect(task.lastError).toBe('config_revoked')
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: seed.offerId } })
    expect(offer.autoProvision).toBe(false)
  })
})

describe('P1 复审回归:规格开关启用 × 撤销 的线性化', () => {
  it('启用先胜:撤销排队恢复后关掉刚启用的开关——不存在开着开关的无配置规格', async () => {
    const seed = await seedAutoProvision({ autoProvision: false })
    const merchantLogin = await loginAs(seed.merchantEmail, 'pass123')

    let revokePromise: Promise<{ revoked: boolean; disabledOffers: number }> | null = null
    __setActiveConfigLockHooksForTests({
      afterLock: async locked => {
        if (revokePromise) return
        expect(locked).not.toBeNull()
        revokePromise = webhookConfigService.revokeMyWebhookConfig(seed.merchant.id)
        await waitForLockWaiters(1)
      },
    })

    await api
      .put(`/api/merchant/products/${seed.product.id}/offers/${seed.offerId}`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ autoProvision: true })
      .expect(200)
    const revoked = await revokePromise!
    // 撤销的关开关扫描覆盖刚启用的规格。
    expect(revoked.disabledOffers).toBe(1)
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: seed.offerId } })
    expect(offer.autoProvision).toBe(false)
  })

  it('撤销先胜:启用校验必见无 active 配置 → 422 拒绝开启', async () => {
    const seed = await seedAutoProvision({ autoProvision: false })
    const merchantLogin = await loginAs(seed.merchantEmail, 'pass123')

    let fired = false
    __setActiveConfigLockHooksForTests({
      beforeLock: async () => {
        if (fired) return
        fired = true
        await webhookConfigService.revokeMyWebhookConfig(seed.merchant.id)
      },
    })

    const res = await api
      .put(`/api/merchant/products/${seed.product.id}/offers/${seed.offerId}`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ autoProvision: true })
      .expect(400)
    expect(res.body.error.message).toContain('webhook')
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: seed.offerId } })
    expect(offer.autoProvision).toBe(false)
  })
})

describe('P1 复审回归:dispatch 前生命周期 gate(不可逆外呼的线性化点)', () => {
  it('撤销先于 gate:任务降级,callWebhook **从未被调用**——表单答案不外发', async () => {
    const seed = await seedAutoProvision()
    await api
      .post('/api/orders')
      .set(authHeader(seed.buyer.accessToken))
      .send({ productId: seed.product.id })
      .expect(201)
    await flushImmediate()
    const before = await prisma.provisionTask.findFirstOrThrow({ where: { order: { productId: seed.product.id } } })
    expect(before.status).toBe('pending')

    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'X' }) })
    await setMaxAttempts(5)
    // 时序注入:认领已完成(URL/secret/买家答案已在内存),外呼前一刻撤销
    // 提交——复审指出的「结果 CAS 挡得住交付、挡不住外发」窗口。
    __setPreDispatchHookForTests(async () => {
      __setPreDispatchHookForTests(null)
      await webhookConfigService.revokeMyWebhookConfig(seed.merchant.id)
    })
    await runProvisionBatch()

    // 核心断言:callWebhook 从未被调用。
    expect(callWebhookMock).not.toHaveBeenCalled()
    const task = await prisma.provisionTask.findUniqueOrThrow({ where: { id: before.id } })
    expect(task.status).toBe('degraded')
    expect(task.lastError).toBe('config_revoked')
    // 认领先于撤销:订单已由 system 转 processing,降级后停在 processing 等人工。
    const order = await prisma.order.findUniqueOrThrow({ where: { id: task.orderId } })
    expect(order.status).toBe('processing')
  })

  it('轮换先于 gate 同样拦截:旧任务绝不向(新旧任一)配置外呼', async () => {
    const seed = await seedAutoProvision()
    await api
      .post('/api/orders')
      .set(authHeader(seed.buyer.accessToken))
      .send({ productId: seed.product.id })
      .expect(201)
    await flushImmediate()

    callWebhookMock.mockResolvedValue({ status: 200, body: JSON.stringify({ content: 'X' }) })
    await setMaxAttempts(5)
    __setPreDispatchHookForTests(async () => {
      __setPreDispatchHookForTests(null)
      await webhookConfigService.saveMyWebhookConfig(seed.merchant.id, `https://hook-${seed.tag}-v2.example.test/x`)
    })
    await runProvisionBatch()

    expect(callWebhookMock).not.toHaveBeenCalled()
    const task = await prisma.provisionTask.findFirstOrThrow({ where: { order: { productId: seed.product.id } } })
    expect(task.status).toBe('degraded')
    expect(task.lastError).toBe('config_revoked')
  })
})

describe('P2 复审回归:保存时 DNS 校验接线 + 管理端列表投影', () => {
  it('PUT /api/merchant/webhook-config 对 https://localhost 保存即 400(不再等到首呼)', async () => {
    await createTestMerchant('dns-save@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: 'DNS 保存校验商家',
    })
    const login = await loginAs('dns-save@test.local', 'pass123')
    // 用真实解析器:localhost 由 /etc/hosts 稳定解析到环回。
    outbound.__setWebhookDnsResolverForTests(null)
    const res = await api
      .put('/api/merchant/webhook-config')
      .set(authHeader(login.accessToken))
      .send({ url: 'https://localhost/hook' })
      .expect(400)
    expect(res.body.error.message).toContain('内网')
  })

  it('GET /api/admin/orders 列表行透出 provisionTask 安全投影(无 leaseToken/webhookConfigId)', async () => {
    const seed = await seedAutoProvision()
    const res = await api
      .post('/api/orders')
      .set(authHeader(seed.buyer.accessToken))
      .send({ productId: seed.product.id })
      .expect(201)
    await flushImmediate()
    await prisma.provisionTask.update({
      where: { orderId: res.body.orderId },
      data: { leaseToken: 'SECRET-LEASE' },
    })

    await createTestUser('race-admin@test.local', 'admin222', 'admin')
    const admin = await loginAs('race-admin@test.local', 'admin222')
    const list = await api.get('/api/admin/orders').set(authHeader(admin.accessToken)).expect(200)
    const row = list.body.items.find((o: { id: number }) => o.id === res.body.orderId)
    expect(row).toBeDefined()
    expect(row.provisionTask).toBeDefined()
    expect(row.provisionTask.status).toBe('pending')
    expect(row.provisionTask).not.toHaveProperty('leaseToken')
    expect(row.provisionTask).not.toHaveProperty('webhookConfigId')
    expect(JSON.stringify(list.body)).not.toContain('SECRET-LEASE')
  })
})
