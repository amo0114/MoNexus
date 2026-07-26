import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { prisma } from '../lib/prisma.js'
import { api, createTestMerchant, createTestUser, loginAs, authHeader } from './helpers.js'
import { __setDeliveryStorageForTesting, getDeliveryStorage } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../lib/storage/deliveryMemory.js'
import { TMP_KEY_PREFIX } from '../lib/storage/deliveryTypes.js'
import { cleanupOrphanFiles, cleanupRefundedFiles, cleanupStaleTmpObjects } from '../lib/fileCleanup.js'

/**
 * P5 T6：生命周期清理与吊销。硬规则回归：
 * - 行永不物理删除（只标记 deleted）；
 * - 对象删除按 key 引用计数（内容寻址键可能被多行共享）；
 * - 退款保留 90 天对固定文件与人工附件一视同仁；非退款订单引用的文件不清理。
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

beforeEach(() => {
  __setDeliveryStorageForTesting(new DeliveryMemoryStorage())
})

async function makeMerchant(email: string) {
  const { merchant } = await createTestMerchant(email, 'pass123', { role: 'merchant', status: 'active' })
  return merchant
}

async function seedFile(merchantId: number, marker: string, createdAt: Date) {
  const key = `${marker.repeat(64).slice(0, 64)}.bin`
  const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
  await storage.putObjectAt(key, Buffer.from(`content-${marker}`))
  return prisma.deliveryFile.create({
    data: {
      key,
      fileName: `${marker}.bin`,
      size: 10,
      mimeType: 'application/octet-stream',
      sha256: marker.repeat(64).slice(0, 64),
      merchantId,
      createdAt,
    },
  })
}

describe('cleanupOrphanFiles', () => {
  it('marks stale unattached files deleted and removes objects, sparing fresh and attached files', async () => {
    const merchant = await makeMerchant('gc-orphan@test.local')
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage

    const staleOrphan = await seedFile(merchant.id, 'a', new Date(Date.now() - 25 * HOUR))
    const freshOrphan = await seedFile(merchant.id, 'b', new Date(Date.now() - 1 * HOUR))
    const attached = await seedFile(merchant.id, 'c', new Date(Date.now() - 25 * HOUR))
    const product = await prisma.product.create({ data: { name: 'GC商品', type: '充值卡密', price: 100, merchantId: merchant.id } })
    await prisma.offer.create({
      data: {
        productId: product.id, name: '文件规格', isDefault: true, price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContentType: 'file', fixedFileId: attached.id,
      },
    })

    await cleanupOrphanFiles()

    const rows = await prisma.deliveryFile.findMany({
      where: { id: { in: [staleOrphan.id, freshOrphan.id, attached.id] } },
    })
    const byId = new Map(rows.map(r => [r.id, r]))
    // 行保留、状态标记；对象删除。
    expect(byId.get(staleOrphan.id)?.status).toBe('deleted')
    expect(byId.get(staleOrphan.id)?.deletedAt).not.toBeNull()
    expect(storage.getBlob(staleOrphan.key)).toBeNull()
    // 宽限期内与已挂接的不动。
    expect(byId.get(freshOrphan.id)?.status).toBe('active')
    expect(storage.getBlob(freshOrphan.key)).not.toBeNull()
    expect(byId.get(attached.id)?.status).toBe('active')
  })

  it('keeps the shared object alive while any sibling row still references the key', async () => {
    const m1 = await makeMerchant('gc-share-1@test.local')
    const m2 = await makeMerchant('gc-share-2@test.local')
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage

    // 内容寻址：两个商家上传同内容 → 同 key 两行。
    const staleOrphan = await seedFile(m1.id, 'd', new Date(Date.now() - 25 * HOUR))
    const sibling = await prisma.deliveryFile.create({
      data: {
        key: staleOrphan.key, fileName: 'dup.bin', size: 10,
        mimeType: 'application/octet-stream', sha256: staleOrphan.sha256, merchantId: m2.id,
      },
    })
    const product = await prisma.product.create({ data: { name: '共享键商品', type: '充值卡密', price: 100, merchantId: m2.id } })
    await prisma.offer.create({
      data: {
        productId: product.id, name: '文件规格', isDefault: true, price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContentType: 'file', fixedFileId: sibling.id,
      },
    })

    await cleanupOrphanFiles()

    // 孤儿行标记 deleted，但对象因兄弟行仍引用而保留。
    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: staleOrphan.id } })).status).toBe('deleted')
    expect(storage.getBlob(staleOrphan.key)).not.toBeNull()
  })
})

describe('cleanupStaleTmpObjects', () => {
  it('removes leftover tmp/ objects past the grace period', async () => {
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    await storage.putStream(`${TMP_KEY_PREFIX}leftover`, Readable.from(Buffer.from('x')), 1024)

    // 未过宽限期不删；把"现在"拨到 25 小时后模拟过期。
    expect(await cleanupStaleTmpObjects()).toBe(0)
    expect(await cleanupStaleTmpObjects(new Date(Date.now() + 25 * HOUR))).toBe(1)
    expect(storage.getBlob(`${TMP_KEY_PREFIX}leftover`)).toBeNull()
  })
})

describe('cleanupRefundedFiles', () => {
  async function seedOrderWithFile(merchantId: number, marker: string, orderStatus: string, deliveredAgoMs: number) {
    const file = await seedFile(merchantId, marker, new Date(Date.now() - 100 * DAY))
    const buyer = await prisma.user.create({
      data: { email: `gc-refund-${marker}@test.local`, password: 'x', inviteCode: `GCR-${marker}` },
    })
    const product = await prisma.product.create({ data: { name: `退款清理${marker}`, type: '充值卡密', price: 100, merchantId } })
    const order = await prisma.order.create({
      data: { userId: buyer.id, productId: product.id, price: 100, status: orderStatus, merchantId },
    })
    await prisma.deliveryRecord.create({
      data: {
        orderId: order.id, userId: buyer.id, productId: product.id,
        contentType: 'file', fileId: file.id, status: 'delivered',
        deliveredAt: new Date(Date.now() - deliveredAgoMs),
      },
    })
    return file
  }

  it('cleans files whose orders are all refunded past retention, keeps recent refunds and live orders', async () => {
    const merchant = await makeMerchant('gc-refund@test.local')
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage

    const oldRefund = await seedOrderWithFile(merchant.id, 'e', 'refunded', 91 * DAY)
    const recentRefund = await seedOrderWithFile(merchant.id, 'f', 'refunded', 10 * DAY)
    const liveOrder = await seedOrderWithFile(merchant.id, '0', 'delivered', 91 * DAY)

    const cleaned = await cleanupRefundedFiles()
    expect(cleaned).toBe(1)

    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: oldRefund.id } })).status).toBe('deleted')
    expect(storage.getBlob(oldRefund.key)).toBeNull()
    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: recentRefund.id } })).status).toBe('active')
    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: liveOrder.id } })).status).toBe('active')
  })
})

describe('POST /api/admin/delivery-files/:id/revoke', () => {
  it('revokes a file (idempotent), audits it, and refuses deleted files', async () => {
    const merchant = await makeMerchant('gc-revoke@test.local')
    const file = await seedFile(merchant.id, '1', new Date())
    await createTestUser('gc-revoke-admin@test.local', 'admin111', 'admin')
    const admin = await loginAs('gc-revoke-admin@test.local', 'admin111')

    await api
      .post(`/api/admin/delivery-files/${file.id}/revoke`)
      .set(authHeader(admin.accessToken))
      .send({ reason: '违规内容' })
      .expect(200)
    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe('revoked')
    expect(await prisma.adminLog.count({ where: { targetType: 'deliveryFile', targetId: file.id } })).toBe(1)

    // 幂等：重复吊销 200，不重复记审计。
    await api
      .post(`/api/admin/delivery-files/${file.id}/revoke`)
      .set(authHeader(admin.accessToken))
      .send({})
      .expect(200)
    expect(await prisma.adminLog.count({ where: { targetType: 'deliveryFile', targetId: file.id } })).toBe(1)

    await prisma.deliveryFile.update({ where: { id: file.id }, data: { status: 'deleted' } })
    await api
      .post(`/api/admin/delivery-files/${file.id}/revoke`)
      .set(authHeader(admin.accessToken))
      .send({})
      .expect(400)
  })
})
