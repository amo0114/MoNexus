import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('admin product audit trail', () => {
  it('writes safe create and update audit entries in the same request path', async () => {
    const { user: admin } = await createTestUser('product-audit-admin@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs(admin.email, 'admin123')

    const created = await api
      .post('/api/admin/products')
      .set(authHeader(accessToken))
      .send({
        name: '审计商品',
        type: '邀请码',
        icon: 'package',
        price: 100,
        description: '描述不应写入审计详情',
        richDescription: '富文本同样不应写入审计详情',
      })
      .expect(201)

    const platformProduct = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(platformProduct.merchantId).toBeNull()
    expect(platformProduct.status).toBe('draft')
    expect(platformProduct.stock).toBe(0)

    const createLog = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, action: '创建商品', targetType: 'product', targetId: created.body.id },
    })
    expect(createLog.detail).toContain('"price":100')
    expect(createLog.detail).not.toContain('描述不应写入审计详情')
    expect(createLog.detail).not.toContain('富文本同样不应写入审计详情')

    await api
      .put(`/api/admin/products/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ price: 180, richDescription: '更新后的富文本' })
      .expect(200)

    const updateLog = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, action: '更新商品', targetType: 'product', targetId: created.body.id },
    })
    expect(JSON.parse(updateLog.detail!).changedFields).toEqual(
      expect.arrayContaining(['price', 'richDescription'])
    )
    expect(updateLog.detail).toContain('"price":100')
    expect(updateLog.detail).toContain('"price":180')
    expect(updateLog.detail).not.toContain('更新后的富文本')
  })
})
