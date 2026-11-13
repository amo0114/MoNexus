import { logger } from '../../lib/logger.js'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Prisma, type AdminExportJob } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { HttpError, forbidden, notFound } from '../../lib/httpError.js'
import { getAdminMfaSessionState, type AuthPayload } from '../../middlewares/auth.js'
import {
  getDeliveryStorageForWrite,
  getDeliveryStorageForProvider,
} from '../../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../../lib/storage/deliveryMemory.js'
import { FileTooLargeError } from '../../lib/storage/deliveryTypes.js'
import { registerStoredObject, providerRefFor } from '../../lib/storage/storedObjectRegistry.js'
import { assertPermission, type AdminPermission } from '../adminAuthorization/service.js'
import {
  commandInTx,
  cursorPage,
  decodeCursor,
  governanceConflict,
  requestHash,
  writeGovernanceAudit,
} from '../governance/common.js'

export const EXPORT_LIMITS = { rows: 100_000, bytes: 128 * 1024 * 1024, retentionSeconds: 86400 }
const dates = {
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
}
export const exportInput = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('users'),
        filters: z
          .object({
            ...dates,
            q: z.string().trim().min(1).max(100).optional(),
            accountStatus: z.enum(['active', 'banned']).optional(),
            role: z.enum(['user', 'merchant', 'admin']).optional(),
            merchantStatus: z.enum(['pending', 'active', 'rejected', 'suspended']).optional(),
            emailVerified: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('orders'),
        filters: z
          .object({
            ...dates,
            userId: z.number().int().positive().optional(),
            status: z
              .enum(['pending', 'processing', 'delivered', 'disputed', 'closed', 'refunded'])
              .optional(),
            orderNo: z.string().max(100).optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('point_logs'),
        filters: z
          .object({
            ...dates,
            userId: z.number().int().positive().optional(),
            type: z.string().min(1).max(80).optional(),
          })
          .strict(),
      })
      .strict(),
  ])
  .refine(
    (v) =>
      !v.filters.from || !v.filters.to || Date.parse(v.filters.from) < Date.parse(v.filters.to),
    {
      message: 'from 必须早于 to',
    },
  )
type ExportInput = z.infer<typeof exportInput>
const READ_PERMISSION: Record<string, AdminPermission> = {
  users: 'users.read',
  orders: 'orders.read',
  point_logs: 'points.read',
}
const COLUMNS: Record<string, string[]> = {
  users: [
    'id',
    'email',
    'nickname',
    'role',
    'accountStatus',
    'emailVerified',
    'merchantStatus',
    'createdAt',
    'lastLoginAt',
  ],
  orders: [
    'id',
    'orderNo',
    'userId',
    'merchantId',
    'productName',
    'offerName',
    'status',
    'pricePoints',
    'createdAt',
  ],
  point_logs: [
    'id',
    'userId',
    'type',
    'amountPoints',
    'balanceAfterPoints',
    'orderId',
    'reason',
    'createdAt',
  ],
}
export function exportDto(j: AdminExportJob) {
  return {
    id: j.id,
    kind: j.kind,
    requestedByUserId: j.requestedByUserId,
    status: j.expiresAt && j.expiresAt <= new Date() ? 'expired' : j.status,
    phase: j.phase,
    snapshotAt: j.snapshotAt,
    rowCount: j.rowCount,
    byteSize: j.byteSize,
    errorCode: j.errorCode,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    expiresAt: j.expiresAt,
  }
}
async function exportAuth(actor: number, kind: string, db: Prisma.TransactionClient = prisma) {
  const auth = await assertPermission(actor, 'exports.create', db)
  await assertPermission(actor, READ_PERMISSION[kind], db)
  return auth
}
async function writeStorage() {
  try {
    const result = await getDeliveryStorageForWrite()
    if (config.nodeEnv !== 'test' && result.adapter instanceof DeliveryMemoryStorage)
      throw Error('non_durable_storage')
    return result
  } catch {
    throw new HttpError(503, 'EXPORT_STORAGE_UNAVAILABLE', '没有可用的持久私有存储')
  }
}
export async function createExport(payload: AuthPayload, key: string, input: ExportInput) {
  await exportAuth(payload.userId, input.kind)
  if ((await getAdminMfaSessionState(payload)) !== 'allowed') throw forbidden('管理会话已失效')
  return prisma.$transaction(async (tx) => {
    await exportAuth(payload.userId, input.kind, tx)
    return commandInTx(tx, payload.userId, 'export.create', key, input, async () => {
      // A committed replay remains available during storage outages; new tasks fail closed.
      await writeStorage()
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`export-create:${payload.userId}`},0))`
      if (
        await tx.adminExportJob.count({
          where: { requestedByUserId: payload.userId, status: { in: ['queued', 'running'] } },
        })
      )
        throw governanceConflict('STATE_CONFLICT', '已有导出任务正在处理')
      const job = await tx.adminExportJob.create({
        data: {
          requestedByUserId: payload.userId,
          sessionId: payload.sid!,
          mfaVersion: payload.mfaVersion!,
          kind: input.kind,
          filters: input.filters,
          requestKey: key,
          requestHash: requestHash(input),
        },
      })
      await writeGovernanceAudit(tx, payload.userId, 'export.queued', 'export', null, {
        reasonCode: input.kind,
      })
      return exportDto(job)
    })
  })
}
export async function listExports(actor: number, q: { cursor?: string; pageSize: number }) {
  const auth = await assertPermission(actor, 'exports.create')
  const scope = `exports:${actor}`,
    c = decodeCursor(q.cursor, scope, 'uuid')
  const rows = await prisma.adminExportJob.findMany({
    where: {
      kind: {
        in: Object.keys(READ_PERMISSION).filter((k) =>
          auth.permissions.includes(READ_PERMISSION[k]),
        ),
      },
      ...(auth.tier === 'super' ? {} : { requestedByUserId: actor }),
      ...(c
        ? { OR: [{ createdAt: { lt: c.time } }, { createdAt: c.time, id: { lt: String(c.id) } }] }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.pageSize + 1,
  })
  // A revoked per-kind read permission must hide even the corresponding task summaries.
  const page = cursorPage(rows, q.pageSize, scope)
  return { ...page, items: page.items.map(exportDto) }
}
async function ownedJob(actor: number, id: string) {
  const auth = await assertPermission(actor, 'exports.create')
  const job = await prisma.adminExportJob.findUnique({ where: { id } })
  if (!job) throw notFound('导出任务不存在')
  if (job.requestedByUserId !== actor && auth.tier !== 'super') throw notFound('导出任务不存在')
  await assertPermission(actor, READ_PERMISSION[job.kind])
  return job
}
export async function getExport(actor: number, id: string) {
  return exportDto(await ownedJob(actor, id))
}
export async function downloadExport(actor: number, id: string) {
  const job = await ownedJob(actor, id)
  if (job.status === 'expired' || (job.expiresAt && job.expiresAt <= new Date()))
    throw new HttpError(410, 'EXPORT_EXPIRED', '导出已过期')
  if (job.status !== 'succeeded' || !job.objectKey)
    throw new HttpError(409, 'EXPORT_NOT_READY', '导出尚不可下载')
  const registered = await prisma.storedObject.findUnique({
    where: {
      bucketRole_objectKey_providerRef: {
        bucketRole: 'private',
        objectKey: job.objectKey,
        providerRef: providerRefFor(job.providerConfigId),
      },
    },
  })
  if (registered?.status !== 'active' || registered.source !== 'admin_export')
    throw new HttpError(503, 'EXPORT_STORAGE_UNAVAILABLE', '导出对象不可用')
  const storage = await getDeliveryStorageForProvider(job.providerConfigId)
  const ttl = Math.min(60, Math.floor((job.expiresAt!.getTime() - Date.now()) / 1000))
  if (ttl < 1) throw new HttpError(410, 'EXPORT_EXPIRED', '导出已过期')
  const signed = await storage.presignDownload(job.objectKey, `${job.kind}-${job.id}.csv`, ttl)
  // URLs are returned only here, never persisted or logged.
  return { url: signed.url, expiresAt: signed.expiresAt }
}
export async function assertExportWorkerAuth(job: AdminExportJob) {
  await exportAuth(job.requestedByUserId, job.kind)
  if (
    (await getAdminMfaSessionState({
      userId: job.requestedByUserId,
      role: 'admin',
      sid: job.sessionId,
      mfaVerified: true,
      mfaVersion: job.mfaVersion,
    })) !== 'allowed'
  )
    throw new HttpError(403, 'PERMISSION_DENIED', '原管理会话已失效')
}
export async function claimExport(): Promise<AdminExportJob | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('export-global-executors',0))`
    const active = await tx.adminExportJob.count({
      where: { status: 'running', leaseUntil: { gt: new Date() } },
    })
    if (active >= 2) return null
    const jobs = await tx.$queryRaw<
      AdminExportJob[]
    >`SELECT * FROM "AdminExportJob" WHERE (status='queued' OR (status='running' AND "leaseUntil"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))) AND "nextAttemptAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`
    if (!jobs[0]) return null
    return tx.adminExportJob.update({
      where: { id: jobs[0].id },
      data: {
        status: 'running',
        phase: jobs[0].snapshotAt ? 'uploading' : 'materializing',
        attempts: { increment: 1 },
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 90000),
      },
    })
  })
}
function snapshotSelect(input: ExportInput): Prisma.Sql {
  const f = input.filters,
    clauses: Prisma.Sql[] = [Prisma.sql`TRUE`]
  const alias = input.kind === 'users' ? 'u' : input.kind === 'orders' ? 'o' : 'l'
  if (f.from) clauses.push(Prisma.sql`${Prisma.raw(`${alias}."createdAt"`)} >= ${new Date(f.from)}`)
  if (f.to) clauses.push(Prisma.sql`${Prisma.raw(`${alias}."createdAt"`)} < ${new Date(f.to)}`)
  if (input.kind === 'users') {
    const q = input.filters
    if (q.accountStatus)
      clauses.push(Prisma.sql`governance_user_active(u.id)=${q.accountStatus === 'active'}`)
    if (q.role) clauses.push(Prisma.sql`u.role=${q.role}`)
    if (q.merchantStatus) clauses.push(Prisma.sql`m.status=${q.merchantStatus}`)
    if (q.emailVerified !== undefined)
      clauses.push(Prisma.sql`(u."emailVerified" IS NOT NULL)=${q.emailVerified}`)
    if (q.q) {
      if (/^\d+$/.test(q.q) && Number.isSafeInteger(Number(q.q)))
        clauses.push(Prisma.sql`u.id=${Number(q.q)}`)
      else if (q.q.includes('@')) clauses.push(Prisma.sql`u.email=${q.q.toLowerCase()}`)
      else {
        const term = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`
        clauses.push(
          Prisma.sql`(u.email ILIKE ${term} OR u.nickname ILIKE ${term} OR m.name ILIKE ${term})`,
        )
      }
    }
    return Prisma.sql`SELECT u.id,jsonb_build_array(u.id,u.email,u.nickname,u.role,CASE WHEN governance_user_active(u.id) THEN 'active' ELSE 'banned' END,u."emailVerified",m.status,u."createdAt",u."lastLoginAt") payload FROM "User" u LEFT JOIN "Merchant" m ON m."userId"=u.id WHERE ${Prisma.join(clauses, ' AND ')} ORDER BY u.id LIMIT ${EXPORT_LIMITS.rows + 1}`
  }
  if (input.kind === 'orders') {
    const q = input.filters
    if (q.userId) clauses.push(Prisma.sql`o."userId"=${q.userId}`)
    if (q.status)
      clauses.push(
        q.status === 'delivered'
          ? Prisma.sql`o.status IN ('completed','delivered')`
          : Prisma.sql`o.status=${q.status}`,
      )
    if (q.orderNo) clauses.push(Prisma.sql`o."orderNo"=${q.orderNo}`)
    return Prisma.sql`SELECT o.id,jsonb_build_array(o.id,o."orderNo",o."userId",o."merchantId",COALESCE(o."productNameSnapshot",p.name),o."offerNameSnapshot",CASE WHEN o.status='completed' THEN 'delivered' ELSE o.status END,o.price,o."createdAt") payload FROM "Order" o JOIN "Product" p ON p.id=o."productId" WHERE ${Prisma.join(clauses, ' AND ')} ORDER BY o.id LIMIT ${EXPORT_LIMITS.rows + 1}`
  }
  const q = input.filters
  if (q.userId) clauses.push(Prisma.sql`l."userId"=${q.userId}`)
  if (q.type) clauses.push(Prisma.sql`l.type=${q.type}`)
  return Prisma.sql`SELECT l.id,jsonb_build_array(l.id,l."userId",l.type,l.amount,l."balanceAfter",l."orderId",l.reason,l."createdAt") payload FROM "PointLog" l WHERE ${Prisma.join(clauses, ' AND ')} ORDER BY l.id LIMIT ${EXPORT_LIMITS.rows + 1}`
}
export async function materializeExport(job: AdminExportJob) {
  const input = exportInput.parse({ kind: job.kind, filters: job.filters })
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout='30000ms'`
      const owned = await tx.$queryRaw<
        AdminExportJob[]
      >`SELECT * FROM "AdminExportJob" WHERE id=${job.id}::uuid AND "leaseToken"=${job.leaseToken}::uuid AND status='running' AND "leaseUntil">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') FOR UPDATE`
      if (!owned.length) throw Error('EXPORT_LEASE_LOST')
      if (owned[0].snapshotAt) return
      await tx.adminExportRow.deleteMany({ where: { jobId: job.id } })
      await tx.$executeRaw`INSERT INTO "AdminExportRow" ("jobId","rowNumber","payloadSafe") SELECT ${job.id}::uuid,(row_number() OVER (ORDER BY id))::integer,payload FROM (${snapshotSelect(input)}) selected`
      const count = await tx.adminExportRow.count({ where: { jobId: job.id } })
      if (count > EXPORT_LIMITS.rows)
        throw new HttpError(409, 'EXPORT_LIMIT_EXCEEDED', '导出超过行数上限，请缩小范围')
      const now = (
        await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT transaction_timestamp() AT TIME ZONE 'UTC' now`
      )[0].now
      await tx.adminExportJob.update({
        where: { id: job.id, leaseToken: job.leaseToken },
        data: { snapshotAt: now, rowCount: count, phase: 'uploading' },
      })
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 40000 },
  )
}
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  let text = String(value)
  if (/^[=+\-@\x00-\x20\x7f]/.test(text)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}
async function* csvChunks(job: AdminExportJob) {
  yield '\uFEFF' + COLUMNS[job.kind].map(csvCell).join(',') + '\r\n'
  let after = 0
  for (;;) {
    const rows = await prisma.adminExportRow.findMany({
      where: { jobId: job.id, rowNumber: { gt: after } },
      orderBy: { rowNumber: 'asc' },
      take: 1000,
    })
    if (!rows.length) return
    for (const row of rows) yield (row.payloadSafe as unknown[]).map(csvCell).join(',') + '\r\n'
    after = rows.at(-1)!.rowNumber
  }
}
export async function executeExport(job: AdminExportJob) {
  const token = job.leaseToken!
  const signal = new AbortController()
  const timer = setInterval(() => {
    prisma.adminExportJob
      .updateMany({
        where: { id: job.id, leaseToken: token, status: 'running', leaseUntil: { gt: new Date() } },
        data: { leaseUntil: new Date(Date.now() + 90000) },
      })
      .then((r) => {
        if (!r.count) signal.abort(Error('EXPORT_LEASE_LOST'))
      })
      .catch(() => signal.abort(Error('EXPORT_LEASE_LOST')))
  }, 20000)
  timer.unref()
  try {
    await assertExportWorkerAuth(job)
    await materializeExport(job)
    const storage = await writeStorage()
    const key = `admin-exports/${job.id}/${token}.csv`
    const assigned = await prisma.adminExportJob.updateMany({
      where: { id: job.id, leaseToken: token, status: 'running', leaseUntil: { gt: new Date() } },
      data: { providerConfigId: storage.providerConfigId, objectKey: key },
    })
    if (!assigned.count) throw Error('EXPORT_LEASE_LOST')
    const result = await storage.adapter.putStream(
      key,
      Readable.from(csvChunks(job)),
      EXPORT_LIMITS.bytes,
      { signal: signal.signal },
    )
    await assertExportWorkerAuth(job)
    await prisma.$transaction(async (tx) => {
      const completed = await tx.adminExportJob.updateMany({
        where: { id: job.id, leaseToken: token, status: 'running', leaseUntil: { gt: new Date() } },
        data: {
          status: 'succeeded',
          phase: null,
          byteSize: result.size,
          sha256: result.sha256,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + EXPORT_LIMITS.retentionSeconds * 1000),
          leaseToken: null,
          leaseUntil: null,
          errorCode: null,
        },
      })
      if (!completed.count) throw Error('EXPORT_LEASE_LOST')
      await registerStoredObject({
        providerConfigId: storage.providerConfigId,
        bucketRole: 'private',
        objectKey: key,
        size: result.size,
        checksum: result.sha256,
        mimeType: 'text/csv',
        source: 'admin_export',
        client: tx,
      })
      await writeGovernanceAudit(tx, job.requestedByUserId, 'export.succeeded', 'export', null, {
        reasonCode: job.kind,
      })
    })
  } catch (err) {
    const errorCode =
      err instanceof FileTooLargeError
        ? 'EXPORT_LIMIT_EXCEEDED'
        : err instanceof HttpError
          ? err.code
          : err instanceof Error && err.message === 'EXPORT_LEASE_LOST'
            ? 'EXPORT_LEASE_LOST'
            : 'EXPORT_GENERATION_FAILED'
    const terminal =
      err instanceof HttpError || err instanceof FileTooLargeError || job.attempts >= 3
    await prisma.adminExportJob.updateMany({
      where: { id: job.id, leaseToken: token, status: 'running', leaseUntil: { gt: new Date() } },
      data: {
        status: terminal ? 'failed' : 'queued',
        phase: terminal ? null : undefined,
        errorCode,
        leaseUntil: null,
        leaseToken: null,
        nextAttemptAt: new Date(Date.now() + 60000),
        ...(terminal
          ? {
              completedAt: new Date(),
              expiresAt: new Date(Date.now() + EXPORT_LIMITS.retentionSeconds * 1000),
            }
          : {}),
      },
    })
  } finally {
    clearInterval(timer)
  }
}
export async function cleanupExports(now = new Date()) {
  const expired = await prisma.adminExportJob.findMany({
    where: {
      OR: [
        { status: { in: ['succeeded', 'failed'] }, expiresAt: { lte: now } },
        { status: 'expired', OR: [{ objectKey: { not: null } }, { rows: { some: {} } }] },
      ],
    },
    take: 100,
    orderBy: { createdAt: 'asc' },
  })
  let cleaned = 0
  for (const job of expired) {
    try {
      if (job.objectKey) {
        const storage = await getDeliveryStorageForProvider(job.providerConfigId)
        await storage.delete(job.objectKey)
      }
      await prisma.$transaction(async (tx) => {
        if (job.objectKey)
          await tx.storedObject.updateMany({
            where: {
              bucketRole: 'private',
              objectKey: job.objectKey,
              providerRef: providerRefFor(job.providerConfigId),
            },
            data: { status: 'deleted' },
          })
        await tx.adminExportRow.deleteMany({ where: { jobId: job.id } })
        await tx.adminExportJob.update({
          where: { id: job.id },
          data: { status: 'expired', objectKey: null },
        })
      })
      cleaned++
    } catch {
      logger.warn({ jobId: job.id }, 'expired export cleanup failed; retaining task for retry')
    }
  }
  return cleaned
}
