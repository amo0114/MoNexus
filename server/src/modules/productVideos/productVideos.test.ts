import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, truncate } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { DeliveryMemoryStorage, verifyVideoToken, verifyDeliveryToken } from '../../lib/storage/deliveryMemory.js'
import { __setDeliveryStorageForTesting } from '../../lib/storage/delivery.js'
import { cleanupUnreferencedObjects } from '../../lib/fileCleanup.js'
import { videoKey } from '../../lib/storage/videoKeys.js'
import { reserveVideo, finishVideo, productVideoPlayback } from './service.js'
import { processVideo, validateVideoProbe } from './processing.js'
import { cleanupProductVideos } from '../../lib/productVideoCleanup.js'
import { productVideoTempRoot } from '../../lib/productVideoTemp.js'
import { exportVideoObjects, restoreVideoObjects, rebindRestoredVideos, validateVideoManifest } from './backup.js'

let root: string
let files: Awaited<ReturnType<typeof processVideo>>
let storage: DeliveryMemoryStorage
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'video-test-'))
  const source = path.join(root, 'source.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', source])
  files = await processVideo(source, root, AbortSignal.timeout(60_000))
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
beforeEach(() => { storage = new DeliveryMemoryStorage(); __setDeliveryStorageForTesting(storage) })
afterEach(() => { __setDeliveryStorageForTesting(null); delete process.env.PRODUCT_VIDEO_UPLOAD_ENABLED; delete process.env.PRODUCT_VIDEO_PLAYBACK_ENABLED })
async function asset(merchantId: number | null, userId: number) {
  const reservation = await reserveVideo(merchantId, userId)
  return finishVideo(reservation.asset, reservation.adapter, files, AbortSignal.timeout(10_000))
}
async function merchant() {
  const data = await createTestMerchant('video-merchant@test.local', 'pass123', { role: 'merchant', status: 'active' })
  await prisma.user.update({ where: { id: data.user.id }, data: { emailVerified: new Date() } })
  const { accessToken } = await loginAs(data.user.email, 'pass123')
  return { ...data, headers: authHeader(accessToken) }
}

describe('real bounded MP4 processing', () => {
  it('decodes/remuxes real MP4, generates JPEG, and moves moov ahead of mdat', async () => {
    expect(files.metadata).toEqual({ durationMs: 1000, width: 320, height: 240, hasAudio: false })
    const bytes = await readFile(files.video)
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'))
    expect((await readFile(files.poster)).subarray(0, 2)).toEqual(Buffer.from([255, 216]))
    const dir = await mkdtemp(path.join(root, 'bad-'))
    const fake = path.join(dir, 'fake.mp4'); await writeFile(fake, 'not a video')
    await expect(processVideo(fake, dir, AbortSignal.timeout(60_000))).rejects.toMatchObject({ status: 422 })
    await writeFile(fake, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n')
    await expect(processVideo(fake, dir, AbortSignal.timeout(60_000))).rejects.toMatchObject({ status: 422 })
  })
  it('rejects HDR/HEVC/excess tracks/oversized/duration/invalid rate/audio', () => {
    const good = { format: { format_name: 'mov,mp4,m4a', duration: '1' }, streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 240, avg_frame_rate: '25/1', sample_aspect_ratio: '1:1' }] }
    expect(validateVideoProbe(good).hasAudio).toBe(false)
    for (const mutation of [{ codec_name: 'hevc' }, { color_transfer: 'smpte2084' }, { width: 4096 }, { avg_frame_rate: '0/0' }, { sample_aspect_ratio: '2:1' }]) {
      expect(() => validateVideoProbe({ ...good, streams: [{ ...good.streams[0], ...mutation }] })).toThrow()
    }
    expect(() => validateVideoProbe({ ...good, format: { ...good.format, duration: '61' } })).toThrow()
    expect(() => validateVideoProbe({ ...good, streams: [...good.streams, { codec_type: 'subtitle' }] })).toThrow()
    expect(() => validateVideoProbe({ ...good, streams: [...good.streams, { codec_type: 'audio', codec_name: 'aac', profile: 'HE-AAC', channels: 2 }] })).toThrow()
  })
  it('preserves real quarter-turn rotation, portrait AAC audio and variable frame timing', async () => {
    const rotatedDir = await mkdtemp(path.join(root, 'rotated-'))
    const rotated = path.join(rotatedDir, 'input.mp4')
    // Newer FFmpeg versions expose rotation as an input display transform;
    // the legacy rotate metadata option does not reliably create that fixture.
    const displayRotation = execFileSync('ffmpeg', ['-hide_banner', '-h', 'full'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }).includes('-display_rotation')
    execFileSync('ffmpeg', ['-v', 'error', ...(displayRotation ? ['-display_rotation', '90'] : []), '-i', path.join(root, 'source.mp4'), '-c', 'copy', ...(!displayRotation ? ['-metadata:s:v:0', 'rotate=90'] : []), rotated])
    const inputProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', rotated], { encoding: 'utf8' }))
    expect(validateVideoProbe(inputProbe)).toMatchObject({ width: 240, height: 320 })
    const result = await processVideo(rotated, rotatedDir, AbortSignal.timeout(60_000))
    expect(result.metadata).toMatchObject({ width: 240, height: 320, hasAudio: false })
    const poster = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.poster], { encoding: 'utf8' }))
    expect(poster.streams[0].width).toBeLessThan(poster.streams[0].height)
    const portraitDir = await mkdtemp(path.join(root, 'portrait-'))
    const portrait = path.join(portraitDir, 'input.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=240x320:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', 'aac', '-ac', '2', portrait])
    expect((await processVideo(portrait, portraitDir, AbortSignal.timeout(60_000))).metadata).toMatchObject({ width: 240, height: 320, hasAudio: true })
    const variableDir = await mkdtemp(path.join(root, 'variable-'))
    const variable = path.join(variableDir, 'input.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(root, 'source.mp4'), '-vf', "select='if(lt(t,0.5),not(mod(n,2)),1)'", '-vsync', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', variable])
    const timestamps = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', variable], { encoding: 'utf8' })).frames.map((f: { best_effort_timestamp_time: string }) => Number(f.best_effort_timestamp_time)) as number[]
    expect(new Set(timestamps.slice(1).map((t, i) => Math.round((t - timestamps[i]) * 1000))).size).toBeGreaterThan(1)
    expect((await processVideo(variable, variableDir, AbortSignal.timeout(60_000))).metadata.hasAudio).toBe(false)
  })
})

describe('video routes, ownership and public approval', () => {
  it('uploads actual MP4 through multipart, exposes metadata only and preserves paid signature domain', async () => {
    const owner = await merchant()
    const upload = await api.post('/api/uploads/product-video').set(owner.headers).attach('file', path.join(root, 'source.mp4'))
    expect(upload.status, JSON.stringify(upload.body)).toBe(201)
    expect(Object.keys(upload.body).sort()).toEqual(['assetId', 'durationMs', 'hasAudio', 'height', 'status', 'width'])
    const preview = await api.get(`/api/merchant/product-videos/${upload.body.assetId}/preview`).set(owner.headers).expect(200)
    expect(preview.headers['cache-control']).toContain('no-store')
    const token = preview.body.playbackUrl.split('/').at(-1)
    expect(verifyVideoToken(token)?.key).toBe(videoKey(upload.body.assetId))
    expect(verifyDeliveryToken(token)).toBeNull()
    const range = await api.get(preview.body.playbackUrl).set('Range', 'bytes=0-15').expect(206)
    expect(range.headers['content-type']).toBe('video/mp4')
    expect(range.headers['content-range']).toMatch(/^bytes 0-15\//)
    expect(range.headers['content-disposition']).toBe('inline')
    await api.get(preview.body.playbackUrl).set('Range', 'bytes=999999999-').expect(416)
    await api.get(preview.body.playbackUrl + 'tampered').expect(403)
    const expired = await storage.presignInlineVideo(videoKey(upload.body.assetId), 'video/mp4', -1)
    await api.get(expired.url).expect(403)
  })
  it('rejects unverified/nonowners and malformed multipart and recovers the upload slot', async () => {
    await api.post('/api/uploads/product-video').attach('file', path.join(root, 'source.mp4')).expect(401)
    const owner = await merchant()
    await api.post('/api/uploads/product-video').set(owner.headers).attach('file', Buffer.from('fake'), 'fake.mp4').expect(422)
    await api.post('/api/uploads/product-video').set(owner.headers).field('merchantId', '123').attach('file', path.join(root, 'source.mp4')).expect(422)
    expect(await prisma.productVideoAsset.count({ where: { status: 'uploading' } })).toBe(0)
    const a = await asset(owner.merchant.id, owner.user.id)
    const { user } = await createTestMerchant('video-other@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const login = await loginAs(user.email, 'pass123')
    await api.get(`/api/merchant/product-videos/${a.id}/preview`).set(authHeader(login.accessToken)).expect(404)
    await api.post('/api/uploads/product-video?merchantId=123').set(owner.headers).attach('file', path.join(root, 'source.mp4')).expect(403)
  })
  it('binds video under edit CAS, invalidates approval, omits vs null, denies guests without metadata', async () => {
    const owner = await merchant()
    const a = await asset(owner.merchant.id, owner.user.id)
    const product = await createTestProduct('视频商品', 50, 1, ['code'], owner.merchant.id)
    await prisma.product.update({ where: { id: product.id }, data: { status: 'draft' } })
    const patch = (body: object) => api.patch(`/api/merchant/products/${product.id}/content`).set(owner.headers).send(body)
    const changed = await patch({ expectedContentVersion: 1, promoVideoAssetId: a.id }).expect(200)
    expect(changed.body.contentVersion).toBe(2)
    let state = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, include: { guestEligibility: true } })
    expect(state.publicContentRevision).toBe(2); expect(state.guestEligibility?.decision).toBe('pending')
    await patch({ expectedContentVersion: 1, promoVideoAssetId: null }).expect(409)
    await patch({ expectedContentVersion: 2, description: 'updated' }).expect(200)
    state = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, include: { guestEligibility: true } })
    expect(state.promoVideoAssetId).toBe(a.id)
    await prisma.product.update({ where: { id: product.id }, data: { status: 'active' } })
    const denied = await api.get(`/api/products/${product.id}/video-playback`).expect(403)
    expect(JSON.stringify(denied.body)).not.toContain(a.id)
    await api.get(`/api/products/${product.id}/video-playback`).set(owner.headers).expect(200)
    await prisma.productGuestEligibility.update({ where: { productId: product.id }, data: { decision: 'approved', reviewedRevision: state.publicContentRevision } })
    await api.get(`/api/products/${product.id}/video-playback?expectedVideoAssetId=${a.id}`).expect(200)
    await api.get(`/api/products/${product.id}/video-playback?expectedVideoAssetId=${randomUUID()}`).expect(409)
    await prisma.productCategory.update({ where: { id: product.categoryId }, data: { guestVisibility: 'members_only' } })
    await api.get(`/api/products/${product.id}/video-playback`).expect(403)
    await prisma.product.update({ where: { id: product.id }, data: { status: 'draft' } })
    await patch({ expectedContentVersion: 3, promoVideoAssetId: null }).expect(200)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).promoVideoAssetId).toBeNull()
  })
  it('returns the reviewed video snapshot to admins and rejects approval after video replacement', async () => {
    const owner = await merchant()
    const { user: admin } = await createTestUser('video-review-admin@test.local', 'pass123', 'admin')
    const adminHeaders = authHeader((await loginAs(admin.email, 'pass123')).accessToken)
    const a = await asset(owner.merchant.id, owner.user.id)
    const p = await createTestProduct('视频审核版本', 10, 1, ['code'], owner.merchant.id)
    await prisma.product.update({ where: { id: p.id }, data: { status: 'draft' } })
    const patch = (body: object) => api.patch(`/api/merchant/products/${p.id}/content`).set(owner.headers).send(body)
    await patch({ expectedContentVersion: 1, promoVideoAssetId: a.id }).expect(200)
    const url = `/api/admin/products/${p.id}/guest-eligibility`
    await api.get(url).expect(401)
    await api.get(url).set(owner.headers).expect(403)
    const reviewed = (await api.get(url).set(adminHeaders).expect(200)).body
    expect(reviewed.promoVideo).toEqual({ assetId: a.id, durationMs: a.durationMs, width: a.width, height: a.height, hasAudio: a.hasAudio })
    expect(reviewed.publicContentRevision).toBe(2)
    const b = await asset(owner.merchant.id, owner.user.id)
    await patch({ expectedContentVersion: 2, promoVideoAssetId: b.id }).expect(200)
    const stale = await api.post(url).set(adminHeaders).send({ action: 'approve', expectedPublicContentRevision: reviewed.publicContentRevision, expectedEligibilityVersion: reviewed.version }).expect(409)
    expect(stale.body.error.code).toBe('PRODUCT_CONTENT_CHANGED')
    const current = (await api.get(url).set(adminHeaders).expect(200)).body
    expect(current.publicContentRevision).toBe(3)
    expect(current.promoVideo.assetId).toBe(b.id)
    const approved = await api.post(url).set(adminHeaders).send({ action: 'approve', expectedPublicContentRevision: current.publicContentRevision, expectedEligibilityVersion: current.version }).expect(200)
    expect(approved.body.promoVideo).toEqual(current.promoVideo)
    await patch({ expectedContentVersion: 3, promoVideoAssetId: null }).expect(200)
    expect((await api.get(url).set(adminHeaders).expect(200)).body.promoVideo).toBeNull()
  })
  it('does not let a merchant bind a platform asset; one asset cannot bind two products', async () => {
    const owner = await merchant()
    const { user } = await createTestUser('video-admin@test.local', 'pass123', 'admin')
    const a = await asset(null, user.id)
    const p = await createTestProduct('归属商品', 10, 1, ['a'], owner.merchant.id)
    await prisma.product.update({ where: { id: p.id }, data: { status: 'draft' } })
    await api.patch(`/api/merchant/products/${p.id}/content`).set(owner.headers).send({ expectedContentVersion: 1, promoVideoAssetId: a.id }).expect(409)
    const owned = await asset(owner.merchant.id, owner.user.id)
    await prisma.product.update({ where: { id: p.id }, data: { promoVideoAssetId: owned.id } })
    const p2 = await createTestProduct('另一个商品', 10, 1, ['b'], owner.merchant.id)
    await prisma.product.update({ where: { id: p2.id }, data: { status: 'draft' } })
    await api.patch(`/api/merchant/products/${p2.id}/content`).set(owner.headers).send({ expectedContentVersion: 1, promoVideoAssetId: owned.id }).expect(409)
  })
  it('rejects oversized uploads, compensates storage failure and accepts the next attempt', async () => {
    const owner = await merchant()
    const oversized = path.join(root, 'oversized.mp4')
    await writeFile(oversized, ''); await truncate(oversized, 40 * 1024 * 1024 + 1)
    await api.post('/api/uploads/product-video').set(owner.headers).attach('file', oversized).expect(413)
    const fail = vi.spyOn(storage, 'putStream').mockRejectedValueOnce(new Error('storage outage'))
    await api.post('/api/uploads/product-video').set(owner.headers).attach('file', path.join(root, 'source.mp4')).expect(503)
    fail.mockRestore()
    expect(await prisma.productVideoAsset.count({ where: { status: 'uploading' } })).toBe(0)
    await api.post('/api/uploads/product-video').set(owner.headers).attach('file', path.join(root, 'source.mp4')).expect(201)
  })
  it('serializes simultaneous claims and GC versus product binding without losing referenced objects', async () => {
    const owner = await merchant(); const a = await asset(owner.merchant.id, owner.user.id)
    const products = await Promise.all([createTestProduct('竞态A', 10, 1, ['a'], owner.merchant.id), createTestProduct('竞态B', 10, 1, ['b'], owner.merchant.id)])
    await prisma.product.updateMany({ where: { id: { in: products.map(p => p.id) } }, data: { status: 'draft' } })
    const replies = await Promise.all(products.map(p => api.patch(`/api/merchant/products/${p.id}/content`).set(owner.headers).send({ expectedContentVersion: 1, promoVideoAssetId: a.id })))
    expect(replies.map(r => r.status).sort()).toEqual([200, 409])
    const b = await asset(owner.merchant.id, owner.user.id)
    await prisma.productVideoAsset.update({ where: { id: b.id }, data: { updatedAt: new Date(Date.now() - 2 * 86400_000) } })
    const target = products[replies.findIndex(r => r.status === 409)]
    const [binding] = await Promise.all([
      api.patch(`/api/merchant/products/${target.id}/content`).set(owner.headers).send({ expectedContentVersion: 1, promoVideoAssetId: b.id }),
      cleanupProductVideos(),
    ])
    expect([200, 409]).toContain(binding.status)
    const current = await prisma.product.findUniqueOrThrow({ where: { id: target.id } })
    if (current.promoVideoAssetId) {
      expect(current.promoVideoAssetId).toBe(b.id)
      expect(await storage.getObject(videoKey(b.id))).not.toBeNull()
      expect((await prisma.productVideoAsset.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('ready')
    }
  })
  it('fails closed when playback/upload is disabled; only one in-flight reservation per owner', async () => {
    const owner = await merchant()
    await reserveVideo(owner.merchant.id, owner.user.id)
    await expect(reserveVideo(owner.merchant.id, owner.user.id)).rejects.toMatchObject({ status: 429 })
    process.env.PRODUCT_VIDEO_UPLOAD_ENABLED = 'false'
    await api.post('/api/uploads/product-video').set(owner.headers).attach('file', path.join(root, 'source.mp4')).expect(503)
    process.env.PRODUCT_VIDEO_PLAYBACK_ENABLED = 'false'
    await expect(productVideoPlayback(1, 'guest')).rejects.toMatchObject({ status: 503 })
  })
  it.runIf(config.redisEnabled)('rechecks the content version before returning a cached video summary with real Redis', async () => {
    const owner = await merchant()
    const first = await asset(owner.merchant.id, owner.user.id)
    const second = await asset(owner.merchant.id, owner.user.id)
    const product = await createTestProduct('缓存视频', 10, 1, ['a'], owner.merchant.id)
    await prisma.product.update({ where: { id: product.id }, data: { promoVideoAssetId: first.id } })
    expect((await api.get(`/api/products/${product.id}`).set(owner.headers).expect(200)).body.promoVideo.assetId).toBe(first.id)
    // Simulate a committed edit whose cache invalidation was lost. Member
    // access isolates projection freshness from the guest approval decision.
    await prisma.product.update({ where: { id: product.id }, data: { promoVideoAssetId: second.id, contentVersion: { increment: 1 } } })
    expect((await api.get(`/api/products/${product.id}`).set(owner.headers).expect(200)).body.promoVideo.assetId).toBe(second.id)
    await api.get(`/api/products/${product.id}/video-playback?expectedVideoAssetId=${first.id}`).set(owner.headers).expect(409)
  })
})

describe('cleanup and portable video objects', () => {
  it('cleans only its own upload temp root and leaves same-prefix system directories alone', async () => {
    await mkdir(productVideoTempRoot(), { recursive: true })
    const abandoned = await mkdtemp(path.join(productVideoTempRoot(), 'upload-'))
    const unrelated = await mkdtemp(path.join(os.tmpdir(), 'monexus-video-'))
    try {
      await writeFile(path.join(unrelated, 'keep'), 'another tool or instance')
      await cleanupProductVideos(new Date(Date.now() + 3 * 86400_000))
      await expect(readFile(path.join(unrelated, 'keep'), 'utf8')).resolves.toBe('another tool or instance')
      await expect(readFile(abandoned)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(unrelated, { recursive: true, force: true }) }
  })
  it('paid GC skips video and unknown keys; video GC retains referenced assets and deletes abandoned ones', async () => {
    const { user } = await createTestUser()
    const a = await asset(null, user.id); const abandoned = await asset(null, user.id)
    const product = await createTestProduct()
    await prisma.product.update({ where: { id: product.id }, data: { promoVideoAssetId: a.id } })
    await storage.putStream('unknown-object', Readable.from('keep'), 10)
    const later = new Date(Date.now() + 3 * 86400_000)
    await cleanupUnreferencedObjects(later)
    expect(await storage.getObject(videoKey(a.id))).not.toBeNull()
    expect(await storage.getObject('unknown-object')).not.toBeNull()
    await cleanupProductVideos(later)
    expect(await prisma.productVideoAsset.findUnique({ where: { id: abandoned.id } })).toBeNull()
    expect(await storage.getObject(videoKey(abandoned.id))).toBeNull()
    expect(await storage.getObject(videoKey(a.id))).not.toBeNull()
  })
  it('retains a deleting asset after object deletion fails and retries safely', async () => {
    const { user } = await createTestUser()
    const a = await asset(null, user.id)
    const failure = vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('temporary outage'))
    const later = new Date(Date.now() + 3 * 86400_000)
    await cleanupProductVideos(later)
    expect((await prisma.productVideoAsset.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('deleting')
    failure.mockRestore()
    await cleanupProductVideos(later)
    expect(await prisma.productVideoAsset.findUnique({ where: { id: a.id } })).toBeNull()
  })
  it('streams a video manifest roundtrip, rebinds references, and refuses tampered/missing objects', async () => {
    const { user } = await createTestUser()
    const a = await asset(null, user.id)
    const staging = await mkdtemp(path.join(root, 'backup-')); await mkdir(path.join(staging, 'video-objects'))
    const manifest = await exportVideoObjects(prisma, staging)
    expect(manifest).toHaveLength(2); validateVideoManifest(manifest)
    expect(() => validateVideoManifest([...manifest, manifest[0]])).toThrow()
    expect(() => validateVideoManifest([{ ...manifest[0], archivePath: '../secret' }])).toThrow()
    const expected = await storage.getObject(videoKey(a.id))
    storage = new DeliveryMemoryStorage(); __setDeliveryStorageForTesting(storage)
    const written: string[] = []
    await restoreVideoObjects(manifest, staging, written)
    await rebindRestoredVideos(manifest)
    expect(await storage.getObject(videoKey(a.id))).toEqual(expected)
    const product = await createTestProduct()
    await prisma.product.update({ where: { id: product.id }, data: { promoVideoAssetId: a.id } })
    expect((await productVideoPlayback(product.id, 'guest')).playbackUrl).toContain('product-video-signed')
    await writeFile(path.join(staging, manifest[0].archivePath), 'tampered')
    storage = new DeliveryMemoryStorage(); __setDeliveryStorageForTesting(storage)
    await expect(restoreVideoObjects(manifest, staging, [])).rejects.toThrow('校验失败')
  })
})
