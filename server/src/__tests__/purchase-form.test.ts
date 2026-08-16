import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { api, createTestUser, createTestMerchant, createTestProduct, loginAs, authHeader } from './helpers.js'
import { prisma } from '../lib/prisma.js'

const FORM = [
  { key: 'contact', label: '联系方式', type: 'text', required: true, placeholder: 'TG / 邮箱' },
  { key: 'region', label: '账号地区', type: 'select', required: false, options: ['美区', '日区'] },
]

async function setPurchaseForm(productId: number, form: unknown) {
  await prisma.product.update({ where: { id: productId }, data: { purchaseForm: form as object[] } })
}

describe('purchase form definitions (merchant API)', () => {
  it('merchant can create a product with a purchase form; public detail exposes it', async () => {
    const { user } = await createTestMerchant('pf-merchant@test.local', 'pass123', { status: 'active' })
    const { accessToken } = await loginAs('pf-merchant@test.local', 'pass123')

    const res = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '表单商品',
        type: '共享账号',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        purchaseForm: FORM,
        imageUrl: 'https://cdn.test.local/purchase-form-cover.png',
        images: ['https://cdn.test.local/purchase-form-cover.png'],
      })
      .expect(201)
    await api
      .post(`/api/merchant/products/${res.body.id}/publish`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(user).toBeDefined()

    const detail = await api.get(`/api/products/${res.body.id}`).expect(200)
    expect(detail.body.purchaseForm).toHaveLength(2)
    expect(detail.body.purchaseForm[0]).toMatchObject({ key: 'contact', required: true })
  })

  it('rejects invalid definitions: duplicate keys and select without options', async () => {
    await createTestMerchant('pf-bad@test.local', 'pass123', { status: 'active' })
    const { accessToken } = await loginAs('pf-bad@test.local', 'pass123')

    const base = { name: '坏表单', type: '邀请码', price: 10, deliveryMode: 'manual_service', stockMode: 'unlimited' }

    await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        ...base,
        purchaseForm: [
          { key: 'a', label: 'A', type: 'text', required: false },
          { key: 'a', label: 'B', type: 'text', required: false },
        ],
      })
      .expect(400)

    await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ ...base, purchaseForm: [{ key: 'pick', label: '选一个', type: 'select', required: true }] })
      .expect(400)
  })
})

describe('purchase form at order time', () => {
  it('rejects a missing required answer and an illegal select value', async () => {
    await createTestUser('pf-buyer1@test.local', 'pass123', 'user', 1000)
    await createTestProduct('表单校验商品', 100, 3, ['pf-1', 'pf-2', 'pf-3'])
    await setPurchaseForm(1, FORM)
    const { accessToken } = await loginAs('pf-buyer1@test.local', 'pass123')

    const missing = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1 })
      .expect(400)
    expect(missing.body.error.message).toContain('联系方式')

    const badSelect = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, formAnswers: { contact: 'tg:@x', region: '欧区' } })
      .expect(400)
    expect(badSelect.body.error.message).toContain('账号地区')

    expect(await prisma.order.count()).toBe(0)
    const account = await prisma.pointAccount.findFirstOrThrow()
    expect(account.balance).toBe(1000)
  })

  it('snapshots definitions + answers into the order; later form edits do not affect it', async () => {
    await createTestUser('pf-buyer2@test.local', 'pass123', 'user', 1000)
    await createTestProduct('表单快照商品', 100, 3, ['ps-1', 'ps-2', 'ps-3'])
    await setPurchaseForm(1, FORM)
    const { accessToken } = await loginAs('pf-buyer2@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, formAnswers: { contact: 'tg:@buyer', region: '美区', hacker: 'drop' } })
      .expect(201)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(order.purchaseFormSnapshot).toHaveLength(2)
    // 未知 key 被丢弃，不进入存储
    expect(order.purchaseFormAnswers).toEqual({ contact: 'tg:@buyer', region: '美区' })

    await setPurchaseForm(1, [])
    const detail = await api
      .get(`/api/orders/${res.body.orderId}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(detail.body.purchaseFormSnapshot).toHaveLength(2)
    expect(detail.body.purchaseFormAnswers).toEqual({ contact: 'tg:@buyer', region: '美区' })
  })

  it('answers appear in buyer/merchant detail but never in lists or public product APIs', async () => {
    const { merchant } = await createTestMerchant('pf-m2@test.local', 'pass123', { status: 'active' })
    await createTestUser('pf-buyer3@test.local', 'pass123', 'user', 1000)
    await createTestProduct('边界商品', 100, 3, ['pb-1', 'pb-2', 'pb-3'], merchant.id)
    await setPurchaseForm(1, [{ key: 'contact', label: '联系方式', type: 'text', required: true }])

    const buyer = await loginAs('pf-buyer3@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: 1, formAnswers: { contact: 'secret-contact' } })
      .expect(201)

    // 买家订单列表：无答案
    const list = await api.get('/api/orders').set(authHeader(buyer.accessToken)).expect(200)
    expect(JSON.stringify(list.body)).not.toContain('secret-contact')

    // 商品公开接口：无答案
    const pub = await api.get('/api/products/1').expect(200)
    expect(JSON.stringify(pub.body)).not.toContain('secret-contact')

    // 商家订单列表无答案；详情有（履约依据）
    const m = await loginAs('pf-m2@test.local', 'pass123')
    const mList = await api.get('/api/merchant/orders').set(authHeader(m.accessToken)).expect(200)
    expect(JSON.stringify(mList.body)).not.toContain('secret-contact')
    const mDetail = await api
      .get(`/api/merchant/orders/${created.body.orderId}`)
      .set(authHeader(m.accessToken))
      .expect(200)
    expect(mDetail.body.purchaseFormAnswers).toEqual({ contact: 'secret-contact' })
  })

  it('checkout preview exposes the form definitions', async () => {
    await createTestUser('pf-preview@test.local', 'pass123', 'user', 1000)
    await createTestProduct('预览表单商品', 100, 1, ['pv-1'])
    await setPurchaseForm(1, FORM)
    const { accessToken } = await loginAs('pf-preview@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(preview.body.purchaseForm).toHaveLength(2)
    expect(preview.body.purchaseForm[1].options).toEqual(['美区', '日区'])
    expect(typeof preview.body.purchaseFormVersion).toBe('string')
  })

  it('rejects with CHECKOUT_CHANGED when the form changed after preview, without side effects', async () => {
    await createTestUser('pf-version@test.local', 'pass123', 'user', 1000)
    await createTestProduct('改表单商品', 100, 2, ['vc-1', 'vc-2'])
    const { accessToken } = await loginAs('pf-version@test.local', 'pass123')

    // 买家打开弹窗时商品还没有表单
    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)

    // 商家随后新增一个必填字段
    await setPurchaseForm(1, [{ key: 'contact', label: '联系方式', type: 'text', required: true }])

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({
        productId: 1,
        expectedPrice: 100,
        expectedPurchaseFormVersion: preview.body.purchaseFormVersion,
      })
      .expect(409)
    expect(res.body.error.code).toBe('CHECKOUT_CHANGED')

    // 拒单必须无副作用：无订单、无扣款、幂等占用已释放（同 key 可再试）
    expect(await prisma.order.count()).toBe(0)
    const account = await prisma.pointAccount.findFirstOrThrow()
    expect(account.balance).toBe(1000)
    expect(await prisma.idempotencyRecord.count()).toBe(0)

    // 拿新版本重新确认后正常成交
    const fresh = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)
    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({
        productId: 1,
        expectedPrice: 100,
        expectedPurchaseFormVersion: fresh.body.purchaseFormVersion,
        formAnswers: { contact: 'tg:@v' },
      })
      .expect(201)
  })

  it('the same idempotency key with different answers conflicts instead of replaying', async () => {
    await createTestUser('pf-digest@test.local', 'pass123', 'user', 1000)
    await createTestProduct('答案指纹商品', 100, 3, ['dg-1', 'dg-2', 'dg-3'])
    await setPurchaseForm(1, [{ key: 'contact', label: '联系方式', type: 'text', required: true }])
    const { accessToken } = await loginAs('pf-digest@test.local', 'pass123')
    const key = randomUUID()

    const first = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1, formAnswers: { contact: 'answer-A' } })
      .expect(201)

    // 同 key、同答案 → 幂等重放
    const replay = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1, formAnswers: { contact: 'answer-A' } })
      .expect(201)
    expect(replay.body.orderId).toBe(first.body.orderId)

    // 同 key、不同答案 → 409 冲突，绝不静默重放 A 的订单，也不新建订单
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: 1, formAnswers: { contact: 'answer-B' } })
      .expect(409)
    expect(res.body.error.message).toContain('内容不同')

    expect(await prisma.order.count()).toBe(1)
    const order = await prisma.order.findFirstOrThrow()
    expect(order.purchaseFormAnswers).toEqual({ contact: 'answer-A' })
  })
})
