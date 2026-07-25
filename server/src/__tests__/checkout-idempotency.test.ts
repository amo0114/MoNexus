import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { api, createTestUser, createTestProduct, loginAs, authHeader } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('POST /api/orders idempotency', () => {
  it('serial replay with the same key returns the original order and debits once', async () => {
    await createTestUser('idem-replay@test.local', 'pass123', 'user', 1000)
    await createTestProduct('幂等商品', 300, 3, ['key-a', 'key-b', 'key-c'])
    const { accessToken } = await loginAs('idem-replay@test.local', 'pass123')
    const key = randomUUID()

    const first = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1 })
      .expect(201)

    const replay = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1 })
      .expect(201)

    expect(replay.body.orderId).toBe(first.body.orderId)
    expect(replay.body.idempotentReplay).toBe(true)
    expect(replay.body.deliveryContent).toBe(first.body.deliveryContent)

    expect(await prisma.order.count()).toBe(1)
    const account = await prisma.pointAccount.findFirstOrThrow()
    expect(account.balance).toBe(700)
  })

  it('concurrent submits with the same key create exactly one order', async () => {
    await createTestUser('idem-race@test.local', 'pass123', 'user', 1000)
    await createTestProduct('并发商品', 200, 5, ['c-1', 'c-2', 'c-3', 'c-4', 'c-5'])
    const { accessToken } = await loginAs('idem-race@test.local', 'pass123')
    const key = randomUUID()

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        api
          .post('/api/orders')
          .set(authHeader(accessToken))
          .set('Idempotency-Key', key)
          .send({ productId: 1 })
      )
    )

    // 每个响应要么创建/重放同一订单（201），要么因并发处理中被拒（409）。
    const created = responses.filter(r => r.status === 201)
    const conflicted = responses.filter(r => r.status === 409)
    expect(created.length).toBeGreaterThanOrEqual(1)
    expect(created.length + conflicted.length).toBe(responses.length)
    expect(new Set(created.map(r => r.body.orderId)).size).toBe(1)

    expect(await prisma.order.count()).toBe(1)
    const account = await prisma.pointAccount.findFirstOrThrow()
    expect(account.balance).toBe(800)
  })

  it('different keys create independent orders', async () => {
    await createTestUser('idem-two@test.local', 'pass123', 'user', 1000)
    await createTestProduct('普通商品', 100, 5, ['x-1', 'x-2', 'x-3', 'x-4', 'x-5'])
    const { accessToken } = await loginAs('idem-two@test.local', 'pass123')

    const r1 = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ productId: 1 })
      .expect(201)
    const r2 = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ productId: 1 })
      .expect(201)

    expect(r1.body.orderId).not.toBe(r2.body.orderId)
    expect(await prisma.order.count()).toBe(2)
  })

  it('a failed attempt releases the key so the same intent can retry', async () => {
    await createTestUser('idem-retry@test.local', 'pass123', 'user', 1000)
    // 无库存商品：第一次下单失败后，同 key 重试必须仍可尝试而不是 409。
    await createTestProduct('售罄商品', 100, 0, [])
    const { accessToken } = await loginAs('idem-retry@test.local', 'pass123')
    const key = randomUUID()

    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1 })
      .expect(400)

    expect(await prisma.idempotencyRecord.count()).toBe(0)

    await prisma.inventoryItem.create({ data: { productId: 1, content: 'restock-1' } })
    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1 })
      .expect(201)
  })

  it('rejects a malformed Idempotency-Key', async () => {
    await createTestUser('idem-bad@test.local', 'pass123', 'user', 1000)
    await createTestProduct('商品', 100, 1, ['y-1'])
    const { accessToken } = await loginAs('idem-bad@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', 'not-a-uuid')
      .send({ productId: 1 })
      .expect(400)
    expect(res.body.error.message).toContain('Idempotency-Key')
  })

  it('rejects the same key reused for a different product (fingerprint mismatch)', async () => {
    await createTestUser('idem-fp@test.local', 'pass123', 'user', 1000)
    await createTestProduct('商品A', 100, 1, ['fp-a'])
    await createTestProduct('商品B', 100, 1, ['fp-b'])
    const { accessToken } = await loginAs('idem-fp@test.local', 'pass123')
    const key = randomUUID()

    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1 })
      .expect(201)

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 2 })
      .expect(409)
    expect(res.body.error.message).toContain('内容不同')
    expect(await prisma.order.count()).toBe(1)
  })

  it('replays a P1 legacy record (empty requestDigest) for the same product', async () => {
    // 迁移为既有 P1 记录回填 requestDigest = ''。部署后 24h 重放窗口内，
    // 同商品同 key 重试必须仍能重放原订单，而不是因空摘要误判"内容不同"。
    const { user } = await createTestUser('idem-legacy@test.local', 'pass123', 'user', 1000)
    await createTestProduct('遗留商品', 100, 1, ['lg-1'])
    const { accessToken } = await loginAs('idem-legacy@test.local', 'pass123')
    const key = randomUUID()

    // 预置一条 P1 语义的已完成记录:有 productId,requestDigest 为空。
    const order = await prisma.order.create({
      data: { userId: user.id, productId: 1, price: 100 },
    })
    await prisma.idempotencyRecord.create({
      data: {
        userId: user.id,
        key,
        productId: 1,
        requestDigest: '',
        claimToken: randomUUID(),
        status: 'completed',
        orderId: order.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    // 同商品同 key → 按 P1 语义重放原订单,不新建、不冲突。
    const replay = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1 })
      .expect(201)
    expect(replay.body.orderId).toBe(order.id)
    expect(replay.body.idempotentReplay).toBe(true)
    expect(await prisma.order.count()).toBe(1)

    // 但空摘要旧记录换成别的商品仍应冲突(P1 已按 productId 校验)。
    await createTestProduct('遗留商品B', 100, 1, ['lg-2'])
    const conflict = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 2 })
      .expect(409)
    expect(conflict.body.error.message).toContain('内容不同')
  })

  it('a stalled holder loses its lease after takeover: it can neither complete nor release', async () => {
    const { claimIdempotencyKey, completeIdempotencyClaim, releaseIdempotencyClaim } =
      await import('../modules/orders/idempotency.js')
    const { user } = await createTestUser('idem-lease@test.local', 'pass123', 'user', 1000)
    await createTestProduct('租约商品', 100, 2, ['l-1', 'l-2'])
    const key = randomUUID()

    // 持有者 A 占用后"卡住"超过 TTL（直接把 expiresAt 拨到过去模拟）。
    const claimA = await claimIdempotencyKey(user.id, key, { productId: 1 })
    if (claimA.kind !== 'claimed') throw new Error('expected fresh claim')
    await prisma.idempotencyRecord.updateMany({
      where: { userId: user.id, key },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    // 持有者 B 接管，租约 token 被更换。
    const claimB = await claimIdempotencyKey(user.id, key, { productId: 1 })
    if (claimB.kind !== 'claimed') throw new Error('expected takeover claim')
    expect(claimB.claimToken).not.toBe(claimA.claimToken)

    // A 恢复后尝试完成：token 不匹配必须抛错（订单事务随之回滚）。
    await expect(
      prisma.$transaction(tx => completeIdempotencyClaim(tx, user.id, key, claimA.claimToken, 999))
    ).rejects.toThrow()

    // A 的释放也不能删掉 B 正在使用的占用。
    await releaseIdempotencyClaim(user.id, key, claimA.claimToken)
    expect(await prisma.idempotencyRecord.count({ where: { userId: user.id, key } })).toBe(1)

    // B 自己的租约仍然有效，可正常完成。
    const order = await prisma.order.create({
      data: { userId: user.id, productId: 1, price: 100 },
    })
    await prisma.$transaction(tx =>
      completeIdempotencyClaim(tx, user.id, key, claimB.claimToken, order.id)
    )
    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { userId_key: { userId: user.id, key } },
    })
    expect(record.status).toBe('completed')
    expect(record.orderId).toBe(order.id)
  })
})

describe('POST /api/orders expectedPrice confirmation', () => {
  it('rejects with PRICE_CHANGED when the price moved after preview', async () => {
    await createTestUser('price-changed@test.local', 'pass123', 'user', 1000)
    await createTestProduct('调价商品', 300, 2, ['p-1', 'p-2'])
    const { accessToken } = await loginAs('price-changed@test.local', 'pass123')

    await prisma.product.update({ where: { id: 1 }, data: { price: 400 } })

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 300 })
      .expect(409)
    expect(res.body.error.code).toBe('PRICE_CHANGED')

    // 拒单必须无副作用：无订单、无积分变动、幂等占用已释放。
    expect(await prisma.order.count()).toBe(0)
    const account = await prisma.pointAccount.findFirstOrThrow()
    expect(account.balance).toBe(1000)
  })

  it('accepts when expectedPrice matches the current price', async () => {
    await createTestUser('price-ok@test.local', 'pass123', 'user', 1000)
    await createTestProduct('稳价商品', 300, 2, ['q-1', 'q-2'])
    const { accessToken } = await loginAs('price-ok@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 300 })
      .expect(201)
    expect(res.body.price).toBe(300)
  })
})

describe('GET /api/checkout/preview', () => {
  it('returns debit preview matching the actual charge', async () => {
    await createTestUser('preview@test.local', 'pass123', 'user', 860)
    await createTestProduct('预览商品', 300, 2, ['v-1', 'v-2'])
    const { accessToken } = await loginAs('preview@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(preview.body).toMatchObject({
      productId: 1,
      productName: '预览商品',
      price: 300,
      chargeType: 'debit',
      balanceBefore: 860,
      balanceAfter: 560,
      sufficient: true,
    })

    const order = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: preview.body.price })
      .expect(201)
    expect(order.body.balanceAfter).toBe(preview.body.balanceAfter)
  })

  it('returns hold preview for manual_service products', async () => {
    await createTestUser('preview-hold@test.local', 'pass123', 'user', 500)
    await createTestProduct('人工服务', 200, 3, [])
    await prisma.product.update({
      where: { id: 1 },
      data: { deliveryMode: 'manual_service' },
    })
    const { accessToken } = await loginAs('preview-hold@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(preview.body.chargeType).toBe('hold')
    expect(preview.body.balanceAfter).toBe(300)
  })

  it('still previews when balance is insufficient, flagged sufficient=false', async () => {
    await createTestUser('preview-poor@test.local', 'pass123', 'user', 100)
    await createTestProduct('贵商品', 300, 1, ['z-1'])
    const { accessToken } = await loginAs('preview-poor@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(preview.body.sufficient).toBe(false)
    expect(preview.body.balanceAfter).toBe(-200)
  })

  it('flags sold-out inventory as unpurchasable with a reason', async () => {
    await createTestUser('preview-soldout@test.local', 'pass123', 'user', 1000)
    await createTestProduct('售罄预览', 100, 0, [])
    const { accessToken } = await loginAs('preview-soldout@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(preview.body.purchasable).toBe(false)
    expect(preview.body.unpurchasableReason).toContain('库存不足')
  })

  it('404s for a missing product and 400s for an inactive one', async () => {
    await createTestUser('preview-none@test.local', 'pass123', 'user', 100)
    await createTestProduct('下架预览', 100, 1, ['w-1'])
    await prisma.product.update({ where: { id: 1 }, data: { status: 'inactive' } })
    const { accessToken } = await loginAs('preview-none@test.local', 'pass123')

    await api
      .get('/api/checkout/preview')
      .query({ productId: 999 })
      .set(authHeader(accessToken))
      .expect(404)
    await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(400)
  })
})
