import { describe, it, expect } from 'vitest'
import { api, createTestUser, createTestProduct, createTestMerchant, getDefaultOfferId, makeManualService, loginAs, authHeader } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('Admin access control', () => {
  it('should reject unauthenticated access to admin routes', async () => {
    await api.get('/api/admin/stats').expect(401)
    await api.get('/api/admin/users').expect(401)
    await api.get('/api/admin/orders').expect(401)
  })

  it('should reject non-admin user access', async () => {
    await createTestUser('normal@test.local', 'pass123', 'user')
    const { accessToken } = await loginAs('normal@test.local', 'pass123')

    await api
      .get('/api/admin/stats')
      .set(authHeader(accessToken))
      .expect(403)

    await api
      .get('/api/admin/users')
      .set(authHeader(accessToken))
      .expect(403)
  })

  it('should allow admin access', async () => {
    await createTestUser('boss@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs('boss@test.local', 'admin123')

    const res = await api
      .get('/api/admin/stats')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.users).toBeDefined()
    expect(res.body.orders).toBeDefined()
    expect(res.body.productCount).toBeDefined()
  })
})

describe('GET /api/admin/users', () => {
  it('should not expose password field', async () => {
    await createTestUser('boss2@test.local', 'admin456', 'admin')
    await createTestUser('victim@test.local', 'mypass', 'user')
    const { accessToken } = await loginAs('boss2@test.local', 'admin456')

    const res = await api
      .get('/api/admin/users')
      .set(authHeader(accessToken))
      .expect(200)

    expect(Array.isArray(res.body.items)).toBe(true)
    expect(res.body.total).toBe(2)
    for (const u of res.body.items) {
      expect(u.password).toBeUndefined()
      expect(u.email).toBeDefined()
      expect(u.role).toBeDefined()
    }
  })
})

describe('PUT /api/admin/users/:id/ban and /unban', () => {
  it('should ban a normal user, revoke refresh tokens, block login, and write an audit log', async () => {
    await createTestUser('ban-admin@test.local', 'admin123', 'admin')
    const { user: target, password } = await createTestUser('ban-target@test.local', 'pass123', 'user')
    const targetLogin = await loginAs(target.email, password)
    const admin = await loginAs('ban-admin@test.local', 'admin123')

    const res = await api
      .put(`/api/admin/users/${target.id}/ban`)
      .set(authHeader(admin.accessToken))
      .send({ reason: 'abuse' })
      .expect(200)

    expect(res.body.status).toBe('已封禁')

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(updated.status).toBe('已封禁')

    await api
      .post('/api/auth/login')
      .send({ email: target.email, password })
      .expect(400)

    await api
      .post('/api/auth/refresh')
      .set('Cookie', targetLogin.cookies)
      .expect(401)

    const tokens = await prisma.refreshToken.findMany({ where: { userId: target.id } })
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every(token => token.revoked)).toBe(true)

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: 1, targetType: 'user', targetId: target.id },
    })
    expect(log.action).toContain('封禁')
    expect(log.detail).toContain('abuse')
  })

  it('should unban a user, allow login again, and write an audit log', async () => {
    await createTestUser('unban-admin@test.local', 'admin123', 'admin')
    const { user: target, password } = await createTestUser('unban-target@test.local', 'pass123', 'user')
    await prisma.user.update({
      where: { id: target.id },
      data: { status: '已封禁' },
    })
    const admin = await loginAs('unban-admin@test.local', 'admin123')

    const res = await api
      .put(`/api/admin/users/${target.id}/unban`)
      .set(authHeader(admin.accessToken))
      .expect(200)

    expect(res.body.status).toBe('正常')

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(updated.status).toBe('正常')

    await api
      .post('/api/auth/login')
      .send({ email: target.email, password })
      .expect(200)

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: 1, targetType: 'user', targetId: target.id },
    })
    expect(log.action).toContain('解封')
  })

  it('should reject non-admin ban attempts', async () => {
    await createTestUser('ban-normal@test.local', 'pass123', 'user')
    const { user: target } = await createTestUser('ban-normal-target@test.local', 'pass123', 'user')
    const normal = await loginAs('ban-normal@test.local', 'pass123')

    await api
      .put(`/api/admin/users/${target.id}/ban`)
      .set(authHeader(normal.accessToken))
      .send({ reason: 'abuse' })
      .expect(403)
  })

  it('should reject self-ban', async () => {
    const { user: adminUser } = await createTestUser('self-ban-admin@test.local', 'admin123', 'admin')
    const admin = await loginAs('self-ban-admin@test.local', 'admin123')

    await api
      .put(`/api/admin/users/${adminUser.id}/ban`)
      .set(authHeader(admin.accessToken))
      .send({ reason: 'mistake' })
      .expect(400)
  })

  it('should reject banning another admin', async () => {
    await createTestUser('ban-admin-actor@test.local', 'admin123', 'admin')
    const { user: targetAdmin } = await createTestUser('ban-admin-target@test.local', 'admin123', 'admin')
    const admin = await loginAs('ban-admin-actor@test.local', 'admin123')

    await api
      .put(`/api/admin/users/${targetAdmin.id}/ban`)
      .set(authHeader(admin.accessToken))
      .send({ reason: 'abuse' })
      .expect(400)
  })

  it('should return 404 when the target user does not exist', async () => {
    await createTestUser('ban-missing-admin@test.local', 'admin123', 'admin')
    const admin = await loginAs('ban-missing-admin@test.local', 'admin123')

    await api
      .put('/api/admin/users/9999/ban')
      .set(authHeader(admin.accessToken))
      .send({ reason: 'missing' })
      .expect(404)
  })
})

describe('POST /api/admin/users/:id/adjust', () => {
  it('should add points to user', async () => {
    await createTestUser('boss3@test.local', 'admin789', 'admin')
    const { user: target } = await createTestUser('target@test.local', 'pass', 'user', 100)
    const { accessToken } = await loginAs('boss3@test.local', 'admin789')

    const res = await api
      .post(`/api/admin/users/${target.id}/adjust`)
      .set(authHeader(accessToken))
      .send({ type: 'add', amount: 300, reason: '测试补偿' })
      .expect(200)

    expect(res.body.newBalance).toBe(400)
  })

  it('should reject deduct exceeding balance', async () => {
    await createTestUser('boss4@test.local', 'admin000', 'admin')
    const { user: target } = await createTestUser('poortarget@test.local', 'pass', 'user', 50)
    const { accessToken } = await loginAs('boss4@test.local', 'admin000')

    const res = await api
      .post(`/api/admin/users/${target.id}/adjust`)
      .set(authHeader(accessToken))
      .send({ type: 'deduct', amount: 999, reason: '违规扣除' })
      .expect(400)

    expect(res.body.error.message).toContain('余额')
  })
})

describe('POST /api/admin/products/:id/inventory', () => {
  it('should import inventory items', async () => {
    await createTestUser('boss5@test.local', 'admin111', 'admin')
    await createTestProduct('库存商品', 200, 0, [])
    const { accessToken } = await loginAs('boss5@test.local', 'admin111')

    const res = await api
      .post('/api/admin/products/1/inventory')
      .set(authHeader(accessToken))
      .send({ items: ['new-item-1', 'new-item-2', 'new-item-3'] })
      .expect(200)

    expect(res.body.imported).toBe(3)
  })

  it('normalizes blank lines, rejects duplicate or existing items, and never partially writes', async () => {
    await createTestUser('boss-inventory-normalize@test.local', 'admin111', 'admin')
    const product = await createTestProduct('管理员规范补库存商品', 200, 0, [])
    await prisma.inventoryItem.create({
      data: { productId: product.id, offerId: await getDefaultOfferId(product.id), content: 'existing-code' },
    })
    const { accessToken } = await loginAs('boss-inventory-normalize@test.local', 'admin111')

    const normalized = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['  ', ' normalized-code '] })
      .expect(200)
    expect(normalized.body).toMatchObject({ imported: 1, skippedEmptyRows: 1 })

    const repeated = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['  ', 'new-code', ' new-code '] })
      .expect(400)
    expect(repeated.body.error.message).toBe('库存导入包含重复项')

    const existing = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['another-new-code', ' existing-code '] })
      .expect(400)
    expect(existing.body.error.message).toBe('库存导入包含重复项')

    const inventory = await prisma.inventoryItem.findMany({
      where: { productId: product.id },
      select: { content: true },
      orderBy: { content: 'asc' },
    })
    expect(inventory).toEqual([{ content: 'existing-code' }, { content: 'normalized-code' }])
    expect(await prisma.inventoryLog.count({ where: { productId: product.id } })).toBe(1)
    expect(await prisma.adminLog.count({ where: { targetType: 'product', targetId: product.id } })).toBe(1)
  })

  // P4a F2：管理端导入支持指定规格；缺省时默认规格非即时库存则回退唯一即时库存规格。
  it('imports into an explicitly selected offer, leaving the default offer untouched', async () => {
    await createTestUser('boss-offer-import@test.local', 'admin111', 'admin')
    const product = await createTestProduct('多规格库存商品', 200, 0, [])
    const defaultOfferId = await getDefaultOfferId(product.id)
    const extra = await prisma.offer.create({
      data: { productId: product.id, name: '高级规格', price: 300 },
    })
    const { accessToken } = await loginAs('boss-offer-import@test.local', 'admin111')

    const res = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['offer-scoped-1', 'offer-scoped-2'], offerId: extra.id })
      .expect(200)
    expect(res.body.imported).toBe(2)

    expect(await prisma.inventoryItem.count({ where: { offerId: extra.id } })).toBe(2)
    expect(await prisma.inventoryItem.count({ where: { offerId: defaultOfferId } })).toBe(0)
  })

  it('falls back to the sole instant_inventory offer when the default offer is manual_service', async () => {
    await createTestUser('boss-fallback-import@test.local', 'admin111', 'admin')
    const product = await createTestProduct('混合模式商品', 200, 0, [])
    // 默认规格切成人工服务；仅剩的即时库存规格是导入的唯一合理目标。
    await makeManualService(product.id)
    const instantOffer = await prisma.offer.create({
      data: { productId: product.id, name: '卡密规格', price: 200 },
    })
    const { accessToken } = await loginAs('boss-fallback-import@test.local', 'admin111')

    const res = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['fallback-1'] })
      .expect(200)
    expect(res.body.imported).toBe(1)
    expect(await prisma.inventoryItem.count({ where: { offerId: instantOffer.id } })).toBe(1)

    // 出现第二个即时库存规格后无法猜测意图 → 要求显式指定。
    await prisma.offer.create({
      data: { productId: product.id, name: '第二卡密规格', price: 260 },
    })
    const ambiguous = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['fallback-2'] })
      .expect(400)
    expect(ambiguous.body.error.message).toContain('请指定 offerId')
  })

  it('rejects non-instant offers, foreign offers, templated offers, and products without instant offers', async () => {
    await createTestUser('boss-import-guards@test.local', 'admin111', 'admin')
    const product = await createTestProduct('导入守卫商品', 200, 0, [])
    const otherProduct = await createTestProduct('别家商品', 100, 0, [])
    const foreignOfferId = await getDefaultOfferId(otherProduct.id)
    const { accessToken } = await loginAs('boss-import-guards@test.local', 'admin111')

    // 人工服务规格不能收库存。
    const manualOffer = await prisma.offer.create({
      data: { productId: product.id, name: '服务规格', price: 500, deliveryMode: 'manual_service', stockMode: 'unlimited' },
    })
    const nonInstant = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['guard-1'], offerId: manualOffer.id })
      .expect(400)
    expect(nonInstant.body.error.message).toContain('仅即时库存发货规格')

    // 其他商品的规格 → 404。
    await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['guard-2'], offerId: foreignOfferId })
      .expect(404)

    // P4b：带交付字段模板的规格走结构化导入（Catalog-Ops spec §8.2：Merchant/Admin 共用分析器，
    // 结构化字段沿用现有限制）——admin 直接导入亦为合法路径。
    const templated = await prisma.offer.create({
      data: {
        productId: product.id,
        name: '模板规格',
        price: 300,
        deliveryFields: [
          { key: 'account', label: '账号', sensitive: false },
          { key: 'password', label: '密码', sensitive: true },
        ],
      },
    })
    const structuredImport = await api
      .post(`/api/admin/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['guard-3 | secret-3'], offerId: templated.id })
      .expect(200)
    const structuredItem = await prisma.inventoryItem.findFirst({
      where: { productId: product.id, offerId: templated.id },
      select: { id: true, structuredContent: true, content: true },
    })
    expect(structuredItem).not.toBeNull()
    expect(structuredItem!.structuredContent).toMatchObject({
      values: { account: 'guard-3', password: 'secret-3' },
    })
    expect(structuredItem!.content).toContain('账号: guard-3')

    // 全商品无即时库存规格 → 维持旧错误语义。
    const serviceProduct = await createTestProduct('纯服务商品', 100, 0, [])
    await makeManualService(serviceProduct.id)
    const noInstant = await api
      .post(`/api/admin/products/${serviceProduct.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['guard-4'] })
      .expect(400)
    expect(noInstant.body.error.message).toContain('仅即时库存发货商品')
  })
})

describe('GET /api/admin/orders', () => {
  it('should list all orders without raw delivery content', async () => {
    await createTestUser('boss6@test.local', 'admin222', 'admin')
    await createTestUser('admin-order-buyer@test.local', 'buyerpass', 'user', 5000)
    await createTestProduct('后台列表商品', 300, 1, ['admin-list-secret'])

    const buyer = await loginAs('admin-order-buyer@test.local', 'buyerpass')
    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: 1 })
      .expect(201)

    const { accessToken } = await loginAs('boss6@test.local', 'admin222')

    const res = await api
      .get('/api/admin/orders')
      .set(authHeader(accessToken))
      .expect(200)

    expect(Array.isArray(res.body.items)).toBe(true)
    expect(res.body.total).toBe(1)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].delivery.status).toBe('delivered')
    expect(res.body.items[0].delivery.content).toBeUndefined()
  })

  it('should validate fromDate and toDate calendar validity, leap years, and ordering', async () => {
    await createTestUser('order-val-admin@test.local', 'admin222', 'admin')
    const { accessToken } = await loginAs('order-val-admin@test.local', 'admin222')

    // 1. Invalid date format
    await api
      .get('/api/admin/orders?fromDate=invalid-date')
      .set(authHeader(accessToken))
      .expect(400)

    // 2. Invalid month
    const badMonth = await api
      .get('/api/admin/orders?fromDate=2026-13-01')
      .set(authHeader(accessToken))
      .expect(400)
    expect(JSON.stringify(badMonth.body)).toContain('必须是有效的公历日期')

    // 3. Non-existent day in month
    const badDay = await api
      .get('/api/admin/orders?fromDate=2026-02-31')
      .set(authHeader(accessToken))
      .expect(400)
    expect(JSON.stringify(badDay.body)).toContain('必须是有效的公历日期')

    // 4. Non-leap year Feb 29
    const nonLeap = await api
      .get('/api/admin/orders?fromDate=2026-02-29')
      .set(authHeader(accessToken))
      .expect(400)
    expect(JSON.stringify(nonLeap.body)).toContain('必须是有效的公历日期')

    // 5. Valid leap year Feb 29
    await api
      .get('/api/admin/orders?fromDate=2024-02-29&toDate=2024-02-29')
      .set(authHeader(accessToken))
      .expect(200)

    // 6. Inverted range
    const badRange = await api
      .get('/api/admin/orders?fromDate=2026-05-10&toDate=2026-05-01')
      .set(authHeader(accessToken))
      .expect(400)
    expect(JSON.stringify(badRange.body)).toContain('fromDate 不能晚于 toDate')
  })

  it('should reliably paginate orders with secondary id desc tiebreaker when createdAt is identical', async () => {
    await createTestUser('order-sort-admin@test.local', 'admin222', 'admin')
    await createTestUser('order-sort-buyer@test.local', 'buyerpass', 'user', 10000)
    await createTestProduct('稳定排序商品', 50, 10, ['s1', 's2', 's3', 's4', 's5'])

    const buyer = await loginAs('order-sort-buyer@test.local', 'buyerpass')
    const ids: number[] = []
    for (let i = 0; i < 4; i++) {
      const created = await api
        .post('/api/orders')
        .set(authHeader(buyer.accessToken))
        .send({ productId: 1 })
        .expect(201)
      ids.push(created.body.orderId)
    }

    const sameTime = new Date('2026-07-01T12:00:00.000Z')
    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: { createdAt: sameTime },
    })

    const { accessToken } = await loginAs('order-sort-admin@test.local', 'admin222')

    // Query page 1 (pageSize 2)
    const p1 = await api
      .get('/api/admin/orders?page=1&pageSize=2&fromDate=2026-07-01&toDate=2026-07-01')
      .set(authHeader(accessToken))
      .expect(200)

    // Query page 2 (pageSize 2)
    const p2 = await api
      .get('/api/admin/orders?page=2&pageSize=2&fromDate=2026-07-01&toDate=2026-07-01')
      .set(authHeader(accessToken))
      .expect(200)

    const page1Ids = p1.body.items.map((o: any) => o.id)
    const page2Ids = p2.body.items.map((o: any) => o.id)

    expect(page1Ids).toHaveLength(2)
    expect(page2Ids).toHaveLength(2)

    // No duplicates between page 1 and page 2
    const intersection = page1Ids.filter((id: number) => page2Ids.includes(id))
    expect(intersection).toHaveLength(0)

    // Combined set contains all 4 IDs in strict id desc order
    const combined = [...page1Ids, ...page2Ids]
    const sortedIdsDesc = [...ids].sort((a, b) => b - a)
    expect(combined).toEqual(sortedIdsDesc)
  })

  it('should filter orders by exact UTC boundaries: inclusive fromDate and exclusive toDate next day midnight', async () => {
    await createTestUser('order-utc-admin@test.local', 'admin222', 'admin')
    await createTestUser('order-utc-buyer@test.local', 'buyerpass', 'user', 10000)
    await createTestProduct('UTC边界商品', 100, 5, ['utc-1', 'utc-2', 'utc-3', 'utc-4', 'utc-5'])

    const buyer = await loginAs('order-utc-buyer@test.local', 'buyerpass')
    const ord1 = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: 1 })
      .expect(201)
    const ord2 = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: 1 })
      .expect(201)
    const ord3 = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: 1 })
      .expect(201)

    await prisma.order.update({
      where: { id: ord1.body.orderId },
      data: { createdAt: new Date('2026-04-01T23:59:59.000Z') },
    })
    await prisma.order.update({
      where: { id: ord2.body.orderId },
      data: { createdAt: new Date('2026-04-02T00:00:00.000Z') },
    })
    await prisma.order.update({
      where: { id: ord3.body.orderId },
      data: { createdAt: new Date('2026-04-03T00:00:00.000Z') },
    })

    const { accessToken } = await loginAs('order-utc-admin@test.local', 'admin222')

    const res = await api
      .get('/api/admin/orders?fromDate=2026-04-02&toDate=2026-04-02')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.items.some((o: any) => o.id === ord2.body.orderId)).toBe(true)
    expect(res.body.items.some((o: any) => o.id === ord1.body.orderId)).toBe(false)
    expect(res.body.items.some((o: any) => o.id === ord3.body.orderId)).toBe(false)
  })
})

describe('GET /api/admin/orders/:id', () => {
  it('should reject non-admin access to order detail', async () => {
    await createTestUser('order-nonadmin-user@test.local', 'user123', 'user')
    const { accessToken } = await loginAs('order-nonadmin-user@test.local', 'user123')
    await api.get('/api/admin/orders/1').set(authHeader(accessToken)).expect(403)
  })

  it('should return any order detail for admin', async () => {
    await createTestUser('boss7@test.local', 'admin333', 'admin')
    await createTestUser('buyer@test.local', 'buyerpass', 'user', 5000)
    await createTestProduct('管理查看商品', 300, 3, ['mgmt-1', 'mgmt-2', 'mgmt-3'])

    const buyer = await loginAs('buyer@test.local', 'buyerpass')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: 1 })
      .expect(201)

    const admin = await loginAs('boss7@test.local', 'admin333')
    const res = await api
      .get(`/api/admin/orders/${created.body.orderId}`)
      .set(authHeader(admin.accessToken))
      .expect(200)

    expect(res.body.user.email).toBe('buyer@test.local')
    expect(res.body.product.name).toBe('管理查看商品')
    expect(res.body.delivery.status).toBe('delivered')
    expect(res.body.delivery.content).toBe('mgmt-1')
  })
})

describe('GET /api/admin/settlements', () => {
  it('should filter settlements by holding and voided status', async () => {
    await createTestUser('settle-list-admin@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-list-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '结算列表商家',
    })
    await createTestUser('settle-list-buyer@test.local', 'buyerpass', 'user', 5000)
    const product = await createTestProduct('结算列表人工服务', 100, 0, [], merchant.id)
    await makeManualService(product.id)
    const buyer = await loginAs('settle-list-buyer@test.local', 'buyerpass')
    const merchantLogin = await loginAs('settle-list-merchant@test.local', 'merchant123')
    const admin = await loginAs('settle-list-admin@test.local', 'admin123')

    const createRes = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = createRes.body.orderId as number

    const holdingList = await api
      .get('/api/admin/settlements')
      .query({ status: 'holding' })
      .set(authHeader(admin.accessToken))
      .expect(200)
    expect(holdingList.body.items.some((s: { orderId: number }) => s.orderId === orderId)).toBe(true)
    expect(holdingList.body.total).toBeGreaterThanOrEqual(1)
    expect(holdingList.body.page).toBe(1)
    expect(holdingList.body.pageSize).toBe(20)

    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/reject`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ publicNote: '库存不足拒单' })
      .expect(200)

    const voidedList = await api
      .get('/api/admin/settlements')
      .query({ status: 'voided' })
      .set(authHeader(admin.accessToken))
      .expect(200)
    expect(voidedList.body.items.some((s: { orderId: number; status: string }) => s.orderId === orderId && s.status === 'voided')).toBe(true)
    expect(voidedList.body.total).toBeGreaterThanOrEqual(1)
  })

  it('should return required payable and blockReason fields reflecting order eligibility', async () => {
    await createTestUser('settle-elig-admin@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-elig-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '资格测试商家',
    })
    await createTestUser('settle-elig-buyer@test.local', 'buyerpass', 'user', 5000)
    const product = await createTestProduct('资格即时商品', 100, 1, ['elig-card-1'], merchant.id)
    const buyer = await loginAs('settle-elig-buyer@test.local', 'buyerpass')
    const admin = await loginAs('settle-elig-admin@test.local', 'admin123')

    const createRes = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = createRes.body.orderId as number

    const listRes = await api
      .get('/api/admin/settlements')
      .query({ status: 'pending' })
      .set(authHeader(admin.accessToken))
      .expect(200)

    const item = listRes.body.items.find((s: { orderId: number }) => s.orderId === orderId)
    expect(item).toBeDefined()
    expect(item.payable).toBe(true)
    expect(item.blockReason).toBeNull()

    await api
      .post(`/api/orders/${orderId}/dispute`)
      .set(authHeader(buyer.accessToken))
      .send({ note: '商品问题申请争议' })
      .expect(200)

    const disputedListRes = await api
      .get('/api/admin/settlements')
      .query({ status: 'pending' })
      .set(authHeader(admin.accessToken))
      .expect(200)

    const disputedItem = disputedListRes.body.items.find((s: { orderId: number }) => s.orderId === orderId)
    expect(disputedItem).toBeDefined()
    expect(disputedItem.payable).toBe(false)
    expect(disputedItem.blockReason).toBe('订单争议中，暂不可结算')
  })
})

describe('POST /api/admin/settlements/batch-settle', () => {
  it('should settle pending records in a batch', async () => {
    await createTestUser('settle-admin-ok@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-merchant-ok@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '成功结算商家',
    })
    await createTestUser('settle-buyer-ok@test.local', 'buyerpass', 'user', 5000)
    const product = await createTestProduct('成功结算商品', 200, 2, ['settle-ok-1', 'settle-ok-2'], merchant.id)
    const buyer = await loginAs('settle-buyer-ok@test.local', 'buyerpass')

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const settlements = await prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      orderBy: { id: 'asc' },
    })
    const admin = await loginAs('settle-admin-ok@test.local', 'admin123')

    const res = await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: settlements.map(settlement => settlement.id) })
      .expect(200)

    expect(res.body.settled).toBe(2)
    // 佣金默认 10%：200 * 0.9 = 180，两笔合计 360
    expect(res.body.creditedTotal).toBe(360)

    const settled = await prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      orderBy: { id: 'asc' },
    })
    expect(settled.every(settlement => settlement.status === 'settled')).toBe(true)
    expect(settled.every(settlement => settlement.settledAt !== null)).toBe(true)

    // Merchant owner must receive settlementAmount into PointAccount.
    const merchantAccount = await prisma.pointAccount.findUniqueOrThrow({
      where: { userId: merchant.userId },
    })
    expect(merchantAccount.balance).toBeGreaterThanOrEqual(360)
    const creditLogs = await prisma.pointLog.findMany({
      where: {
        userId: merchant.userId,
        type: 'in',
        reason: { startsWith: '商家结算入账:' },
      },
    })
    expect(creditLogs).toHaveLength(2)
    expect(creditLogs.reduce((s, l) => s + l.amount, 0)).toBe(360)
  })

  it('should reject mixed settlement statuses without partially settling pending records', async () => {
    await createTestUser('settle-admin@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '结算商家',
    })
    await createTestUser('settle-buyer@test.local', 'buyerpass', 'user', 5000)
    const product = await createTestProduct('结算商品', 200, 2, ['settle-1', 'settle-2'], merchant.id)
    const buyer = await loginAs('settle-buyer@test.local', 'buyerpass')

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const settlements = await prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      orderBy: { id: 'asc' },
    })
    await prisma.settlement.update({
      where: { id: settlements[1].id },
      data: { status: 'settled', settledAt: new Date() },
    })

    const admin = await loginAs('settle-admin@test.local', 'admin123')

    await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: settlements.map(settlement => settlement.id) })
      .expect(400)

    const unchanged = await prisma.settlement.findUniqueOrThrow({ where: { id: settlements[0].id } })
    expect(unchanged.status).toBe('pending')
    expect(unchanged.settledAt).toBeNull()
  })

  it('should reject pending settlements whose orders are not payable', async () => {
    await createTestUser('settle-admin-gate@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-merchant-gate@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '结算门禁商家',
    })
    await createTestUser('settle-buyer-gate@test.local', 'buyerpass', 'user', 5000)
    const product = await createTestProduct('待履约结算商品', 200, 0, [], merchant.id)
    await makeManualService(product.id)
    const buyer = await loginAs('settle-buyer-gate@test.local', 'buyerpass')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const settlement = await prisma.settlement.findUniqueOrThrow({
      where: { orderId: created.body.orderId },
    })
    const admin = await loginAs('settle-admin-gate@test.local', 'admin123')

    await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: [settlement.id] })
      .expect(400)

    const unchanged = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })
    expect(unchanged.status).toBe('holding')
    expect(unchanged.settledAt).toBeNull()
  })

  it('should reject duplicate settlement IDs with 400', async () => {
    await createTestUser('settle-dup-admin@test.local', 'admin123', 'admin')
    const admin = await loginAs('settle-dup-admin@test.local', 'admin123')

    const res = await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: [1, 1] })
      .expect(400)

    expect(res.body.error.message).toBe('存在重复的结算ID')
  })

  it('should reject batch and not credit any points if one settlement has a disputed order', async () => {
    const { user: adminUser } = await createTestUser('settle-atomic-admin@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-atomic-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '原子性测试商家',
    })
    await createTestUser('settle-atomic-buyer@test.local', 'buyerpass', 'user', 10000)
    const product = await createTestProduct('原子性商品', 100, 2, ['atom-card-1', 'atom-card-2'], merchant.id)
    const buyer = await loginAs('settle-atomic-buyer@test.local', 'buyerpass')
    const admin = await loginAs('settle-atomic-admin@test.local', 'admin123')

    // Order 1: delivered (eligible)
    const o1 = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
    // Order 2: delivered -> disputed (ineligible)
    const o2 = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
    await api.post(`/api/orders/${o2.body.orderId}/dispute`).set(authHeader(buyer.accessToken)).send({ note: '争议' }).expect(200)

    const s1 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: o1.body.orderId } })
    const s2 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: o2.body.orderId } })

    const initialMerchantAccount = await prisma.pointAccount.findUnique({ where: { userId: merchant.userId } })
    const initialBalance = initialMerchantAccount?.balance ?? 0

    // Try to batch settle [s1.id, s2.id]
    await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: [s1.id, s2.id] })
      .expect(400)

    // Verify neither was settled!
    const s1After = await prisma.settlement.findUniqueOrThrow({ where: { id: s1.id } })
    const s2After = await prisma.settlement.findUniqueOrThrow({ where: { id: s2.id } })
    expect(s1After.status).toBe('pending')
    expect(s1After.settledAt).toBeNull()
    expect(s2After.status).toBe('pending')
    expect(s2After.settledAt).toBeNull()

    // Verify merchant balance was untouched!
    const finalMerchantAccount = await prisma.pointAccount.findUnique({ where: { userId: merchant.userId } })
    expect(finalMerchantAccount?.balance ?? 0).toBe(initialBalance)

    // Verify no PointLog or AdminLog created
    const pointLogs = await prisma.pointLog.findMany({
      where: { userId: merchant.userId, orderId: { in: [o1.body.orderId, o2.body.orderId] } },
    })
    expect(pointLogs).toHaveLength(0)

    const adminLogs = await prisma.adminLog.findMany({
      where: { adminUserId: adminUser.id, action: '批量结算' },
    })
    expect(adminLogs).toHaveLength(0)
  })

  it('should allow only one request to settle the same settlement concurrently, with single credit and single log', async () => {
    const { user: adminUser } = await createTestUser('settle-race-admin@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-race-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '并发结算同一单商家',
    })
    await createTestUser('settle-race-buyer@test.local', 'buyerpass', 'user', 5000)
    const product = await createTestProduct('并发同一单商品', 200, 1, ['c-same-1'], merchant.id)
    const buyer = await loginAs('settle-race-buyer@test.local', 'buyerpass')
    const admin = await loginAs('settle-race-admin@test.local', 'admin123')

    const createRes = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const settlement = await prisma.settlement.findUniqueOrThrow({
      where: { orderId: createRes.body.orderId },
    })

    const initialMerchantAccount = await prisma.pointAccount.findUnique({ where: { userId: merchant.userId } })
    const initialBalance = initialMerchantAccount?.balance ?? 0

    // Fire two concurrent batch-settle requests targeting the exact same settlement
    const [resA, resB] = await Promise.all([
      api
        .post('/api/admin/settlements/batch-settle')
        .set(authHeader(admin.accessToken))
        .send({ settlementIds: [settlement.id] }),
      api
        .post('/api/admin/settlements/batch-settle')
        .set(authHeader(admin.accessToken))
        .send({ settlementIds: [settlement.id] }),
    ])

    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([200, 400])

    const successRes = resA.status === 200 ? resA : resB
    const failRes = resA.status === 400 ? resA : resB

    expect(successRes.body.settled).toBe(1)
    expect(failRes.body.error.message).toBe('存在不可结算的记录')

    // Settlement state check
    const settlementFinal = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })
    expect(settlementFinal.status).toBe('settled')
    expect(settlementFinal.settledAt).not.toBeNull()

    // Exactly one PointLog and one AdminLog
    const pointLogs = await prisma.pointLog.findMany({
      where: { userId: merchant.userId, orderId: createRes.body.orderId },
    })
    expect(pointLogs).toHaveLength(1)

    const adminLogs = await prisma.adminLog.findMany({
      where: {
        adminUserId: adminUser.id,
        action: '批量结算',
        detail: { contains: '结算 1 笔' },
      },
    })
    expect(adminLogs).toHaveLength(1)

    // Merchant balance credited only once
    const finalMerchantAccount = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: merchant.userId } })
    expect(finalMerchantAccount.balance).toBe(initialBalance + settlement.settlementAmount)
  })

  it('should not deadlock or return 500 when two requests settle the same batch in opposite ID order', async () => {
    await createTestUser('settle-rev-admin@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-rev-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '逆序并发商家',
    })
    await createTestUser('settle-rev-buyer@test.local', 'buyerpass', 'user', 10000)
    const product = await createTestProduct('逆序并发商品', 100, 2, ['rev-1', 'rev-2'], merchant.id)
    const buyer = await loginAs('settle-rev-buyer@test.local', 'buyerpass')
    const admin = await loginAs('settle-rev-admin@test.local', 'admin123')

    const o1 = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
    const o2 = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)

    const s1 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: o1.body.orderId } })
    const s2 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: o2.body.orderId } })

    const [smallerId, largerId] = [s1.id, s2.id].sort((a, b) => a - b)

    // Request A: [smallerId, largerId]
    // Request B: [largerId, smallerId]
    const [resA, resB] = await Promise.all([
      api
        .post('/api/admin/settlements/batch-settle')
        .set(authHeader(admin.accessToken))
        .send({ settlementIds: [smallerId, largerId] }),
      api
        .post('/api/admin/settlements/batch-settle')
        .set(authHeader(admin.accessToken))
        .send({ settlementIds: [largerId, smallerId] }),
    ])

    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([200, 400])

    const s1Final = await prisma.settlement.findUniqueOrThrow({ where: { id: smallerId } })
    const s2Final = await prisma.settlement.findUniqueOrThrow({ where: { id: largerId } })
    expect(s1Final.status).toBe('settled')
    expect(s2Final.status).toBe('settled')
  })

  it('should successfully settle two non-overlapping batches for the same merchant concurrently without deadlock', async () => {
    await createTestUser('settle-nonoverlap-admin@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-nonoverlap-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '同商户不重叠并发商家',
    })
    await createTestUser('settle-nonoverlap-buyer@test.local', 'buyerpass', 'user', 20000)
    const product = await createTestProduct('同商户不重叠商品', 100, 4, ['no-1', 'no-2', 'no-3', 'no-4'], merchant.id)
    const buyer = await loginAs('settle-nonoverlap-buyer@test.local', 'buyerpass')
    const admin = await loginAs('settle-nonoverlap-admin@test.local', 'admin123')

    const o1 = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
    const o2 = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
    const o3 = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
    const o4 = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)

    const s1 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: o1.body.orderId } })
    const s2 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: o2.body.orderId } })
    const s3 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: o3.body.orderId } })
    const s4 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: o4.body.orderId } })

    const initialMerchantAccount = await prisma.pointAccount.findUnique({ where: { userId: merchant.userId } })
    const initialBalance = initialMerchantAccount?.balance ?? 0

    // Batch 1: [s1, s2]
    // Batch 2: [s3, s4]
    const [res1, res2] = await Promise.all([
      api
        .post('/api/admin/settlements/batch-settle')
        .set(authHeader(admin.accessToken))
        .send({ settlementIds: [s1.id, s2.id] }),
      api
        .post('/api/admin/settlements/batch-settle')
        .set(authHeader(admin.accessToken))
        .send({ settlementIds: [s3.id, s4.id] }),
    ])

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(res1.body.settled).toBe(2)
    expect(res2.body.settled).toBe(2)

    const expectedAdded =
      s1.settlementAmount + s2.settlementAmount + s3.settlementAmount + s4.settlementAmount

    const finalMerchantAccount = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: merchant.userId } })
    expect(finalMerchantAccount.balance).toBe(initialBalance + expectedAdded)

    const pointLogs = await prisma.pointLog.findMany({
      where: {
        userId: merchant.userId,
        orderId: { in: [o1.body.orderId, o2.body.orderId, o3.body.orderId, o4.body.orderId] },
      },
    })
    expect(pointLogs).toHaveLength(4)
  })
})

describe('Refresh token revocation on merchant lifecycle', () => {
  it('should revoke refresh tokens after approving merchant application', async () => {
    await createTestUser('approve-admin@test.local', 'admin123', 'admin')
    const { user, merchant } = await createTestMerchant('approve-applicant@test.local', 'pass123', {
      role: 'user',
      status: 'pending',
      name: '待审批商家',
    })

    const applicantLogin = await loginAs('approve-applicant@test.local', 'pass123')
    const admin = await loginAs('approve-admin@test.local', 'admin123')

    await api
      .put(`/api/admin/merchants/${merchant.id}/approve`)
      .set(authHeader(admin.accessToken))
      .expect(200)

    const refreshRes = await api
      .post('/api/auth/refresh')
      .set('Cookie', applicantLogin.cookies)
      .expect(401)

    expect(refreshRes.body.error.code).toBe('UNAUTHENTICATED')

    const tokens = await prisma.refreshToken.findMany({ where: { userId: user.id } })
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every(t => t.revoked)).toBe(true)
  })

  it('should revoke refresh tokens after suspending an active merchant', async () => {
    await createTestUser('suspend-admin@test.local', 'admin123', 'admin')
    const { user, merchant } = await createTestMerchant('suspend-target@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '即将停用商家',
    })

    const merchantLogin = await loginAs('suspend-target@test.local', 'pass123')
    const admin = await loginAs('suspend-admin@test.local', 'admin123')

    await api
      .put(`/api/admin/merchants/${merchant.id}/suspend`)
      .set(authHeader(admin.accessToken))
      .expect(200)

    const refreshRes = await api
      .post('/api/auth/refresh')
      .set('Cookie', merchantLogin.cookies)
      .expect(401)

    expect(refreshRes.body.error.code).toBe('UNAUTHENTICATED')

    const tokens = await prisma.refreshToken.findMany({ where: { userId: user.id } })
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every(t => t.revoked)).toBe(true)
  })
})

describe('Admin reject merchant with mandatory reason and AdminLog audit', () => {
  it('should validate reject reason is mandatory, non-empty, and within length limits', async () => {
    await createTestUser('reject-admin1@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('reject-target1@test.local', 'pass123', {
      role: 'user',
      status: 'pending',
      name: '测试待审核商家1',
    })
    const admin = await loginAs('reject-admin1@test.local', 'admin123')

    // 1. Missing reason
    await api
      .put(`/api/admin/merchants/${merchant.id}/reject`)
      .set(authHeader(admin.accessToken))
      .send({})
      .expect(400)

    // 2. Whitespace-only reason
    await api
      .put(`/api/admin/merchants/${merchant.id}/reject`)
      .set(authHeader(admin.accessToken))
      .send({ reason: '   ' })
      .expect(400)

    // 3. Too short reason (< 2 chars)
    await api
      .put(`/api/admin/merchants/${merchant.id}/reject`)
      .set(authHeader(admin.accessToken))
      .send({ reason: 'a' })
      .expect(400)

    // 4. Too long reason (> 500 chars)
    await api
      .put(`/api/admin/merchants/${merchant.id}/reject`)
      .set(authHeader(admin.accessToken))
      .send({ reason: 'a'.repeat(501) })
      .expect(400)

    // Status remains pending
    const unchanged = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })
    expect(unchanged.status).toBe('pending')
  })

  it('should reject pending merchant, update status, and write reason into AdminLog in the same transaction', async () => {
    const { user: adminUser } = await createTestUser('reject-admin2@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('reject-target2@test.local', 'pass123', {
      role: 'user',
      status: 'pending',
      name: '测试待审核商家2',
    })
    const admin = await loginAs('reject-admin2@test.local', 'admin123')

    const res = await api
      .put(`/api/admin/merchants/${merchant.id}/reject`)
      .set(authHeader(admin.accessToken))
      .send({ reason: ' 经营资质不全，缺乏营业执照 ' })
      .expect(200)

    expect(res.body.status).toBe('rejected')

    // Verify DB state
    const updated = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })
    expect(updated.status).toBe('rejected')

    // Verify AdminLog record exists and includes trimmed reason
    const log = await prisma.adminLog.findFirst({
      where: {
        adminUserId: adminUser.id,
        targetType: 'merchant',
        targetId: merchant.id,
        action: '拒绝商家入驻',
      },
    })
    expect(log).not.toBeNull()
    expect(log?.detail).toBe('拒绝原因: 经营资质不全，缺乏营业执照')
  })
})
