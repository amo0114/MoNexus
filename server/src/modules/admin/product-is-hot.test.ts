import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  authHeader,
  createTestUser,
  loginAs,
} from '../../__tests__/helpers.js'

// SPEC-MERCH-001 AC-MERCH-001 / CHK-HOT-001：Product.isHot 是只读受控字段——
// admin 建品/改品传顶层 isHot 同样必须稳定 400 FIELD_NOT_WRITABLE，绝不落库，
// 其它普通 unknown key 仍按原样 generic VALIDATION_ERROR。
async function adminToken(email: string) {
  const { user } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, 'admin123')
  return accessToken
}

describe('admin product isHot is not writable', () => {
  it('create with top-level isHot returns 400 FIELD_NOT_WRITABLE and creates nothing', async () => {
    const token = await adminToken('admin-is-hot-create@test.local')
    const name = '管理员热销商品'

    const res = await api
      .post('/api/admin/products')
      .set(authHeader(token))
      .send({ name, type: '邀请码', price: 100, isHot: true })
      .expect(400)

    expect(res.body.error.code).toBe('FIELD_NOT_WRITABLE')
    expect(res.body.error.code).not.toBe('VALIDATION_ERROR')
    expect(res.body.error.details[0].field).toBe('body.isHot')

    // 校验阶段直接拒绝：不得创建任何商品。
    const count = await prisma.product.count({ where: { name } })
    expect(count).toBe(0)
  })

  it('update with top-level isHot returns 400 FIELD_NOT_WRITABLE and preserves prior isHot', async () => {
    const token = await adminToken('admin-is-hot-update@test.local')

    const created = await api
      .post('/api/admin/products')
      .set(authHeader(token))
      .send({ name: '管理员既有商品', type: '邀请码', price: 100 })
      .expect(201)

    // 模拟 legacy 数据：DB 里已有 isHot=true（客户端改品也不得覆盖）。
    await prisma.product.update({ where: { id: created.body.id }, data: { isHot: true } })

    const res = await api
      .put(`/api/admin/products/${created.body.id}`)
      .set(authHeader(token))
      .send({ isHot: false })
      .expect(400)

    expect(res.body.error.code).toBe('FIELD_NOT_WRITABLE')
    expect(res.body.error.code).not.toBe('VALIDATION_ERROR')

    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.isHot).toBe(true) // 未被客户端 isHot=false 覆盖
  })

  it('create without isHot keeps current behavior; DB isHot stays false', async () => {
    const token = await adminToken('admin-is-hot-valid@test.local')

    const created = await api
      .post('/api/admin/products')
      .set(authHeader(token))
      .send({ name: '管理员正常商品', type: '邀请码', price: 100 })
      .expect(201)
    expect(created.body.error).toBeUndefined()

    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.isHot).toBe(false)
  })

  it('unrelated unknown fields still fail as generic VALIDATION_ERROR, not FIELD_NOT_WRITABLE', async () => {
    const token = await adminToken('admin-is-hot-unrelated@test.local')

    const res = await api
      .post('/api/admin/products')
      .set(authHeader(token))
      .send({ name: '无关字段商品', type: '邀请码', price: 100, sales: 999 })
      .expect(400)

    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})

// D-MERCH-01：admin 读取/写入 wire DTO 与审计快照绝不携带遗留 Product.isHot——
// 即使 legacy DB 列被直接置 true（公开投影的 isHot 由 merchandising run 计算）。
describe('admin product read DTO and audit never expose legacy isHot', () => {
  it('GET /api/admin/products strips isHot while keeping admin inventory/offer fields', async () => {
    const token = await adminToken('admin-is-hot-read-dto@test.local')

    const created = await api
      .post('/api/admin/products')
      .set(authHeader(token))
      .send({ name: '管理读取DTO热销商品', type: '邀请码', price: 100 })
      .expect(201)
    // 模拟 legacy 数据：DB 里直接置 isHot=true。
    await prisma.product.update({ where: { id: created.body.id }, data: { isHot: true } })

    const res = await api
      .get('/api/admin/products')
      .set(authHeader(token))
      .expect(200)

    const item = res.body.items.find((p: { id: number }) => p.id === created.body.id)
    expect(item).toBeTruthy()
    // 用户可见 wire JSON 不得有 isHot key。
    expect('isHot' in item).toBe(false)
    // 显式剥离只删 isHot，不得误删其他管理库存/offer 字段。
    expect(typeof item.stock).toBe('number')
    expect(Array.isArray(item.offers)).toBe(true)
    expect('fakaBridge' in item).toBe(true)
    expect('fakaCapacity' in item).toBe(true)

    // 关键前提：DB 里确实还是 true——只有 DTO 剥离，持久化未变。
    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.isHot).toBe(true)
  })

  it('admin create/update HTTP responses never carry legacy isHot', async () => {
    const token = await adminToken('admin-is-hot-write-dto@test.local')

    const created = await api
      .post('/api/admin/products')
      .set(authHeader(token))
      .send({ name: '管理创建响应商品', type: '邀请码', price: 100 })
      .expect(201)
    expect(typeof created.body.id).toBe('number')
    expect('isHot' in created.body).toBe(false)

    // 模拟 legacy 数据后更新：更新响应同样不得携带 isHot。
    await prisma.product.update({ where: { id: created.body.id }, data: { isHot: true } })

    const updated = await api
      .put(`/api/admin/products/${created.body.id}`)
      .set(authHeader(token))
      .send({ price: 180 })
      .expect(200)
    expect(updated.body.price).toBe(180)
    expect('isHot' in updated.body).toBe(false)

    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.isHot).toBe(true) // 持久化未受影响（仅 DTO 剥离）。
  })

  it('admin create/update audit snapshots contain no isHot', async () => {
    const { user: admin } = await createTestUser('admin-is-hot-audit@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs(admin.email, 'admin123')

    const created = await api
      .post('/api/admin/products')
      .set(authHeader(accessToken))
      .send({ name: '管理审计热销商品', type: '邀请码', price: 100 })
      .expect(201)

    const createLog = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, action: '创建商品', targetType: 'product', targetId: created.body.id },
    })
    expect(createLog.detail).not.toContain('isHot')
    const createDetail = JSON.parse(createLog.detail!) as { after: Record<string, unknown> }
    expect('isHot' in createDetail.after).toBe(false)

    await api
      .put(`/api/admin/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ price: 180 })
      .expect(200)

    const updateLog = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, action: '更新商品', targetType: 'product', targetId: created.body.id },
    })
    expect(updateLog.detail).not.toContain('isHot')
    const updateDetail = JSON.parse(updateLog.detail!) as {
      before: Record<string, unknown>
      after: Record<string, unknown>
    }
    expect('isHot' in updateDetail.before).toBe(false)
    expect('isHot' in updateDetail.after).toBe(false)
  })
})
