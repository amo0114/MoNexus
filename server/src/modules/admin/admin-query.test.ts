import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
} from '../../__tests__/helpers.js'
import { prisma } from '../../lib/prisma.js'

async function loginAdmin(email = 'aq-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

describe('GET /api/admin/users search & pagination', () => {
  it('should match q against email case-insensitively', async () => {
    const { accessToken } = await loginAdmin()
    await createTestUser('alice@search.local', 'pass123', 'user')
    await createTestUser('bob@search.local', 'pass123', 'user')

    const res = await api
      .get('/api/admin/users')
      .query({ q: 'ALICE' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.total).toBe(1)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].email).toBe('alice@search.local')
  })

  it('should match q against the merchant name of the user', async () => {
    const { accessToken } = await loginAdmin()
    await createTestMerchant('shop-owner@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '青云小铺',
    })
    await createTestUser('plain@test.local', 'pass123', 'user')

    const res = await api
      .get('/api/admin/users')
      .query({ q: '青云' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.total).toBe(1)
    expect(res.body.items[0].email).toBe('shop-owner@test.local')
  })

  it('should paginate with a correct total', async () => {
    const { accessToken } = await loginAdmin()
    await createTestUser('u1@search.local', 'pass123', 'user')
    await createTestUser('u2@search.local', 'pass123', 'user')
    await createTestUser('u3@search.local', 'pass123', 'user')

    const page1 = await api
      .get('/api/admin/users')
      .query({ q: 'search.local', page: 1, pageSize: 2 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(page1.body.total).toBe(3)
    expect(page1.body.page).toBe(1)
    expect(page1.body.pageSize).toBe(2)
    expect(page1.body.items).toHaveLength(2)

    const page2 = await api
      .get('/api/admin/users')
      .query({ q: 'search.local', page: 2, pageSize: 2 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(page2.body.total).toBe(3)
    expect(page2.body.items).toHaveLength(1)

    const allEmails = [...page1.body.items, ...page2.body.items].map((u: any) => u.email)
    expect(new Set(allEmails).size).toBe(3)
  })

  it('should keep item fields backward compatible and never leak credentials', async () => {
    const { accessToken } = await loginAdmin()
    await createTestUser('safe@test.local', 'pass123', 'user', 777)

    const res = await api
      .get('/api/admin/users')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.page).toBe(1)
    expect(res.body.pageSize).toBe(20)
    expect(res.body.total).toBe(2)
    for (const u of res.body.items) {
      expect(u.id).toBeDefined()
      expect(u.email).toBeDefined()
      expect(u.role).toBeDefined()
      expect(u.status).toBeDefined()
      expect(u.inviteCode).toBeDefined()
      expect(u.createdAt).toBeDefined()
      expect(u.pointAccount).toBeDefined()
      expect(u.password).toBeUndefined()
      expect(u.refreshTokens).toBeUndefined()
    }
  })

  it('should use systemConfig defaultPageSize when pageSize is omitted', async () => {
    const { accessToken } = await loginAdmin()
    try {
      await api
        .put('/api/admin/config/defaultPageSize')
        .set(authHeader(accessToken))
        .send({ value: 2 })
        .expect(200)

      await createTestUser('cfg1@test.local', 'pass123', 'user')
      await createTestUser('cfg2@test.local', 'pass123', 'user')
      await createTestUser('cfg3@test.local', 'pass123', 'user')

      const res = await api
        .get('/api/admin/users')
        .set(authHeader(accessToken))
        .expect(200)

      expect(res.body.pageSize).toBe(2)
      expect(res.body.items).toHaveLength(2)
      expect(res.body.total).toBe(4)
    } finally {
      // SystemConfig 不在 setup 清表名单内，必须自行恢复
      await prisma.systemConfig.deleteMany({ where: { key: 'defaultPageSize' } })
    }
  })

  it('should reject invalid pagination params', async () => {
    const { accessToken } = await loginAdmin()

    await api
      .get('/api/admin/users')
      .query({ page: 0 })
      .set(authHeader(accessToken))
      .expect(400)

    await api
      .get('/api/admin/users')
      .query({ pageSize: 101 })
      .set(authHeader(accessToken))
      .expect(400)

    await api
      .get('/api/admin/users')
      .query({ pageSize: -5 })
      .set(authHeader(accessToken))
      .expect(400)
  })
})

describe('GET /api/admin/orders filter & pagination', () => {
  async function seedOrders() {
    const { accessToken } = await loginAdmin('aq-orders-admin@test.local')
    await createTestUser('order-buyer@test.local', 'buyerpass', 'user', 10000)

    const instantProduct = await createTestProduct('即时商品', 300, 1, ['instant-secret'])
    const manualProduct = await createTestProduct('人工商品', 200, 0, [])
    await prisma.product.update({
      where: { id: manualProduct.id },
      data: { deliveryMode: 'manual_service' },
    })

    const buyer = await loginAs('order-buyer@test.local', 'buyerpass')
    const instantOrder = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: instantProduct.id })
      .expect(201)
    const manualOrder = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: manualProduct.id })
      .expect(201)

    return {
      accessToken,
      instantOrderId: instantOrder.body.orderId as number,
      manualOrderId: manualOrder.body.orderId as number,
    }
  }

  it('should filter orders by status', async () => {
    const { accessToken, instantOrderId, manualOrderId } = await seedOrders()

    const pending = await api
      .get('/api/admin/orders')
      .query({ status: 'pending' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(pending.body.total).toBe(1)
    expect(pending.body.items[0].id).toBe(manualOrderId)
    expect(pending.body.items[0].status).toBe('pending')

    const delivered = await api
      .get('/api/admin/orders')
      .query({ status: 'delivered' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(delivered.body.total).toBe(1)
    expect(delivered.body.items[0].id).toBe(instantOrderId)
    expect(delivered.body.items[0].status).toBe('delivered')
  })

  it('should reject invalid status with 400', async () => {
    const { accessToken } = await loginAdmin('aq-orders-bad@test.local')

    await api
      .get('/api/admin/orders')
      .query({ status: 'shipped' })
      .set(authHeader(accessToken))
      .expect(400)
  })

  it('should match q against buyer email and exact order id', async () => {
    const { accessToken, instantOrderId } = await seedOrders()

    const byEmail = await api
      .get('/api/admin/orders')
      .query({ q: 'ORDER-BUYER@test' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(byEmail.body.total).toBe(2)

    const byId = await api
      .get('/api/admin/orders')
      .query({ q: String(instantOrderId) })
      .set(authHeader(accessToken))
      .expect(200)

    expect(byId.body.items.map((o: any) => o.id)).toContain(instantOrderId)

    const miss = await api
      .get('/api/admin/orders')
      .query({ q: 'no-such-buyer@nowhere' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(miss.body.total).toBe(0)
    expect(miss.body.items).toEqual([])
  })

  it('should paginate orders and keep delivery content hidden', async () => {
    const { accessToken } = await seedOrders()

    const res = await api
      .get('/api/admin/orders')
      .query({ page: 1, pageSize: 1 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.total).toBe(2)
    expect(res.body.page).toBe(1)
    expect(res.body.pageSize).toBe(1)
    expect(res.body.items).toHaveLength(1)
    for (const order of res.body.items) {
      if (order.delivery) expect(order.delivery.content).toBeUndefined()
    }
  })
})

describe('GET /api/admin/config metadata', () => {
  const expectedGroups = ['奖励发放', '分页限制', '库存', '会员等级', '安全']

  it('should attach Chinese description and group to all 13 keys', async () => {
    const { accessToken } = await loginAdmin('aq-config-admin@test.local')

    const res = await api
      .get('/api/admin/config')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toHaveLength(13)
    for (const item of res.body) {
      expect(typeof item.description).toBe('string')
      expect(item.description.length).toBeGreaterThan(0)
      expect(expectedGroups).toContain(item.group)
      expect('hint' in item).toBe(true)
    }

    const byKey = new Map<string, any>(res.body.map((item: any) => [item.key, item]))
    expect(byKey.get('registerReward').group).toBe('奖励发放')
    expect(byKey.get('defaultPageSize').group).toBe('分页限制')
    expect(byKey.get('maxPageSize').group).toBe('分页限制')
    expect(byKey.get('lowStockThreshold').group).toBe('库存')
    expect(byKey.get('memberTierGoldThreshold').group).toBe('会员等级')
    expect(byKey.get('refreshTokenMaxAgeDays').group).toBe('安全')
    expect(byKey.get('memberTierSilverBonusBps').hint).toContain('万分')
    expect(byKey.get('registerReward').description).toContain('注册')
  })

  it('should keep metadata on PUT /api/admin/config/:key responses', async () => {
    const { accessToken } = await loginAdmin('aq-config-put@test.local')
    try {
      const res = await api
        .put('/api/admin/config/checkinReward')
        .set(authHeader(accessToken))
        .send({ value: 66 })
        .expect(200)

      expect(res.body.value).toBe(66)
      expect(res.body.description).toContain('签到')
      expect(res.body.group).toBe('奖励发放')
    } finally {
      await prisma.systemConfig.deleteMany({ where: { key: 'checkinReward' } })
    }
  })
})

describe('POST /api/admin/products/:id/inventory writes InventoryLog', () => {
  it('should log an import entry with merchant attribution and AdminLog', async () => {
    const { user: admin, accessToken } = await loginAdmin('aq-inv-admin@test.local')
    const { merchant } = await createTestMerchant('aq-inv-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '补货商家',
    })
    const product = await createTestProduct('补货商品', 100, 0, [], merchant.id)

    const res = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['re-1', 're-2', 're-3'] })
      .expect(200)

    expect(res.body.imported).toBe(3)

    const log = await prisma.inventoryLog.findFirstOrThrow({
      where: { productId: product.id },
    })
    expect(log.action).toBe('import')
    expect(log.delta).toBe(3)
    expect(log.actorUserId).toBe(admin.id)
    expect(log.merchantId).toBe(merchant.id)

    const adminLog = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, targetType: 'product', targetId: product.id },
    })
    expect(adminLog.action).toContain('导入库存')

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(updated.stock).toBe(3)
  })

  it('should log merchantId as null for platform-owned products', async () => {
    const { user: admin, accessToken } = await loginAdmin('aq-inv-admin2@test.local')
    const product = await createTestProduct('平台商品', 100, 0, [])

    await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['p-1', 'p-2'] })
      .expect(200)

    const log = await prisma.inventoryLog.findFirstOrThrow({
      where: { productId: product.id, actorUserId: admin.id },
    })
    expect(log.action).toBe('import')
    expect(log.delta).toBe(2)
    expect(log.merchantId).toBeNull()
  })
})

describe('seed.ts no longer creates fake reviews', () => {
  it('should not reference reviewData or prisma.review anywhere in seed source', async () => {
    const seedPath = fileURLToPath(new URL('../../prisma/seed.ts', import.meta.url))
    const source = await readFile(seedPath, 'utf8')

    expect(source).not.toContain('reviewData')
    expect(source).not.toContain('prisma.review')
  })
})
