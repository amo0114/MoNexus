import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config/index.js'
import { badRequest, conflict, HttpError, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { getStorage } from '../../lib/storage/index.js'
import { getDeliveryStorage } from '../../lib/storage/delivery.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import {
  createTarGz,
  decryptArchive,
  encryptArchive,
  extractTarGz,
  type PortableBackupManifest,
  type PortableObjectManifest,
  runProgram,
  sha256File,
} from './archive.js'

const DOWNLOAD_TTL_MS = 60 * 60 * 1000
const BUNDLE_EXTENSION = '.monexus-backup'
const RESTORABLE_OBJECT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
// Uploads created by MoNexus are content-addressed via hashKey(). Restricting
// portable bundles to this namespace prevents an administrator from
// accidentally exporting every unrelated object from a shared S3 bucket.
const PORTABLE_OBJECT_KEY = /^[a-f0-9]{32}\.(?:png|jpeg|webp|gif)$/
// P5：交付文件对象键 = 全量 sha256 + 短扩展名（tmp/ 临时对象不进备份）。
const DELIVERY_OBJECT_KEY = /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/

type JobState = 'running' | 'ready' | 'failed'

interface PortableBackupJob {
  id: string
  adminUserId: number
  createdAt: Date
  state: JobState
  filePath?: string
  fileName?: string
  byteSize?: number
  objectCount?: number
  error?: string
  workDirectory: string
}

export interface PortableBackupJobView {
  id: string
  createdAt: Date
  state: JobState
  fileName?: string
  byteSize?: number
  objectCount?: number
  error?: string
}

const jobs = new Map<string, PortableBackupJob>()
let activeOperationId: string | null = null

export async function startPortableBackup(adminUserId: number, passphrase: string) {
  acquireOperation()
  let workDirectory: string
  try {
    await fsp.mkdir(config.portableBackupWorkDir, { recursive: true, mode: 0o700 })
    workDirectory = await fsp.mkdtemp(path.join(config.portableBackupWorkDir, 'export-'))
  } catch (err) {
    activeOperationId = null
    throw err
  }
  const job: PortableBackupJob = {
    id: crypto.randomUUID(),
    adminUserId,
    createdAt: new Date(),
    state: 'running',
    workDirectory,
  }
  activeOperationId = job.id
  jobs.set(job.id, job)

  void runExport(job, passphrase)
  return toJobView(job)
}

export function getPortableBackupJob(adminUserId: number, id: string) {
  const job = jobs.get(id)
  if (!job || job.adminUserId !== adminUserId) throw notFound('备份任务不存在')
  return toJobView(job)
}

export function getPortableBackupDownload(adminUserId: number, id: string) {
  const job = jobs.get(id)
  if (!job || job.adminUserId !== adminUserId) throw notFound('备份任务不存在')
  if (job.state !== 'ready' || !job.filePath || !job.fileName) {
    throw conflict('备份文件尚未准备完成')
  }
  return { filePath: job.filePath, fileName: job.fileName }
}

export async function importPortableBackup(
  adminUserId: number,
  filePath: string,
  passphrase: string
) {
  acquireOperation()
  let workDirectory: string | undefined
  let storage: Awaited<ReturnType<typeof getStorage>> | undefined
  let deliveryStorage: Awaited<ReturnType<typeof getDeliveryStorage>> | undefined
  const restoredObjectKeys: string[] = []
  const restoredDeliveryKeys: string[] = []
  const restoredObjectUrls = new Map<string, string>()
  // pg_restore is executed in one PostgreSQL transaction. Keep this separate
  // from "started": when it fails, the database is still the untouched empty
  // target and the objects written during this attempt can be removed safely.
  // Once it commits, objects must remain: the restored database refers to them
  // even if a later compatibility migration or audit write fails.
  let databaseRestoreCommitted = false

  try {
    const operator = await prisma.user.findUnique({
      where: { id: adminUserId },
      select: {
        id: true,
        email: true,
        password: true,
        nickname: true,
        emailVerified: true,
        role: true,
        status: true,
      },
    })
    if (!operator || operator.role !== 'admin' || operator.status === '已封禁') {
      throw notFound('当前引导管理员不存在')
    }

    const uploaded = await fsp.stat(filePath)
    if (uploaded.size > config.portableBackupMaxBytes) {
      throw badRequest('备份文件超过服务器允许的大小', 'FILE_TOO_LARGE')
    }

    await fsp.mkdir(config.portableBackupWorkDir, { recursive: true, mode: 0o700 })
    workDirectory = await fsp.mkdtemp(path.join(config.portableBackupWorkDir, 'import-'))
    const decrypted = path.join(workDirectory, 'payload.tar.gz')
    const extracted = path.join(workDirectory, 'payload')
    await fsp.mkdir(extracted, { mode: 0o700 })

    await decryptArchive(filePath, decrypted, passphrase)
    await extractTarGz(decrypted, extracted)
    const manifest = await readAndValidateManifest(extracted)
    const deliveryObjects = manifest.deliveryObjects ?? []
    await assertTargetIsFresh(
      operator.id,
      manifest.objects.map(object => object.key),
      deliveryObjects.map(object => object.key),
    )

    // Restore blobs before DB references become visible. If an object cannot
    // be restored, the target DB remains untouched and the import can be
    // retried after fixing storage configuration.
    storage = await getStorage()
    for (const object of manifest.objects) {
      const source = path.join(extracted, object.archivePath)
      const content = await fsp.readFile(source)
      if (content.length !== object.size || sha256Buffer(content) !== object.sha256) {
        throw new Error('备份对象校验失败')
      }
      // Record before writing so an ambiguous network failure can still be
      // cleaned up safely. Target storage was verified empty beforehand.
      restoredObjectKeys.push(object.key)
      const restored = await storage.putAtKey(object.key, content, object.mimeType)
      restoredObjectUrls.set(object.key, restored.url)
    }

    // P5：交付文件对象恢复进私有桶（DB 里 DeliveryFile.key 即引用，无 URL 改写）。
    deliveryStorage = await getDeliveryStorage()
    for (const object of deliveryObjects) {
      const source = path.join(extracted, object.archivePath)
      const content = await fsp.readFile(source)
      if (content.length !== object.size || sha256Buffer(content) !== object.sha256) {
        throw new Error('备份对象校验失败')
      }
      restoredDeliveryKeys.push(object.key)
      await deliveryStorage.putObjectAt(object.key, content)
    }

    const databaseDump = path.join(extracted, manifest.database.archivePath)
    if (await sha256File(databaseDump) !== manifest.database.sha256) {
      throw new Error('数据库转储校验失败')
    }

    await restoreDatabase(databaseDump)
    databaseRestoreCommitted = true
    await runDatabaseMigrations()
    await prisma.$disconnect()

    // pg_restore replaces all business rows. Recreate the current bootstrap
    // operator so the new instance remains controllable, and force every
    // imported account to establish a fresh session.
    const restoredOperator = await prisma.user.upsert({
      where: { email: operator.email },
      update: {
        password: operator.password,
        nickname: operator.nickname,
        emailVerified: operator.emailVerified,
        role: 'admin',
        status: '正常',
      },
      create: {
        email: operator.email,
        password: operator.password,
        nickname: operator.nickname,
        emailVerified: operator.emailVerified,
        role: 'admin',
        status: '正常',
      },
    })
    const rewrittenProductImages = await rewriteRestoredProductImageUrls(restoredObjectUrls)
    await prisma.$transaction([
      prisma.refreshToken.deleteMany(),
      prisma.passwordResetToken.deleteMany(),
      prisma.emailVerificationToken.deleteMany(),
      prisma.adminLog.create({
        data: {
          adminUserId: restoredOperator.id,
          action: '导入可移植备份',
          targetType: 'portable_backup',
          detail: `已恢复 ${manifest.objects.length} 个公开对象、${(manifest.deliveryObjects ?? []).length} 个交付文件对象、改写 ${rewrittenProductImages} 个商品图片地址；所有旧会话已撤销`,
        },
      }),
    ])
    // A fresh target can still have cached an empty public product list before
    // the operator reaches the restore screen. Bump that version after the
    // database becomes visible so first visitors do not see the stale empty
    // response.
    await invalidateProductPublicCache(0, { list: true })

    return { objectCount: manifest.objects.length, reauthenticate: true }
  } catch (err) {
    if (!databaseRestoreCommitted && storage && restoredObjectKeys.length > 0) {
      await Promise.allSettled(restoredObjectKeys.map(key => storage!.deleteAtKey(key)))
    }
    if (!databaseRestoreCommitted && deliveryStorage && restoredDeliveryKeys.length > 0) {
      await Promise.allSettled(restoredDeliveryKeys.map(key => deliveryStorage!.delete(key)))
    }
    if (err instanceof HttpError) throw err
    throw badRequest('导入失败：备份文件、口令或目标实例状态无效')
  } finally {
    activeOperationId = null
    await fsp.rm(workDirectory ?? filePath, { recursive: true, force: true })
    if (workDirectory) await fsp.rm(filePath, { force: true })
  }
}

async function runExport(job: PortableBackupJob, passphrase: string) {
  try {
    const staging = path.join(job.workDirectory, 'staging')
    const objectDirectory = path.join(staging, 'objects')
    const databaseDump = path.join(staging, 'database.dump')
    await fsp.mkdir(objectDirectory, { recursive: true, mode: 0o700 })

    await dumpDatabase(databaseDump)
    const storage = await getStorage()
    const objectManifest: PortableObjectManifest[] = []
    const listedObjects = (await storage.list()).filter(object => isPortableObjectKey(object.key))

    for (const listed of listedObjects) {
      const object = await storage.get(listed.key)
      if (!object) throw new Error('对象存储在备份期间发生变化，请重新创建备份')
      const objectName = crypto.createHash('sha256').update(listed.key).digest('hex')
      const archivePath = `objects/${objectName}`
      const destination = path.join(staging, archivePath)
      await fsp.writeFile(destination, object.buffer, { flag: 'wx', mode: 0o600 })
      objectManifest.push({
        key: listed.key,
        archivePath,
        mimeType: object.mimeType,
        size: object.buffer.length,
        sha256: sha256Buffer(object.buffer),
      })
    }

    // P5：私有交付桶纳入备份——否则受控文件是灾备盲区。
    const deliveryStorage = await getDeliveryStorage()
    const deliveryObjectDirectory = path.join(staging, 'delivery-objects')
    await fsp.mkdir(deliveryObjectDirectory, { recursive: true, mode: 0o700 })
    const deliveryObjectManifest: PortableObjectManifest[] = []
    const listedDeliveryObjects = (await deliveryStorage.list())
      .filter(object => DELIVERY_OBJECT_KEY.test(object.key))
    for (const listed of listedDeliveryObjects) {
      const buffer = await deliveryStorage.getObject(listed.key)
      if (!buffer) throw new Error('对象存储在备份期间发生变化，请重新创建备份')
      const objectName = crypto.createHash('sha256').update(listed.key).digest('hex')
      const archivePath = `delivery-objects/${objectName}`
      await fsp.writeFile(path.join(staging, archivePath), buffer, { flag: 'wx', mode: 0o600 })
      deliveryObjectManifest.push({
        key: listed.key,
        archivePath,
        mimeType: 'application/octet-stream',
        size: buffer.length,
        sha256: sha256Buffer(buffer),
      })
    }

    const databaseStat = await fsp.stat(databaseDump)
    const manifest: PortableBackupManifest = {
      formatVersion: 2,
      createdAt: job.createdAt.toISOString(),
      applicationVersion: process.env.npm_package_version ?? '1.0.0',
      database: {
        archivePath: 'database.dump',
        size: databaseStat.size,
        sha256: await sha256File(databaseDump),
      },
      objects: objectManifest,
      deliveryObjects: deliveryObjectManifest,
    }
    await fsp.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })

    const tarball = path.join(job.workDirectory, 'payload.tar.gz')
    const fileName = `monexus-${job.createdAt.toISOString().replace(/[:.]/g, '-')}${BUNDLE_EXTENSION}`
    const bundle = path.join(job.workDirectory, fileName)
    await createTarGz(staging, tarball)
    await encryptArchive(tarball, bundle, passphrase)
    const bundleStat = await fsp.stat(bundle)
    if (bundleStat.size > config.portableBackupMaxBytes) {
      throw new Error('备份包超过服务器允许的大小')
    }

    job.state = 'ready'
    job.filePath = bundle
    job.fileName = fileName
    job.byteSize = bundleStat.size
    job.objectCount = objectManifest.length + deliveryObjectManifest.length
    await prisma.adminLog.create({
      data: {
        adminUserId: job.adminUserId,
        action: '创建可移植备份',
        targetType: 'portable_backup',
        detail: `包含数据库、${objectManifest.length} 个公开对象与 ${deliveryObjectManifest.length} 个交付文件对象；不含环境密钥`,
      },
    })
    scheduleJobCleanup(job)
  } catch (err) {
    job.state = 'failed'
    job.error = err instanceof Error && err.message === '备份包超过服务器允许的大小'
      ? err.message
      : '备份创建失败，请检查数据库、对象存储和临时磁盘空间'
    scheduleJobCleanup(job)
  } finally {
    activeOperationId = null
  }
}

async function dumpDatabase(destination: string) {
  const { url, env } = databaseProcessOptions()
  await runProgram('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file', destination,
    '--dbname', url.toString(),
  ], { env })
}

async function restoreDatabase(source: string) {
  const { url, env } = databaseProcessOptions()
  await runProgram('pg_restore', [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--exit-on-error',
    // PostgreSQL supports transactional DDL. This makes a malformed or
    // incompatible dump fail without leaving the deliberately-empty target
    // database in a half-restored state.
    '--single-transaction',
    '--dbname', url.toString(),
    source,
  ], { env })
}

async function runDatabaseMigrations() {
  // A destination on a newer MoNexus release can have migrations that the
  // source backup never saw. Apply those only after the source dump commits.
  await runProgram('npx', ['prisma', 'migrate', 'deploy'], { cwd: process.cwd() })
}

async function readAndValidateManifest(extractedDirectory: string) {
  const manifestPath = path.join(extractedDirectory, 'manifest.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error('备份清单无效')
  }

  if (!parsed || typeof parsed !== 'object') throw new Error('备份清单无效')
  const manifest = parsed as PortableBackupManifest
  if (
    (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) ||
    !manifest.database ||
    manifest.database.archivePath !== 'database.dump' ||
    !isSha256(manifest.database.sha256) ||
    !Number.isSafeInteger(manifest.database.size) || manifest.database.size < 0 ||
    !Array.isArray(manifest.objects)
  ) {
    throw new Error('备份格式不受支持')
  }

  const seenKeys = new Set<string>()
  const seenPaths = new Set<string>()
  for (const object of manifest.objects) {
    if (
      !object || typeof object !== 'object' ||
      typeof object.key !== 'string' || !isPortableObjectKey(object.key) ||
      typeof object.mimeType !== 'string' || !RESTORABLE_OBJECT_MIME_TYPES.has(object.mimeType) ||
      !/^objects\/[a-f0-9]{64}$/.test(object.archivePath) ||
      !Number.isSafeInteger(object.size) || object.size < 0 ||
      !isSha256(object.sha256) ||
      seenKeys.has(object.key) || seenPaths.has(object.archivePath)
    ) {
      throw new Error('备份对象清单无效')
    }
    seenKeys.add(object.key)
    seenPaths.add(object.archivePath)
  }

  // P5（v2）：交付文件对象清单。v1 包没有该字段（旧备份，兼容导入）。
  if (manifest.deliveryObjects !== undefined) {
    if (manifest.formatVersion < 2 || !Array.isArray(manifest.deliveryObjects)) {
      throw new Error('备份格式不受支持')
    }
    for (const object of manifest.deliveryObjects) {
      if (
        !object || typeof object !== 'object' ||
        typeof object.key !== 'string' || !DELIVERY_OBJECT_KEY.test(object.key) ||
        object.mimeType !== 'application/octet-stream' ||
        !/^delivery-objects\/[a-f0-9]{64}$/.test(object.archivePath) ||
        !Number.isSafeInteger(object.size) || object.size < 0 ||
        !isSha256(object.sha256) ||
        seenKeys.has(object.key) || seenPaths.has(object.archivePath)
      ) {
        throw new Error('备份对象清单无效')
      }
      seenKeys.add(object.key)
      seenPaths.add(object.archivePath)
    }
  }
  return manifest
}

async function assertTargetIsFresh(
  operatorId: number,
  incomingObjectKeys: string[],
  incomingDeliveryKeys: string[] = []
) {
  const [otherUsers, products, merchants, orders, inventory, inventoryLogs, pointLogs, checkins, invites, reviews, settlements, deliveries, events, announcements, deliveryFiles, fileGrants] = await Promise.all([
    prisma.user.count({ where: { id: { not: operatorId } } }),
    prisma.product.count(),
    prisma.merchant.count(),
    prisma.order.count(),
    prisma.inventoryItem.count(),
    prisma.inventoryLog.count(),
    prisma.pointLog.count(),
    prisma.checkinRecord.count(),
    prisma.inviteRelation.count(),
    prisma.review.count(),
    prisma.settlement.count(),
    prisma.deliveryRecord.count(),
    prisma.orderStatusEvent.count(),
    prisma.announcement.count(),
    prisma.deliveryFile.count(),
    prisma.fileGrantLog.count(),
  ])
  if ([otherUsers, products, merchants, orders, inventory, inventoryLogs, pointLogs, checkins, invites, reviews, settlements, deliveries, events, announcements, deliveryFiles, fileGrants].some(count => count > 0)) {
    throw conflict('仅允许向空实例导入备份')
  }

  const storage = await getStorage()
  const existingKeys = new Set((await storage.list()).map(object => object.key))
  if (incomingObjectKeys.some(key => existingKeys.has(key))) {
    throw conflict('目标对象存储已存在同名 MoNexus 文件，拒绝覆盖或合并')
  }
  if (incomingDeliveryKeys.length > 0) {
    const deliveryStorage = await getDeliveryStorage()
    const existingDeliveryKeys = new Set((await deliveryStorage.list()).map(object => object.key))
    if (incomingDeliveryKeys.some(key => existingDeliveryKeys.has(key))) {
      throw conflict('目标交付文件存储已存在同名对象，拒绝覆盖或合并')
    }
  }
}

function acquireOperation() {
  if (activeOperationId) throw conflict('已有备份或恢复任务正在执行')
  // Reserve synchronously, before any mkdir/IO await can allow another
  // administrator to start a competing operation.
  activeOperationId = 'pending'
}

function toJobView(job: PortableBackupJob): PortableBackupJobView {
  return {
    id: job.id,
    createdAt: job.createdAt,
    state: job.state,
    ...(job.fileName ? { fileName: job.fileName } : {}),
    ...(job.byteSize !== undefined ? { byteSize: job.byteSize } : {}),
    ...(job.objectCount !== undefined ? { objectCount: job.objectCount } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

function scheduleJobCleanup(job: PortableBackupJob) {
  const timer = setTimeout(() => {
    jobs.delete(job.id)
    void fsp.rm(job.workDirectory, { recursive: true, force: true })
  }, DOWNLOAD_TTL_MS)
  timer.unref()
}

function sha256Buffer(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isPortableObjectKey(value: unknown): value is string {
  return typeof value === 'string' && PORTABLE_OBJECT_KEY.test(value)
}

async function rewriteRestoredProductImageUrls(restoredObjectUrls: Map<string, string>) {
  if (restoredObjectUrls.size === 0) return 0

  const products = await prisma.product.findMany({
    select: { id: true, imageUrl: true, images: true },
  })
  const updates = products.flatMap(product => {
    const imageUrl = rewriteStoredObjectUrl(product.imageUrl, restoredObjectUrls)
    const images = product.images.map(url => rewriteStoredObjectUrl(url, restoredObjectUrls) ?? url)
    const imageChanged = imageUrl !== product.imageUrl
    const imagesChanged = images.some((url, index) => url !== product.images[index])
    if (!imageChanged && !imagesChanged) return []
    return [prisma.product.update({
      where: { id: product.id },
      data: {
        ...(imageChanged ? { imageUrl } : {}),
        ...(imagesChanged ? { images } : {}),
      },
    })]
  })
  await prisma.$transaction(updates)
  return updates.length
}

function rewriteStoredObjectUrl(value: string | null, restoredObjectUrls: Map<string, string>) {
  if (!value) return value
  let key: string | undefined
  try {
    key = decodeURIComponent(new URL(value, 'https://portable-backup.invalid').pathname)
      .split('/')
      .filter(Boolean)
      .at(-1)
  } catch {
    return value
  }
  return key && restoredObjectUrls.get(key) ? restoredObjectUrls.get(key)! : value
}

function databaseProcessOptions() {
  const url = new URL(config.databaseUrl)
  const password = decodeURIComponent(url.password)
  url.password = ''
  url.searchParams.delete('schema')
  return {
    url,
    env: {
      ...process.env,
      ...(password ? { PGPASSWORD: password } : {}),
    },
  }
}
