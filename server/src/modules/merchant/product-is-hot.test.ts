import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  loginAsMerchant,
} from '../../__tests__/helpers.js'

// SPEC-MERCH-001 AC-MERCH-001 / CHK-HOT-001：Product.isHot 是只读受控字段——
// merchant 建品/改品传顶层 isHot 必须稳定 400 FIELD_NOT_WRITABLE，绝不落库，
// 其它普通 unknown key 仍按原样 generic VALIDATION_ERROR。
async function setupMerchant(email: string) {
  const { merchant } = await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: '热销字段商家',
  })
  const { accessToken } = await loginAsMerchant(email, 'pass123')
  return { merchant, accessToken }
}

describe('merchant product isHot is not writable', () => {
  it('create with top-level isHot returns 400 FIELD_NOT_WRITABLE and creates nothing', async () => {
    const { merchant, accessToken } = await setupMerchant('is-hot-create@test.local')

    const res = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '不该落库的热销商品', type: '邀请码', price: 100, isHot: true })
      .expect(400)

    expect(res.body.error.code).toBe('FIELD_NOT_WRITABLE')
    expect(res.body.error.code).not.toBe('VALIDATION_ERROR')
    expect(res.body.error.details).toEqual([{ field: 'body.isHot', message: '字段 isHot 不可写' }])

    // 校验阶段直接拒绝：不得创建任何商品。
    const count = await prisma.product.count({ where: { merchantId: merchant.id } })
    expect(count).toBe(0)
  })

  it('update with top-level isHot returns 400 FIELD_NOT_WRITABLE and preserves prior isHot and other state', async () => {
    const { merchant, accessToken } = await setupMerchant('is-hot-update@test.local')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '既有商品', type: '邀请码', price: 100 })
      .expect(201)

    // 模拟 legacy 数据：DB 里已有 isHot=true（客户端改品也不得覆盖）。
    await prisma.product.update({ where: { id: created.body.id }, data: { isHot: true } })

    const res = await api
      .put(`/api/merchant/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ name: '不应生效的新名字', isHot: false })
      .expect(400)

    expect(res.body.error.code).toBe('FIELD_NOT_WRITABLE')
    expect(res.body.error.code).not.toBe('VALIDATION_ERROR')

    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.isHot).toBe(true) // 未被客户端 isHot=false 覆盖
    expect(row.name).toBe('既有商品') // 同请求里的其它字段也未生效
  })

  it('valid create and update without isHot keep current behavior; DB isHot stays false', async () => {
    const { accessToken } = await setupMerchant('is-hot-valid@test.local')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '正常商品', type: '邀请码', price: 100 })
      .expect(201)
    expect(created.body.error).toBeUndefined()

    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.isHot).toBe(false)

    const updated = await api
      .put(`/api/merchant/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ name: '改名商品' })
      .expect(200)
    expect(updated.body.name).toBe('改名商品')
  })

  it('unrelated unknown fields still fail as generic VALIDATION_ERROR, not FIELD_NOT_WRITABLE', async () => {
    const { accessToken } = await setupMerchant('is-hot-unrelated@test.local')

    const res = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '无关字段商品', type: '邀请码', price: 100, sales: 999 })
      .expect(400)

    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})

// D-MERCH-01：读取/写入 wire DTO 绝不携带遗留 Product.isHot——即使 legacy DB 列被
// 直接置 true（公开投影的 isHot 由 merchandising run 计算，与 Product.isHot 列无关）。
describe('merchant product read DTO never exposes legacy isHot', () => {
  it('GET /api/merchant/products strips isHot from every item even when legacy DB isHot=true', async () => {
    const { accessToken } = await setupMerchant('is-hot-read-dto@test.local')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '读取DTO热销商品', type: '邀请码', price: 100 })
      .expect(201)
    // 模拟 legacy 数据：DB 里直接置 isHot=true（客户端无法写，测试直接落库）。
    await prisma.product.update({ where: { id: created.body.id }, data: { isHot: true } })

    const res = await api
      .get('/api/merchant/products')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.items.length).toBeGreaterThan(0)
    // 用户可见 wire JSON：每个商品都不得有 isHot key。
    expect(res.body.items.every((item: Record<string, unknown>) => !('isHot' in item))).toBe(true)

    // 关键前提：DB 里确实还是 true——只有 DTO 剥离，持久化未变。
    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.isHot).toBe(true)
  })

  it('merchant create/update HTTP responses never carry legacy isHot', async () => {
    const { accessToken } = await setupMerchant('is-hot-write-dto@test.local')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({ name: '创建响应商品', type: '邀请码', price: 100 })
      .expect(201)
    expect(typeof created.body.id).toBe('number')
    expect('isHot' in created.body).toBe(false)

    // 模拟 legacy 数据后更新：更新响应同样不得携带 isHot。
    await prisma.product.update({ where: { id: created.body.id }, data: { isHot: true } })

    const updated = await api
      .put(`/api/merchant/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ name: '更新响应商品' })
      .expect(200)
    expect(updated.body.name).toBe('更新响应商品')
    expect('isHot' in updated.body).toBe(false)

    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.isHot).toBe(true) // 持久化未受影响（仅 DTO 剥离）。
  })
})
