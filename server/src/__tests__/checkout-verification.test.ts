import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { api, createTestUser, createTestProduct, configureDefaultOffer, loginAs, authHeader } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { resetVerificationAttempts } from '../modules/checkout/verification.js'

const VERIFY_KEYS = ['checkoutVerifyAmountThreshold', 'checkoutVerifyDailyThreshold'] as const

async function setThresholds(amount: number, daily: number) {
  for (const [key, value] of [
    ['checkoutVerifyAmountThreshold', amount],
    ['checkoutVerifyDailyThreshold', daily],
  ] as const) {
    await prisma.systemConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    })
  }
}

describe('checkout verification (P3 high-risk 2FA)', () => {
  beforeEach(() => {
    resetVerificationAttempts()
  })

  afterEach(async () => {
    // SystemConfig 不在全局 TRUNCATE 列表内，阈值必须自清理，避免泄漏进其他测试。
    await prisma.systemConfig.deleteMany({ where: { key: { in: [...VERIFY_KEYS] } } })
  })

  it('preview flags requiresVerification only when a threshold is hit', async () => {
    await createTestUser('verify-preview@test.local', 'pass123', 'user', 5000)
    await createTestProduct('低价商品', 100, 1, ['vp-1'])
    await createTestProduct('高价商品', 500, 1, ['vp-2'])
    const { accessToken } = await loginAs('verify-preview@test.local', 'pass123')

    // 双阈值为 0（默认）：永不触发
    const off = await api
      .get('/api/checkout/preview')
      .query({ productId: 2 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(off.body.requiresVerification).toBe(false)

    await setThresholds(300, 0)
    const low = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(low.body.requiresVerification).toBe(false)
    const high = await api
      .get('/api/checkout/preview')
      .query({ productId: 2 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(high.body.requiresVerification).toBe(true)
  })

  it('rejects a triggered order without password, releases the idempotency claim, and succeeds with the right password on the same key', async () => {
    await setThresholds(300, 0)
    await createTestUser('verify-order@test.local', 'pass123', 'user', 5000)
    await createTestProduct('触发商品', 500, 2, ['vo-1', 'vo-2'])
    const { accessToken } = await loginAs('verify-order@test.local', 'pass123')
    const key = randomUUID()

    // 缺密码 → 401 VERIFICATION_REQUIRED，无副作用
    const missing = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1 })
      .expect(401)
    expect(missing.body.error.code).toBe('VERIFICATION_REQUIRED')

    // 错密码 → 401 VERIFICATION_FAILED，无副作用
    const wrong = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1, verificationPassword: 'wrong-pass' })
      .expect(401)
    expect(wrong.body.error.code).toBe('VERIFICATION_FAILED')

    expect(await prisma.order.count()).toBe(0)
    const account = await prisma.pointAccount.findFirstOrThrow()
    expect(account.balance).toBe(5000)
    expect(await prisma.idempotencyRecord.count()).toBe(0)

    // 同 key 换成正确密码 → 成交（凭证不进幂等指纹）
    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1, verificationPassword: 'pass123' })
      .expect(201)
    expect(await prisma.order.count()).toBe(1)
  })

  it('below-threshold orders need no password', async () => {
    await setThresholds(300, 0)
    await createTestUser('verify-low@test.local', 'pass123', 'user', 5000)
    await createTestProduct('免验证商品', 100, 1, ['vl-1'])
    const { accessToken } = await loginAs('verify-low@test.local', 'pass123')

    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1 })
      .expect(201)
  })

  it('daily cumulative threshold counts prior orders but not refunded ones', async () => {
    await setThresholds(0, 500)
    await createTestUser('verify-daily@test.local', 'pass123', 'user', 5000)
    await createTestProduct('累计商品', 200, 5, ['vd-1', 'vd-2', 'vd-3', 'vd-4', 'vd-5'])
    const { accessToken } = await loginAs('verify-daily@test.local', 'pass123')

    // 第一单 200：累计 0+200 < 500，无需密码
    await api.post('/api/orders').set(authHeader(accessToken)).send({ productId: 1 }).expect(201)
    // 第二单 200：累计 200+200 < 500，仍无需密码
    await api.post('/api/orders').set(authHeader(accessToken)).send({ productId: 1 }).expect(201)
    // 第三单 200：累计 400+200 ≥ 500 → 触发
    const third = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1 })
      .expect(401)
    expect(third.body.error.code).toBe('VERIFICATION_REQUIRED')

    // 已成交订单退款后不再计入当日累计
    await prisma.order.updateMany({ data: { status: 'refunded' } })
    await api.post('/api/orders').set(authHeader(accessToken)).send({ productId: 1 }).expect(201)
  })

  it('locks out after repeated wrong passwords and never leaks attempt progress', async () => {
    await setThresholds(300, 0)
    await createTestUser('verify-lock@test.local', 'pass123', 'user', 5000)
    await createTestProduct('锁定商品', 500, 1, ['vk-1'])
    const { accessToken } = await loginAs('verify-lock@test.local', 'pass123')

    for (let i = 0; i < 5; i += 1) {
      const res = await api
        .post('/api/orders')
        .set(authHeader(accessToken))
        .send({ productId: 1, verificationPassword: `wrong-${i}` })
        .expect(401)
      // 每次失败的报错都一致，不携带剩余次数（避免为爆破提供进度反馈）
      expect(res.body.error.code).toBe('VERIFICATION_FAILED')
    }

    // 第 6 次：即使密码正确也被限流拒绝
    const locked = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, verificationPassword: 'pass123' })
      .expect(429)
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(await prisma.order.count()).toBe(0)
  })

  it('price/form changes take priority over verification: 409 before 401', async () => {
    await createTestUser('verify-prio@test.local', 'pass123', 'user', 5000)
    await createTestProduct('预检商品', 100, 2, ['pp-1', 'pp-2'])
    const { accessToken } = await loginAs('verify-prio@test.local', 'pass123')

    // 买家预览时 100 积分未达阈值（无密码框）；随后商家改价 600 跨过阈值。
    await setThresholds(300, 0)
    await configureDefaultOffer(1, { price: 600 })

    // 必须先 409 PRICE_CHANGED 让前端重新报价（新 preview 带密码框），
    // 而不是 401 VERIFICATION_REQUIRED 把用户卡在没有密码框的旧弹窗里。
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ productId: 1, expectedPrice: 100 })
      .expect(409)
    expect(res.body.error.code).toBe('PRICE_CHANGED')
    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.idempotencyRecord.count()).toBe(0)

    // 重新报价后（新价 + 密码）正常成交
    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 600, verificationPassword: 'pass123' })
      .expect(201)
  })

  it('a successful verification clears the failure counter', async () => {
    await setThresholds(300, 0)
    await createTestUser('verify-clear@test.local', 'pass123', 'user', 5000)
    await createTestProduct('清零商品', 500, 3, ['vc-1', 'vc-2', 'vc-3'])
    const { accessToken } = await loginAs('verify-clear@test.local', 'pass123')

    for (let i = 0; i < 4; i += 1) {
      await api
        .post('/api/orders')
        .set(authHeader(accessToken))
        .send({ productId: 1, verificationPassword: 'nope' })
        .expect(401)
    }
    // 第 5 次输对：成交并清零计数
    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, verificationPassword: 'pass123' })
      .expect(201)
    // 计数已清零：再输错不会立即 429
    const wrong = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, verificationPassword: 'nope' })
      .expect(401)
    expect(wrong.body.error.code).toBe('VERIFICATION_FAILED')
  })
})
