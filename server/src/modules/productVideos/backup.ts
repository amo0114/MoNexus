import { Transform } from 'node:stream'
import { config } from '../../config/index.js'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { getDeliveryStorageForProvider } from '../../lib/storage/delivery.js'
import { VIDEO_KEY, VIDEO_MAX_BYTES, VIDEO_POSTER_MAX_BYTES, videoKey } from '../../lib/storage/videoKeys.js'
import { sha256File, type PortableObjectManifest } from '../portable-backups/archive.js'

export interface VideoBackupObject extends PortableObjectManifest { storedObjectId: number }
export async function exportVideoObjects(tx: Prisma.TransactionClient, staging: string): Promise<VideoBackupObject[]> {
  const assets = await tx.productVideoAsset.findMany({ where: { status: 'ready' }, include: { videoStoredObject: true, posterStoredObject: true } })
  const total = assets.reduce((sum, asset) => sum + (asset.videoStoredObject?.size ?? 0) + (asset.posterStoredObject?.size ?? 0), 0)
  if (!Number.isSafeInteger(total) || total > config.portableBackupMaxBytes) throw new Error('视频备份超出容量预算')
  const disk = await statfs(staging)
  if (Number(disk.bavail) * Number(disk.bsize) < total * 3 + 64 * 1024 * 1024) throw new Error('视频备份临时磁盘不足')
  const deadline = AbortSignal.timeout(15 * 60_000)
  const objects: VideoBackupObject[] = []
  for (const asset of assets) {
    for (const [poster, object] of [[false, asset.videoStoredObject], [true, asset.posterStoredObject]] as const) {
      if (!object || object.status !== 'active' || object.source !== 'product_video' || object.bucketRole !== 'private'
        || object.objectKey !== videoKey(asset.id, poster) || object.providerConfigId !== asset.providerConfigId || !object.checksum || object.size == null) throw new Error('视频备份引用无效')
      const adapter = await getDeliveryStorageForProvider(object.providerConfigId)
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(60_000)])
      const stream = await adapter.getObjectStream(object.objectKey, signal)
      if (!stream) throw new Error('视频备份对象缺失')
      const archivePath = `video-objects/${createHash('sha256').update(String(object.id) + ':' + object.objectKey).digest('hex')}`
      const destination = path.join(staging, archivePath)
      let received = 0
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length
        callback(received > object.size! ? new Error('视频备份对象超出登记大小') : null, chunk)
      } })
      await pipeline(stream, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
      const size = (await stat(destination)).size; const sha256 = await sha256File(destination)
      if (size !== object.size || sha256 !== object.checksum) throw new Error('视频备份对象发生变化')
      objects.push({ storedObjectId: object.id, key: object.objectKey, archivePath, mimeType: poster ? 'image/jpeg' : 'video/mp4', size, sha256 })
    }
  }
  return objects
}
export function validateVideoManifest(objects: VideoBackupObject[]) {
  if (!Array.isArray(objects)) throw new Error('视频备份清单无效')
  const keys = new Set<string>(); const ids = new Set<number>(); const paths = new Set<string>()
  for (const object of objects) {
    if (!object || typeof object.key !== 'string' || !VIDEO_KEY.test(object.key)
      || object.mimeType !== (object.key.endsWith('/video.mp4') ? 'video/mp4' : 'image/jpeg')
      || !/^video-objects\/[a-f0-9]{64}$/.test(object.archivePath)
      || !/^[a-f0-9]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.storedObjectId) || object.storedObjectId < 1
      || !Number.isSafeInteger(object.size) || object.size <= 0 || object.size > (object.mimeType === 'video/mp4' ? VIDEO_MAX_BYTES : VIDEO_POSTER_MAX_BYTES)
      || keys.has(object.key) || ids.has(object.storedObjectId) || paths.has(object.archivePath)) throw new Error('视频备份清单无效')
    keys.add(object.key); ids.add(object.storedObjectId); paths.add(object.archivePath)
  }
}

/** Restore videos into the target's env private bucket; rebind restored DB metadata only after commit. */
export async function restoreVideoObjects(objects: VideoBackupObject[], extracted: string, written: string[]) {
  const adapter = await getDeliveryStorageForProvider(null)
  const deadline = AbortSignal.timeout(15 * 60_000)
  for (const object of objects) {
    if (await adapter.objectExists(object.key, AbortSignal.any([deadline, AbortSignal.timeout(10_000)]))) throw new Error('目标视频对象已存在')
  }
  for (const object of objects) {
    const source = path.join(extracted, object.archivePath)
    if ((await stat(source)).size !== object.size || await sha256File(source) !== object.sha256) throw new Error('视频备份校验失败')
    written.push(object.key)
    const result = await adapter.putStream(object.key, createReadStream(source), object.size, { contentType: object.mimeType as 'video/mp4' | 'image/jpeg', signal: AbortSignal.any([deadline, AbortSignal.timeout(60_000)]) })
    if (result.size !== object.size || result.sha256 !== object.sha256) throw new Error('视频恢复校验失败')
  }
}
export async function rebindRestoredVideos(objects: VideoBackupObject[]) {
  await prisma.$transaction(async tx => {
    for (const object of objects) {
      const current = await tx.storedObject.findUnique({ where: { id: object.storedObjectId } })
      if (!current || current.source !== 'product_video' || current.bucketRole !== 'private' || current.objectKey !== object.key || current.checksum !== object.sha256 || current.size !== object.size) throw new Error('恢复的视频数据库引用不匹配')
      await tx.storedObject.update({ where: { id: current.id }, data: { providerConfigId: null, providerRef: 'env' } })
    }
    const assets = await tx.productVideoAsset.findMany({ where: { status: 'ready' } })
    const ids = new Set(objects.map(o => o.storedObjectId))
    for (const asset of assets) {
      if (!asset.videoStoredObjectId || !asset.posterStoredObjectId || !ids.has(asset.videoStoredObjectId) || !ids.has(asset.posterStoredObjectId)) throw new Error('恢复的视频资产缺少对象')
    }
    // In-progress uploads cannot be resumed across environments.
    await tx.productVideoAsset.updateMany({ where: { status: 'uploading' }, data: { status: 'failed' } })
    await tx.productVideoAsset.updateMany({ data: { providerConfigId: null } })
  })
}

/** Appended to pg_restore SQL and executed in the SAME psql transaction.
 * A mismatched v3 manifest rolls back schema/data before target references appear.
 */
export function videoRestoreSql(objects: VideoBackupObject[]) {
  validateVideoManifest(objects)
  const delimiter = '$video_manifest_' + createHash('sha256').update(JSON.stringify(objects)).digest('hex') + '$'
  const json = delimiter + JSON.stringify(objects) + delimiter
  return `
SET LOCAL search_path = public, pg_catalog;
CREATE TEMP TABLE video_restore_manifest ON COMMIT DROP AS
  SELECT * FROM jsonb_to_recordset(${json}::jsonb) AS m("storedObjectId" int, key text, sha256 text, size bigint, "mimeType" text);
DO $video_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM video_restore_manifest m LEFT JOIN "StoredObject" o ON o.id = m."storedObjectId"
    WHERE o.id IS NULL OR o.source <> 'product_video' OR o."bucketRole" <> 'private' OR o.status <> 'active'
      OR o."objectKey" IS DISTINCT FROM m.key OR o.checksum IS DISTINCT FROM m.sha256 OR o.size IS DISTINCT FROM m.size
  ) OR EXISTS (
    SELECT 1 FROM "ProductVideoAsset" a WHERE a.status = 'ready' AND (
      NOT EXISTS (SELECT 1 FROM video_restore_manifest m WHERE m."storedObjectId" = a."videoStoredObjectId" AND m.key = 'product-videos/v1/' || a.id || '/video.mp4') OR
      NOT EXISTS (SELECT 1 FROM video_restore_manifest m WHERE m."storedObjectId" = a."posterStoredObjectId" AND m.key = 'product-videos/v1/' || a.id || '/poster.jpg')
    )
  ) THEN RAISE EXCEPTION 'video restore manifest mismatch'; END IF;
END $video_validation$;
UPDATE "StoredObject" SET "providerConfigId" = NULL, "providerRef" = 'env'
  WHERE id IN (SELECT "storedObjectId" FROM video_restore_manifest);
UPDATE "ProductVideoAsset" SET status = 'failed' WHERE status = 'uploading';
UPDATE "ProductVideoAsset" SET "providerConfigId" = NULL;
`
}
