import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  acquireCronLeaseWithHeartbeat,
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
  beforeEach(async () => {
    await prisma.cronLease.deleteMany({ where: { name: { startsWith: 'p7a-' } } })
  })

  it('adjudicates concurrent acquires to exactly one winner', async () => {
    // 领取是单条原子 upsert：竞争在 PG 行锁内裁决，没有可控的多语句交错
    // ——Promise.all 并发即真实竞争（barrier 惯例针对的是多语句临界区）。
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => tryAcquireCronLease('p7a-race', 60_000))
    )
    expect(tokens.filter(Boolean)).toHaveLength(1)
  })

  it('reclaims an expired lease and blocks an active one', async () => {
    await prisma.cronLease.create({
      data: { name: 'p7a-exp', holder: 'dead:1', leaseToken: 'dead', lockedUntil: new Date(Date.now() - 1000) },
    })
    const token = await tryAcquireCronLease('p7a-exp', 60_000)
    expect(token).toBeTruthy()
    // 活租约挡住后续领取（窗口节流：批次结束也不释放）。
    expect(await tryAcquireCronLease('p7a-exp', 60_000)).toBeNull()
  })

  it('renews only with the owning token', async () => {
    const token = (await tryAcquireCronLease('p7a-renew', 60_000))!
    const before = await prisma.cronLease.findUniqueOrThrow({ where: { name: 'p7a-renew' } })
    expect(await renewCronLease('p7a-renew', 'wrong-token', 60_000)).toBe(false)
    expect(await renewCronLease('p7a-renew', token, 120_000)).toBe(true)
    const after = await prisma.cronLease.findUniqueOrThrow({ where: { name: 'p7a-renew' } })
    expect(after.lockedUntil.getTime()).toBeGreaterThan(before.lockedUntil.getTime())
  })

  it('force runs the real path; test default passes through without touching the table', async () => {
    const handle = await acquireCronLeaseWithHeartbeat('p7a-hb', 60_000, { force: true })
    expect(handle).toBeTruthy()
    expect(await acquireCronLeaseWithHeartbeat('p7a-hb', 60_000, { force: true })).toBeNull()
    handle!.stopHeartbeat()

    // nodeEnv=test 直通：既有直调 runXxxBatch 的测试不受租约影响。
    const passthrough = await acquireCronLeaseWithHeartbeat('p7a-passthrough', 60_000)
    expect(passthrough).toBeTruthy()
    passthrough!.stopHeartbeat()
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
