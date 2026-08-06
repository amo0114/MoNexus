import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { prisma } from '../lib/prisma.js'
import { api, createTestMerchant, createTestUser, loginAs, authHeader } from './helpers.js'
import { __setDeliveryStorageForTesting, getDeliveryStorage } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../lib/storage/deliveryMemory.js'
import { TMP_KEY_PREFIX } from '../lib/storage/deliveryTypes.js'
import {
  cleanupOrphanFiles,
  cleanupRefundedFiles,
  cleanupStaleTmpObjects,
  cleanupUnreferencedObjects,
} from '../lib/fileCleanup.js'

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

describe('cleanupUnreferencedObjects', () => {
  // 评审 P0 兜底：上传"晋升成功但建行失败"留下的无行对象由本 GC 清理，
  // 请求失败路径绝不即时删（失败默认保留）。
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes stale row-less final objects, sparing referenced and fresh ones', async () => {
    const merchant = await makeMerchant('gc-unref@test.local')
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage

    // 无行对象（建行失败场景）与有行对象各一。
    const orphanKey = `${'9'.repeat(64)}.bin`
    await storage.putObjectAt(orphanKey, Buffer.from('row-less'))
    const referenced = await seedFile(merchant.id, '8', new Date())

    // 未过宽限期：一律不动。
    expect(await cleanupUnreferencedObjects()).toBe(0)
    expect(storage.getBlob(orphanKey)).not.toBeNull()

    // 拨到 25 小时后：无行对象删除，有行对象保留。
    const later = new Date(Date.now() + 25 * HOUR)
    expect(await cleanupUnreferencedObjects(later)).toBe(1)
    expect(storage.getBlob(orphanKey)).toBeNull()
    expect(storage.getBlob(referenced.key)).not.toBeNull()
  })

  it('keeps every object when the reference query fails (never delete on DB errors)', async () => {
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    const orphanKey = `${'7'.repeat(64)}.bin`
    await storage.putObjectAt(orphanKey, Buffer.from('row-less'))

    // Multi-provider scan may call findMany more than once; all must fail-closed.
    const spy = vi.spyOn(prisma.deliveryFile, 'findMany').mockRejectedValue(new Error('db unreachable'))
    expect(await cleanupUnreferencedObjects(new Date(Date.now() + 25 * HOUR))).toBe(0)
    expect(storage.getBlob(orphanKey)).not.toBeNull()
    spy.mockRestore()

    // DB 恢复后下一轮照常清理。
    expect(await cleanupUnreferencedObjects(new Date(Date.now() + 25 * HOUR))).toBe(1)
    expect(storage.getBlob(orphanKey)).toBeNull()
  })

  it('blocks behind an in-flight same-content re-upload and spares the object (P0 race)', async () => {
    // 评审 P0 竞态：超期无行对象 K 被 GC 列为候选的同时，商家重新上传同
    // 内容——promote 去重命中仅删 tmp，行尚未建成。上传从 promote 前持有
    // K 的 advisory lock 到建行完成，GC 必须在锁后二次确认到新行而放弃删除。
    await makeMerchant('gc-race@test.local')
    const { accessToken } = await loginAs('gc-race@test.local', 'pass123')
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage

    const body = Buffer.from('re-upload race bytes')
    const finalKey = `${createHash('sha256').update(body).digest('hex')}.bin`
    // 预置：建行失败残留的无行对象（按超期宽限处理）。
    await storage.putObjectAt(finalKey, body)

    // 把重新上传暂停在 promote 之后、create 之前（锁已持有）。建行走锁
    // 事务的 tx 连接，全局 create 的 mock 拦不到——改在 promote 完成处设闸。
    const originalPromote = storage.promote.bind(storage)
    let reachCreate!: () => void
    const reachedCreate = new Promise<void>(resolve => { reachCreate = resolve })
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    vi.spyOn(storage, 'promote').mockImplementationOnce(async (tmpKey, target) => {
      await originalPromote(tmpKey, target)
      reachCreate()
      await createGate
    })

    const uploadPromise = api
      .post('/api/uploads/delivery-file')
      .set(authHeader(accessToken))
      .attach('file', body, { filename: 'race.bin' })
      .then(res => res)

    await reachedCreate
    const gcPromise = cleanupUnreferencedObjects(new Date(Date.now() + 25 * HOUR))
    // 给 GC 时间走到锁上排队；持锁窗口内对象必须原封不动。
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(storage.getBlob(finalKey)).not.toBeNull()

    releaseCreate()
    const [uploadRes, cleaned] = await Promise.all([uploadPromise, gcPromise])
    expect(uploadRes.status).toBe(201)
    expect(cleaned).toBe(0)
    expect(storage.getBlob(finalKey)?.equals(body)).toBe(true)
    const row = await prisma.deliveryFile.findUniqueOrThrow({ where: { id: uploadRes.body.id } })
    expect(row.key).toBe(finalKey)
    expect(row.status).toBe('active')
  })
})

describe('cleanupRefundedFiles', () => {
  async function seedOrderWithFile(
    merchantId: number,
    marker: string,
    orderStatus: string,
    options: { deliveredAgoMs: number; refundedAgoMs?: number; fileStatus?: string }
  ) {
    const file = await seedFile(merchantId, marker, new Date(Date.now() - 200 * DAY))
    if (options.fileStatus) {
      await prisma.deliveryFile.update({ where: { id: file.id }, data: { status: options.fileStatus } })
    }
    const buyer = await prisma.user.create({
      data: { email: `gc-refund-${marker}@test.local`, password: 'x' },
    })
    const product = await prisma.product.create({ data: { name: `退款清理${marker}`, type: '充值卡密', price: 100, merchantId } })
    const order = await prisma.order.create({
      data: { userId: buyer.id, productId: product.id, price: 100, status: orderStatus, merchantId },
    })
    await prisma.deliveryRecord.create({
      data: {
        orderId: order.id, userId: buyer.id, productId: product.id,
        contentType: 'file', fileId: file.id, status: 'delivered',
        deliveredAt: new Date(Date.now() - options.deliveredAgoMs),
      },
    })
    // 保留期锚点 = 退款事件时间（评审 P1）；status 直改而无事件 = 保守不清。
    if (options.refundedAgoMs != null) {
      await prisma.orderStatusEvent.create({
        data: {
          orderId: order.id, actorRole: 'admin', fromStatus: 'disputed', toStatus: 'refunded',
          action: 'admin.resolve.refund', createdAt: new Date(Date.now() - options.refundedAgoMs),
        },
      })
    }
    return file
  }

  it('anchors retention on the refund event: old-delivery-fresh-refund stays, 91-day refunds clean', async () => {
    const merchant = await makeMerchant('gc-refund@test.local')
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage

    // 91 天前退款 → 清理（交付更早无关紧要）。
    const oldRefund = await seedOrderWithFile(merchant.id, 'e', 'refunded', { deliveredAgoMs: 100 * DAY, refundedAgoMs: 91 * DAY })
    // 100 天前交付、今天刚退款 → 必须保留（评审 P1 的核心场景）。
    const freshRefund = await seedOrderWithFile(merchant.id, 'f', 'refunded', { deliveredAgoMs: 100 * DAY, refundedAgoMs: 1 * DAY })
    // 存活订单（delivered）→ 永不清理。
    const liveOrder = await seedOrderWithFile(merchant.id, '0', 'delivered', { deliveredAgoMs: 100 * DAY })
    // 退款但没有状态事件（绕过状态机直改）→ 保守不清理。
    const noEvent = await seedOrderWithFile(merchant.id, '2', 'refunded', { deliveredAgoMs: 100 * DAY })
    // revoked 文件同样走保留期后清理（评审 P1：吊销不能永久滞留）。
    const revokedOld = await seedOrderWithFile(merchant.id, '3', 'refunded', { deliveredAgoMs: 100 * DAY, refundedAgoMs: 95 * DAY, fileStatus: 'revoked' })

    const cleaned = await cleanupRefundedFiles()
    expect(cleaned).toBe(2)

    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: oldRefund.id } })).status).toBe('deleted')
    expect(storage.getBlob(oldRefund.key)).toBeNull()
    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: revokedOld.id } })).status).toBe('deleted')
    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: freshRefund.id } })).status).toBe('active')
    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: liveOrder.id } })).status).toBe('active')
    expect((await prisma.deliveryFile.findUniqueOrThrow({ where: { id: noEvent.id } })).status).toBe('active')
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
