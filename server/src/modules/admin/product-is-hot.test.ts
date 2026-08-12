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
