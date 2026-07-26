import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs } from './helpers.js'

/**
 * P5.5 T1：管理端文件治理端点。核心不变量：
 * 1. 响应永不出现对象 key/bucket（P5 约定管理端也不豁免，对账凭 sha256）
 * 2. 引用计数（在售规格 / 交付记录）反映吊销影响面
 * 3. deleted 文件的发放流水仍可审计（历史事实不随文件生命周期消失）
 */

async function loginAdmin(email = 'fg-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

let fileSeq = 0

async function seedFile(
  merchantId: number,
  overrides?: { fileName?: string; status?: string; createdAt?: Date; sha256?: string }
) {
  fileSeq += 1
  return prisma.deliveryFile.create({
    data: {
      key: `delivery/${merchantId}/test-object-${fileSeq}`,
      fileName: overrides?.fileName ?? `交付包-${fileSeq}.zip`,
      size: 1024,
      mimeType: 'application/zip',
      sha256: overrides?.sha256 ?? 'a'.repeat(64),
      merchantId,
      status: overrides?.status ?? 'active',
      createdAt: overrides?.createdAt ?? new Date(),
    },
  })
}

describe('GET /api/admin/delivery-files', () => {
  it('paginates newest-first and never leaks the object key', async () => {
    const { accessToken } = await loginAdmin()
    const { merchant } = await createTestMerchant('fg-m1@test.local', 'pass123', { role: 'merchant', status: 'active', name: '文件商家' })

    const old = await seedFile(merchant.id, { createdAt: new Date(Date.now() - 3000) })
    const mid = await seedFile(merchant.id, { createdAt: new Date(Date.now() - 2000) })
    const latest = await seedFile(merchant.id, { createdAt: new Date(Date.now() - 1000) })

    const page1 = await api
      .get('/api/admin/delivery-files')
      .query({ page: 1, pageSize: 2 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(page1.body.total).toBe(3)
    expect(page1.body.page).toBe(1)
    expect(page1.body.pageSize).toBe(2)
    expect(page1.body.items.map((f: any) => f.id)).toEqual([latest.id, mid.id])
    expect(page1.body.items[0]).toMatchObject({
      fileName: latest.fileName,
      size: 1024,
      sha256: 'a'.repeat(64),
      mimeType: 'application/zip',
      status: 'active',
      merchant: { id: merchant.id, name: '文件商家' },
      refCounts: { offers: 0, deliveryRecords: 0 },
    })

    const page2 = await api
      .get('/api/admin/delivery-files')
      .query({ page: 2, pageSize: 2 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(page2.body.items.map((f: any) => f.id)).toEqual([old.id])

    // P5 不变量：普通 API（含管理端）永不返回对象 key/bucket。
    expect(JSON.stringify(page1.body)).not.toContain('"key"')
    expect(JSON.stringify(page1.body)).not.toContain('delivery/')
  })

  it('filters by merchantId, status and case-insensitive fileName', async () => {
    const { accessToken } = await loginAdmin()
    const { merchant: m1 } = await createTestMerchant('fg-m2@test.local', 'pass123', { role: 'merchant', status: 'active', name: '商家甲' })
    const { merchant: m2 } = await createTestMerchant('fg-m3@test.local', 'pass123', { role: 'merchant', status: 'active', name: '商家乙' })

    const active1 = await seedFile(m1.id, { fileName: 'Alpha-Pack.zip' })
    const revoked1 = await seedFile(m1.id, { fileName: 'beta-pack.zip', status: 'revoked' })
    await seedFile(m2.id, { fileName: 'gamma.zip' })

    const byMerchant = await api
      .get('/api/admin/delivery-files')
      .query({ merchantId: m1.id })
      .set(authHeader(accessToken))
      .expect(200)
    expect(byMerchant.body.total).toBe(2)
    expect(byMerchant.body.items.every((f: any) => f.merchant.id === m1.id)).toBe(true)

    const byStatus = await api
      .get('/api/admin/delivery-files')
      .query({ merchantId: m1.id, status: 'revoked' })
      .set(authHeader(accessToken))
      .expect(200)
    expect(byStatus.body.total).toBe(1)
    expect(byStatus.body.items[0].id).toBe(revoked1.id)

    // 大小写不敏感的包含匹配。
    const byName = await api
      .get('/api/admin/delivery-files')
      .query({ fileName: 'ALPHA-pack' })
      .set(authHeader(accessToken))
      .expect(200)
    expect(byName.body.total).toBe(1)
    expect(byName.body.items[0].id).toBe(active1.id)
  })

  it('reports offer / delivery-record reference counts', async () => {
    const { accessToken } = await loginAdmin()
    const { user: merchantUser, merchant } = await createTestMerchant('fg-m4@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const product = await createTestProduct('引用计数商品', 100, 1, ['inv-1'], merchant.id)

    const referenced = await seedFile(merchant.id)
    const orphan = await seedFile(merchant.id)

    // 在售规格引用（CHECK：file 形态 = instant_fixed + fixedFileId + fixedContent 空）。
    await prisma.offer.create({
      data: {
        productId: product.id,
        name: '文件版',
        price: 120,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        stock: 0,
        fixedContentType: 'file',
        fixedFileId: referenced.id,
      },
    })
    // 交付记录引用（下单事务冻结的快照）。
    const order = await prisma.order.create({
      data: { userId: merchantUser.id, productId: product.id, price: 120, status: 'delivered', merchantId: merchant.id },
    })
    await prisma.deliveryRecord.create({
      data: { orderId: order.id, userId: merchantUser.id, productId: product.id, contentType: 'file', fileId: referenced.id },
    })

    const res = await api
      .get('/api/admin/delivery-files')
      .set(authHeader(accessToken))
      .expect(200)

    const referencedRow = res.body.items.find((f: any) => f.id === referenced.id)
    const orphanRow = res.body.items.find((f: any) => f.id === orphan.id)
    expect(referencedRow.refCounts).toEqual({ offers: 1, deliveryRecords: 1 })
    expect(orphanRow.refCounts).toEqual({ offers: 0, deliveryRecords: 0 })
  })

  it('rejects non-admin callers and oversized pageSize', async () => {
    const { user, password } = await createTestUser('fg-user@test.local', 'pass123', 'user')
    const { accessToken } = await loginAs(user.email, password)
    await api.get('/api/admin/delivery-files').set(authHeader(accessToken)).expect(403)

    const admin = await loginAdmin('fg-admin2@test.local')
    await api
      .get('/api/admin/delivery-files')
      .query({ pageSize: 101 })
      .set(authHeader(admin.accessToken))
      .expect(400)
  })
})

describe('GET /api/admin/delivery-files/:id/grants', () => {
  it('lists grant logs newest-first with pagination, including deleted files', async () => {
    const { accessToken } = await loginAdmin('fg-admin3@test.local')
    const { user: merchantUser, merchant } = await createTestMerchant('fg-m5@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const product = await createTestProduct('流水商品', 100, 1, ['inv-g'], merchant.id)
    // deleted 文件的历史流水仍可审计——生命周期状态不遮蔽既有事实。
    const file = await seedFile(merchant.id, { status: 'deleted' })
    const order = await prisma.order.create({
      data: { userId: merchantUser.id, productId: product.id, price: 100, status: 'delivered', merchantId: merchant.id },
    })

    const base = Date.now()
    const mkGrant = (outcome: string, role: string, offsetMs: number) =>
      prisma.fileGrantLog.create({
        data: {
          fileId: file.id,
          orderId: order.id,
          userId: merchantUser.id,
          role,
          outcome,
          ipHash: 'hash-abc',
          userAgent: 'vitest-agent',
          expiresAt: outcome === 'granted' ? new Date(base + 600_000) : null,
          createdAt: new Date(base - offsetMs),
        },
      })
    const oldest = await mkGrant('granted', 'buyer', 3000)
    const middle = await mkGrant('denied_window', 'buyer', 2000)
    const newest = await mkGrant('denied_revoked', 'merchant', 1000)

    const page1 = await api
      .get(`/api/admin/delivery-files/${file.id}/grants`)
      .query({ page: 1, pageSize: 2 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(page1.body.total).toBe(3)
    expect(page1.body.items.map((g: any) => g.id)).toEqual([newest.id, middle.id])
    expect(page1.body.items[1]).toMatchObject({
      orderId: order.id,
      userId: merchantUser.id,
      role: 'buyer',
      outcome: 'denied_window',
      ipHash: 'hash-abc',
      userAgent: 'vitest-agent',
      expiresAt: null,
    })

    const page2 = await api
      .get(`/api/admin/delivery-files/${file.id}/grants`)
      .query({ page: 2, pageSize: 2 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(page2.body.items.map((g: any) => g.id)).toEqual([oldest.id])
    expect(page2.body.items[0].expiresAt).not.toBeNull()
  })

  it('404s an unknown file id and 403s non-admin callers', async () => {
    const { accessToken } = await loginAdmin('fg-admin4@test.local')
    await api.get('/api/admin/delivery-files/999999/grants').set(authHeader(accessToken)).expect(404)

    const { user, password } = await createTestUser('fg-user2@test.local', 'pass123', 'user')
    const nonAdmin = await loginAs(user.email, password)
    await api.get('/api/admin/delivery-files/1/grants').set(authHeader(nonAdmin.accessToken)).expect(403)
  })
})
