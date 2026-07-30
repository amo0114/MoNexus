import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  acquireCronLeaseWithHeartbeat,
  cronLeaseWindowMs,
  releaseCronLease,
  renewCronLease,
  tryAcquireCronLease,
} from '../lib/cronLease.js'
import { __setDeliveryStorageForTesting } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../lib/storage/deliveryMemory.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
  makeManualService,
} from './helpers.js'

/**
 * P7a 多实例运维收口回归：
 * - CronLease：领取原子性（并发恰一）、过期回收、token 续租、test 直通；
 * - 进度限流（A-T2 验证任务）：复审 P2-4 的订单行 FOR UPDATE 已把
 *   count→create 串行化——barrier 确证两请求真的在锁上排队后，恰一成功
 *   一 429、事件总数不超发；
 * - fileAccess 限流（A-T3）：发放临界区 advisory lock 化后，并发领授权
 *   granted 恰为限值。
 */

const FILE_GRANT_LOCK_CLASS = 20260727

/** barrier：轮询 pg_stat_activity 直到至少 min 个会话在锁上排队（惯例样板 p6-review-fixes）。 */
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

describe('P7a — CronLease', () => {
  const HOUR_MS = 60 * 60 * 1000

  beforeEach(async () => {
    await prisma.cronLease.deleteMany({ where: { name: { startsWith: 'p7a-' } } })
  })

  it('adjudicates concurrent acquires to exactly one winner', async () => {
    // 领取是单条原子 upsert：竞争在 PG 行锁内裁决，没有可控的多语句交错
    // ——Promise.all 并发即真实竞争（barrier 惯例针对的是多语句临界区）。
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => tryAcquireCronLease('p7a-race', HOUR_MS))
    )
    expect(tokens.filter(Boolean)).toHaveLength(1)
  })

  it('throttle window is strictly shorter than the scheduling period (PR #52 review P1)', () => {
    // P1 根因：窗口 == 周期时，「立即首跑 + setInterval(周期)」的下一 tick
    // 恒比窗口末端早 ε 毫秒 → 隔周期执行。修复后 margin ≥ 5s，ε（毫秒级）
    // 被结构性吸收。
    for (const periodMs of [HOUR_MS, 24 * HOUR_MS]) {
      expect(cronLeaseWindowMs(periodMs)).toBeLessThan(periodMs)
      expect(periodMs - cronLeaseWindowMs(periodMs)).toBeGreaterThanOrEqual(5_000)
    }
  })

  it('after an ε-late first acquisition, the next-period tick still executes and the fleet elects exactly one winner', async () => {
    // 首跑：timer 创建后 ε 才领到（真实调用路径天然引入 ε），短批次正常释放互斥。
    const first = await tryAcquireCronLease('p7a-cadence', HOUR_MS)
    expect(first).toBeTruthy()
    expect(await releaseCronLease('p7a-cadence', first!)).toBe(true)

    // 下一 tick 在 t0+周期 到来：把行整体回拨一个周期模拟时间流逝（可控
    // 时序，不靠真实等待/sleep 撞点）。旧 P1 行为（lockedUntil = 领取时刻+
    // 周期且不释放）在该时刻仍差 ε 未过期而跳过；解耦后窗口（周期−margin）
    // 已过 + 互斥已释放 → 必须可领，且舰队并发领取恰一胜出。
    await prisma.$executeRaw`
      UPDATE "CronLease"
      SET "lastStartedAt" = "lastStartedAt" - make_interval(secs => ${HOUR_MS / 1000}),
          "lockedUntil" = "lockedUntil" - make_interval(secs => ${HOUR_MS / 1000})
      WHERE "name" = 'p7a-cadence'`
    const winners = await Promise.all(
      Array.from({ length: 8 }, () => tryAcquireCronLease('p7a-cadence', HOUR_MS))
    )
    expect(winners.filter(Boolean)).toHaveLength(1)
  })

  it('throttles a tick that arrives before the window has elapsed, even with the mutex released', async () => {
    const first = await tryAcquireCronLease('p7a-window', HOUR_MS)
    expect(first).toBeTruthy()
    await releaseCronLease('p7a-window', first!)
    // 互斥已释放——拒绝只能来自窗口节流（lastStartedAt 距今不足窗口）。
    expect(await tryAcquireCronLease('p7a-window', HOUR_MS)).toBeNull()
  })

  it('reclaims a lease past both mutex and window; blocks an active one', async () => {
    await prisma.cronLease.create({
      data: {
        name: 'p7a-exp',
        holder: 'dead:1',
        leaseToken: 'dead',
        lockedUntil: new Date(Date.now() - 1000),
        lastStartedAt: new Date(Date.now() - 25 * HOUR_MS),
      },
    })
    const token = await tryAcquireCronLease('p7a-exp', HOUR_MS)
    expect(token).toBeTruthy()
    expect(await tryAcquireCronLease('p7a-exp', HOUR_MS)).toBeNull()
  })

  it('renews and releases only with the owning token', async () => {
    const token = (await tryAcquireCronLease('p7a-renew', HOUR_MS))!
    // 先把互斥回拨 5s，让「续租后必须变大」的断言不受毫秒分辨率影响。
    await prisma.$executeRaw`
      UPDATE "CronLease" SET "lockedUntil" = "lockedUntil" - make_interval(secs => 5)
      WHERE "name" = 'p7a-renew'`
    const before = await prisma.cronLease.findUniqueOrThrow({ where: { name: 'p7a-renew' } })
    expect(await renewCronLease('p7a-renew', 'wrong-token')).toBe(false)
    expect(await renewCronLease('p7a-renew', token)).toBe(true)
    const after = await prisma.cronLease.findUniqueOrThrow({ where: { name: 'p7a-renew' } })
    expect(after.lockedUntil.getTime()).toBeGreaterThan(before.lockedUntil.getTime())
    expect(await releaseCronLease('p7a-renew', 'wrong-token')).toBe(false)
    expect(await releaseCronLease('p7a-renew', token)).toBe(true)
  })

  it('force runs the real path; test default passes through without touching the table', async () => {
    const handle = await acquireCronLeaseWithHeartbeat('p7a-hb', HOUR_MS, { force: true })
    expect(handle).toBeTruthy()
    expect(await acquireCronLeaseWithHeartbeat('p7a-hb', HOUR_MS, { force: true })).toBeNull()
    handle!.release()

    // nodeEnv=test 直通：既有直调 runXxxBatch 的测试不受租约影响。
    const passthrough = await acquireCronLeaseWithHeartbeat('p7a-passthrough', HOUR_MS)
    expect(passthrough).toBeTruthy()
    passthrough!.release()
    expect(await prisma.cronLease.findUnique({ where: { name: 'p7a-passthrough' } })).toBeNull()
  })
})

describe('P7a — progress rate limit is serialized by the order row lock (A-T2 verification)', () => {
  it('two concurrent 6th posts at the boundary: exactly one succeeds, total stays at the limit', async () => {
    const { merchant } = await createTestMerchant('p7a-prog-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const seller = await loginAs('p7a-prog-m@test.local', 'pass123')
    const product = await createTestProduct('P7a进度并发', 100, 0, [], merchant.id)
    await makeManualService(product.id)
    await createTestUser('p7a-prog-b@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('p7a-prog-b@test.local', 'pass123')
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, expectedPrice: 100 })
      .expect(201)
    const orderId = order.body.orderId as number
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(seller.accessToken))
      .send({})
      .expect(200)

    // 预置 5 条进度：下一条就是窗口内第 6 条（恰在限值边界）。
    const sellerUser = await prisma.user.findUniqueOrThrow({ where: { email: 'p7a-prog-m@test.local' } })
    await prisma.orderStatusEvent.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        orderId,
        actorUserId: sellerUser.id,
        actorRole: 'merchant',
        fromStatus: 'processing',
        toStatus: 'processing',
        action: 'merchant.progress',
        publicNote: `预置进度 ${i + 1}`,
      })),
    })

    // 受控交错：事务 A 先持订单行锁不提交，两条进度请求必须在行锁上排队
    // （barrier 确证 ≥2 个等锁会话）——释放后二者只能串行过临界区。
    let releaseA!: () => void
    const gate = new Promise<void>(resolve => { releaseA = resolve })
    let lockHeld!: () => void
    const held = new Promise<void>(resolve => { lockHeld = resolve })
    const txA = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
      lockHeld()
      await gate
    })
    await held

    const post = (note: string) =>
      api.post(`/api/merchant/orders/${orderId}/progress`).set(authHeader(seller.accessToken)).send({ note })
    const [resA, resB] = (await Promise.all([
      post('并发第 6 条 A'),
      post('并发第 6 条 B'),
      (async () => {
        await waitForLockWaiters(2)
        releaseA()
        await txA
        return null
      })(),
    ])) as [{ status: number; body: any }, { status: number; body: any }, null]

    expect([resA.status, resB.status].sort()).toEqual([200, 429])
    const limited = resA.status === 429 ? resA : resB
    expect(limited.body.error.code).toBe('PROGRESS_RATE_LIMITED')
    // 计数恰好停在限值：FOR UPDATE 串行化下第二个事务可见第一个的提交。
    const total = await prisma.orderStatusEvent.count({ where: { orderId, action: 'merchant.progress' } })
    expect(total).toBe(6)
  })
})

describe('P7a — file grant rate limit is atomic under the advisory lock (A-T3)', () => {
  beforeEach(() => {
    __setDeliveryStorageForTesting(new DeliveryMemoryStorage())
  })

  it('two concurrent requests at the boundary: exactly one granted, audit count stays at the limit', async () => {
    await createTestMerchant('p7a-file-m@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const seller = await loginAs('p7a-file-m@test.local', 'pass123')
    const uploaded = await api
      .post('/api/uploads/delivery-file')
      .set(authHeader(seller.accessToken))
      .attach('file', Buffer.from('p7a-grant-race'), { filename: '交付包.zip', contentType: 'application/zip' })
      .expect(201)
    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(seller.accessToken))
      .send({ name: 'P7a文件商品', type: '充值卡密', price: 100, deliveryMode: 'manual_service', stockMode: 'unlimited' })
      .expect(201)
    const offer = await api
      .post(`/api/merchant/products/${created.body.id}/offers`)
      .set(authHeader(seller.accessToken))
      .send({
        name: '文件版',
        price: 120,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContentType: 'file',
        fixedFileId: uploaded.body.id,
      })
      .expect(201)
    await createTestUser('p7a-file-b@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('p7a-file-b@test.local', 'pass123')
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: created.body.id, offerId: offer.body.id, expectedPrice: 120 })
      .expect(201)
    const orderId = order.body.orderId as number

    // 预置 9 条 granted：下一次发放就是窗口内第 10 条（恰在限值边界）。
    const buyerUser = await prisma.user.findUniqueOrThrow({ where: { email: 'p7a-file-b@test.local' } })
    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    await prisma.fileGrantLog.createMany({
      data: Array.from({ length: 9 }, () => ({
        fileId: delivery.fileId!,
        orderId,
        userId: buyerUser.id,
        role: 'buyer',
        outcome: 'granted',
      })),
    })

    // 受控交错：事务 A 先持同键 advisory lock，两条发放请求在锁上排队
    // （barrier 确证），释放后串行过 count→audit 临界区。
    const lockKey = `${orderId}:${buyerUser.id}`
    let releaseA!: () => void
    const gate = new Promise<void>(resolve => { releaseA = resolve })
    let lockHeld!: () => void
    const held = new Promise<void>(resolve => { lockHeld = resolve })
    const txA = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FILE_GRANT_LOCK_CLASS}::int4, hashtext(${lockKey}))`
      lockHeld()
      await gate
    })
    await held

    const issue = () =>
      api.post(`/api/orders/${orderId}/files/download-url`).set(authHeader(buyer.accessToken))
    const [resA, resB] = (await Promise.all([
      issue(),
      issue(),
      (async () => {
        await waitForLockWaiters(2)
        releaseA()
        await txA
        return null
      })(),
    ])) as [{ status: number; body: any }, { status: number; body: any }, null]

    expect([resA.status, resB.status].sort((a, b) => a - b)).toEqual([200, 429])
    const limited = resA.status === 429 ? resA : resB
    expect(limited.body.error.code).toBe('RATE_LIMITED')
    // granted 恰为限值 10（9 预置 + 1），429 不落审计行——语义与 P5 一致。
    const outcomes = await prisma.fileGrantLog.findMany({
      where: { orderId, userId: buyerUser.id },
      select: { outcome: true },
    })
    expect(outcomes).toHaveLength(10)
    expect(outcomes.every(o => o.outcome === 'granted')).toBe(true)
  })
})
