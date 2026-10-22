/** Isolated v3 backup rehearsal. Requires two freshly migrated disposable databases.
 * VIDEO_BACKUP_SOURCE_URL / VIDEO_BACKUP_TARGET_URL must have monexus_video_backup_ names.
 * Uses the isolated MinIO endpoint from product-video-storage-integration.ts, never production.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, copyFile, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
const source = process.env.VIDEO_BACKUP_SOURCE_URL!
const target = process.env.VIDEO_BACKUP_TARGET_URL!
for (const url of [source, target]) assert.match(new URL(url).pathname, /^\/monexus_video_backup_[a-z0-9_]+$/)
assert.notEqual(source, target)
const endpoint = process.env.INT_ENDPOINT || 'http://localhost:19380'
const admin = new S3Client({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'video-test', secretAccessKey: 'video-test-secret' }, forcePathStyle: true })
const passphrase = 'integration-test-only-long-passphrase'
const mode = process.argv[2]
const root = process.argv[3]
if (!mode) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-backup-rehearsal-'))
  const suffix = Date.now().toString(36)
  const buckets = ['source-public', 'source-private', 'target-public', 'target-private'].map(name => `video-${name}-${suffix}`)
  try {
    for (const bucket of buckets) await admin.send(new CreateBucketCommand({ Bucket: bucket }))
    for (const [step, db, offset] of [['export', source, 0], ['import', target, 2]] as const) {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/product-video-backup-integration.ts', step, directory], {
        cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: db,
          FRONTEND_ORIGIN: 'http://localhost:5173', JWT_SECRET: 'video-backup-integration-secret-long-enough', STORAGE_CONFIG_SOURCE: 'env',
          STORAGE_ENDPOINT: endpoint, STORAGE_REGION: 'us-east-1', STORAGE_BUCKET: buckets[offset],
          STORAGE_ACCESS_KEY: 'video-test', STORAGE_SECRET_KEY: 'video-test-secret', STORAGE_PUBLIC_URL_BASE: `${endpoint}/${buckets[offset]}`,
          STORAGE_FORCE_PATH_STYLE: 'true', DELIVERY_STORAGE_BUCKET: buckets[offset + 1], DELIVERY_STORAGE_PUBLIC_ENDPOINT: endpoint,
          PORTABLE_BACKUP_WORK_DIR: path.join(directory, step), PRODUCT_VIDEO_PLAYBACK_ENABLED: 'true',
        },
      })
    }
    console.log('PASS: encrypted v3 database + private video + paid attachment restored into isolated DB/buckets; guest playback authorized')
  } finally {
    for (const bucket of buckets) {
      const objects = await admin.send(new ListObjectsV2Command({ Bucket: bucket })).catch(() => null)
      for (const object of objects?.Contents || []) await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }))
      await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {})
    }
    await rm(directory, { recursive: true, force: true }); admin.destroy()
  }
} else {
  const { prisma } = await import('../src/lib/prisma.js')
  const { startPortableBackup, getPortableBackupJob, getPortableBackupDownload, importPortableBackup } = await import('../src/modules/portable-backups/service.js')
  assert.equal(await prisma.user.count(), 0, 'database must be freshly migrated and empty')
  const user = await prisma.user.create({ data: { email: `${mode}@video.test`, password: 'test-only', role: 'admin', status: '正常' } })
  if (mode === 'export') {
    const { ensureSeedCategories } = await import('../src/modules/catalog/bootstrap.js')
    await ensureSeedCategories(user.id)
    const category = await prisma.productCategory.findFirstOrThrow({ where: { status: 'active' } })
    const { reserveVideo, finishVideo } = await import('../src/modules/productVideos/service.js')
    const { processVideo } = await import('../src/modules/productVideos/processing.js')
    const input = path.join(root, 'input.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', input])
    const media = await processVideo(input, root, AbortSignal.timeout(60000))
    const reservation = await reserveVideo(null, user.id)
    const video = await finishVideo(reservation.asset, reservation.adapter, media, AbortSignal.timeout(60000))
    await prisma.product.create({ data: { name: 'Restored video', type: category.label, categoryId: category.id, price: 100, status: 'active', visibility: 'public', promoVideoAssetId: video.id,
      guestEligibility: { create: { decision: 'approved', reviewedRevision: 1 } } } })
    const { getDeliveryStorageForProvider } = await import('../src/lib/storage/delivery.js')
    const { createHash } = await import('node:crypto')
    const bytes = Buffer.from('paid-attachment-rehearsal'); const sha256 = createHash('sha256').update(bytes).digest('hex'); const key = `${sha256}.bin`
    await (await getDeliveryStorageForProvider(null)).putObjectAt(key, bytes)
    await prisma.deliveryFile.create({ data: { key, size: bytes.length, sha256, fileName: 'paid.bin', mimeType: 'application/octet-stream', uploadedByUserId: user.id } })
    const job = await startPortableBackup(user.id, passphrase)
    let view = getPortableBackupJob(user.id, job.id)
    const deadline = Date.now() + 60000
    while (view.state === 'running' && Date.now() < deadline) { await new Promise(r => setTimeout(r, 100)); view = getPortableBackupJob(user.id, job.id) }
    assert.equal(view.state, 'ready', view.error)
    await copyFile(getPortableBackupDownload(user.id, job.id).filePath, path.join(root, 'copy.monexus-backup'))
  } else {
    const { decryptArchive, extractTarGz, createTarGz, encryptArchive } = await import('../src/modules/portable-backups/archive.js')
    const tar = path.join(root, 'bad.tar.gz'); const extracted = path.join(root, 'tampered')
    await mkdir(extracted)
    await decryptArchive(path.join(root, 'copy.monexus-backup'), tar, passphrase)
    await extractTarGz(tar, extracted)
    const manifestPath = path.join(extracted, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.videoObjects = []
    await writeFile(manifestPath, JSON.stringify(manifest))
    await createTarGz(extracted, tar)
    const badBundle = path.join(root, 'bad.monexus-backup'); await encryptArchive(tar, badBundle, passphrase)
    await assert.rejects(importPortableBackup(user.id, badBundle, passphrase))
    assert.equal(await prisma.product.count(), 0, 'manifest mismatch must roll back restored database')
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email, 'import@video.test')
    await importPortableBackup(user.id, path.join(root, 'copy.monexus-backup'), passphrase)
    const product = await prisma.product.findFirstOrThrow({ where: { name: 'Restored video' } })
    const { productVideoPlayback } = await import('../src/modules/productVideos/service.js')
    const ticket = await productVideoPlayback(product.id, 'guest')
    const response = await fetch(ticket.playbackUrl, { headers: { Range: 'bytes=0-15' } }); assert.equal(response.status, 206)
    const { getDeliveryStorageForProvider } = await import('../src/lib/storage/delivery.js')
    const file = await prisma.deliveryFile.findFirstOrThrow()
    assert.equal((await (await getDeliveryStorageForProvider(file.storageProviderId)).getObject(file.key))?.toString(), 'paid-attachment-rehearsal')
    assert.equal((await prisma.productVideoAsset.findUniqueOrThrow({ where: { id: product.promoVideoAssetId! } })).providerConfigId, null)
  }
  await prisma.$disconnect(); admin.destroy()
}
