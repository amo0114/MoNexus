import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { prisma } from '../lib/prisma.js'
import { api, createTestMerchant, createTestUser, loginAs } from './helpers.js'
import { getDeliveryStorage, __setDeliveryStorageForTesting } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage, signDeliveryToken, verifyDeliveryToken } from '../lib/storage/deliveryMemory.js'
import { FileTooLargeError, TMP_KEY_PREFIX, sanitizeFileName } from '../lib/storage/deliveryTypes.js'

/**
 * P5 T1：私有交付存储与流式上传。memory 适配器与 S3 版同契约：
 * 对象私有、下载必须经签名；签名篡改/过期与真实 SigV4 失败同语义。
 */

function freshStorage(): DeliveryMemoryStorage {
  const storage = new DeliveryMemoryStorage()
  __setDeliveryStorageForTesting(storage)
  return storage
}

beforeEach(() => {
  freshStorage()
})

describe('DeliveryMemoryStorage — adapter semantics', () => {
  it('streams with hashing, promotes tmp to content-addressed key, dedupes', async () => {
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    const body = Buffer.from('paid-file-content')

    const r1 = await storage.putStream(`${TMP_KEY_PREFIX}a`, Readable.from(body), 1024)
    expect(r1.size).toBe(body.length)
    expect(r1.sha256).toMatch(/^[0-9a-f]{64}$/)

    await storage.promote(`${TMP_KEY_PREFIX}a`, `${r1.sha256}.bin`)
    expect(storage.getBlob(`${TMP_KEY_PREFIX}a`)).toBeNull()
    expect(storage.getBlob(`${r1.sha256}.bin`)?.equals(body)).toBe(true)

    // 去重命中：同内容第二次晋升只清临时对象，最终对象保持原样。
    await storage.putStream(`${TMP_KEY_PREFIX}b`, Readable.from(body), 1024)
    await storage.promote(`${TMP_KEY_PREFIX}b`, `${r1.sha256}.bin`)
    expect(storage.getBlob(`${TMP_KEY_PREFIX}b`)).toBeNull()
    expect(storage.getBlob(`${r1.sha256}.bin`)?.equals(body)).toBe(true)
  })

  it('aborts the stream beyond maxBytes with FileTooLargeError', async () => {
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    await expect(
      storage.putStream(`${TMP_KEY_PREFIX}big`, Readable.from(Buffer.alloc(2048)), 1024)
    ).rejects.toBeInstanceOf(FileTooLargeError)
  })

  it('lists stale tmp keys for GC and deletes idempotently', async () => {
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    await storage.putStream(`${TMP_KEY_PREFIX}stale`, Readable.from(Buffer.from('x')), 1024)
    const future = new Date(Date.now() + 60_000)
    expect(await storage.listTmpKeysOlderThan(future)).toEqual([`${TMP_KEY_PREFIX}stale`])
    await storage.delete(`${TMP_KEY_PREFIX}stale`)
    await storage.delete(`${TMP_KEY_PREFIX}stale`) // 幂等
    expect(await storage.listTmpKeysOlderThan(future)).toEqual([])
  })
})

describe('delivery signed token — tamper & expiry semantics', () => {
  it('round-trips a valid token and rejects expired ones', () => {
    const token = signDeliveryToken('abc.bin', 'report.pdf', new Date(Date.now() + 60_000))
    expect(verifyDeliveryToken(token)?.key).toBe('abc.bin')

    const expired = signDeliveryToken('abc.bin', 'report.pdf', new Date(Date.now() - 1000))
    expect(verifyDeliveryToken(expired)).toBeNull()
  })

  it('rejects tampered payload or MAC', () => {
    const token = signDeliveryToken('abc.bin', 'report.pdf', new Date(Date.now() + 60_000))
    const [body, mac] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)]
    const forgedBody = Buffer.from(
      JSON.stringify({ key: 'other.bin', fileName: 'x', exp: Date.now() + 60_000 })
    ).toString('base64url')
    expect(verifyDeliveryToken(`${forgedBody}.${mac}`)).toBeNull()
    expect(verifyDeliveryToken(`${body}.${'A'.repeat(mac.length)}`)).toBeNull()
    expect(verifyDeliveryToken('garbage')).toBeNull()
  })

  it('sanitizes hostile file names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('....etcpasswd')
    expect(sanitizeFileName('a"b\';c\n.pdf')).toBe('abc.pdf')
    expect(sanitizeFileName('')).toBe('download')
    expect(sanitizeFileName('x'.repeat(500)).length).toBe(200)
  })
})

describe('POST /api/uploads/delivery-file', () => {
  it('merchant uploads a file, gets a fileId back, and the row never exposes the object key', async () => {
    await createTestMerchant('file-up@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const { accessToken } = await loginAs('file-up@test.local', 'pass123')

    const res = await api
      .post('/api/uploads/delivery-file')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('paid content v1'), { filename: '成品报告 v1.pdf', contentType: 'application/pdf' })
      .expect(201)

    expect(res.body.id).toBeGreaterThan(0)
    expect(res.body.fileName).toBe('成品报告 v1.pdf')
    expect(res.body.size).toBe(Buffer.byteLength('paid content v1'))
    expect(res.body.key).toBeUndefined()

    const row = await prisma.deliveryFile.findUniqueOrThrow({ where: { id: res.body.id } })
    expect(row.key).toBe(`${row.sha256}.pdf`)
    expect(row.status).toBe('active')

    // 对象已在私有存储的最终键上，临时键已清。
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    expect(storage.getBlob(row.key)?.toString()).toBe('paid content v1')
    expect(await storage.listTmpKeysOlderThan(new Date(Date.now() + 60_000))).toEqual([])
  })

  it('rejects non-merchant users, empty files, and missing files', async () => {
    await createTestUser('file-up-user@test.local', 'pass123', 'user')
    const user = await loginAs('file-up-user@test.local', 'pass123')
    await api
      .post('/api/uploads/delivery-file')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('file', Buffer.from('x'), { filename: 'a.bin' })
      .expect(403)

    await createTestMerchant('file-up-m2@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const merchant = await loginAs('file-up-m2@test.local', 'pass123')
    const empty = await api
      .post('/api/uploads/delivery-file')
      .set('Authorization', `Bearer ${merchant.accessToken}`)
      .attach('file', Buffer.alloc(0), { filename: 'empty.bin' })
      .expect(400)
    expect(empty.body.error.message).toContain('空文件')

    const missing = await api
      .post('/api/uploads/delivery-file')
      .set('Authorization', `Bearer ${merchant.accessToken}`)
      .field('nothing', 'here')
      .expect(400)
    expect(missing.body.error.code).toBe('NO_FILE')
  })

  it('serves the memory-signed download with forced attachment headers and 403s tampered/expired tokens', async () => {
    await createTestMerchant('file-dl@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const { accessToken } = await loginAs('file-dl@test.local', 'pass123')
    const uploaded = await api
      .post('/api/uploads/delivery-file')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('secret bytes'), { filename: 'secret.txt' })
      .expect(201)
    const row = await prisma.deliveryFile.findUniqueOrThrow({ where: { id: uploaded.body.id } })

    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    const { url } = await storage.presignDownload(row.key, row.fileName, 60)
    const download = await api.get(url).expect(200)
    expect(download.headers['content-type']).toContain('application/octet-stream')
    expect(download.headers['content-disposition']).toContain('attachment')
    expect(download.headers['cache-control']).toBe('no-store')
    expect(download.body.toString()).toBe('secret bytes')

    // 篡改与过期都必须 403（与真实 S3 签名失败同语义），未签名路径无从访问。
    await api.get(`${url}x`).expect(403)
    const expired = signDeliveryToken(row.key, row.fileName, new Date(Date.now() - 1000))
    await api.get(`/api/uploads/delivery-signed/${expired}`).expect(403)
  })
})

describe('create-failure keeps the final object (P0 regression)', () => {
  // 评审 P0：建行失败（多与 DB 故障相关）时绝不在请求路径删最终对象——
  // 误删会波及历史订单正引用的同 hash 文件。兜底由宽限期 GC 负责。
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const body = Buffer.from('shared paid bytes')

  function uploadAs(token: string) {
    return api
      .post('/api/uploads/delivery-file')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', body, { filename: 'shared.bin' })
  }

  it('keeps the object when DeliveryFile.create fails (simulated DB outage)', async () => {
    await createTestMerchant('p0-keep@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const { accessToken } = await loginAs('p0-keep@test.local', 'pass123')

    vi.spyOn(prisma.deliveryFile, 'create').mockRejectedValueOnce(new Error('db unreachable'))
    await uploadAs(accessToken).expect(500)

    // 失败默认保留：任何 DB 查询在此刻都不可信，对象必须原地不动。
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    const sha256 = (await import('node:crypto')).createHash('sha256').update(body).digest('hex')
    expect(storage.getBlob(`${sha256}.bin`)).not.toBeNull()
  })

  it('never deletes an object an existing row references when a later upload fails', async () => {
    await createTestMerchant('p0-sib-1@test.local', 'pass123', { role: 'merchant', status: 'active' })
    await createTestMerchant('p0-sib-2@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const first = await loginAs('p0-sib-1@test.local', 'pass123')
    const second = await loginAs('p0-sib-2@test.local', 'pass123')

    const ok = await uploadAs(first.accessToken).expect(201)

    // 第二个商家上传同内容，建行失败——既有行引用的对象必须存活。
    vi.spyOn(prisma.deliveryFile, 'create').mockRejectedValueOnce(new Error('db unreachable'))
    await uploadAs(second.accessToken).expect(500)

    const row = await prisma.deliveryFile.findUniqueOrThrow({ where: { id: ok.body.id } })
    expect(row.status).toBe('active')
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    expect(storage.getBlob(row.key)?.equals(body)).toBe(true)
  })

  it('concurrent same-content uploads: one fails, one succeeds, the object survives', async () => {
    await createTestMerchant('p0-race-1@test.local', 'pass123', { role: 'merchant', status: 'active' })
    await createTestMerchant('p0-race-2@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const a = await loginAs('p0-race-1@test.local', 'pass123')
    const b = await loginAs('p0-race-2@test.local', 'pass123')

    // 并发两路：其中一路建行被拒（哪一路先到不确定，与真实竞态一致）。
    vi.spyOn(prisma.deliveryFile, 'create').mockRejectedValueOnce(new Error('db unreachable'))
    const [r1, r2] = await Promise.all([uploadAs(a.accessToken), uploadAs(b.accessToken)])
    expect([r1.status, r2.status].sort()).toEqual([201, 500])

    // 成功那一路的行必须仍能取到对象。
    const winner = r1.status === 201 ? r1 : r2
    const row = await prisma.deliveryFile.findUniqueOrThrow({ where: { id: winner.body.id } })
    const storage = (await getDeliveryStorage()) as DeliveryMemoryStorage
    expect(storage.getBlob(row.key)?.equals(body)).toBe(true)
  })
})
