/** Real private S3 export verification. Uses only a disposable governance rehearsal DB
 * and loopback MinIO. Build server first; never point this at production. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { S3Client, CreateBucketCommand, DeleteBucketCommand } from '@aws-sdk/client-s3'

const database = new URL(process.env.DATABASE_URL ?? '')
const endpoint = process.env.INT_ENDPOINT ?? 'http://127.0.0.1:19390'
if (
  process.env.NODE_ENV !== 'test' ||
  !database.pathname.endsWith('_governance_rehearsal') ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)
)
  throw Error('isolated_governance_storage_required')

const credentials = {
  accessKeyId: process.env.INT_ACCESS_KEY ?? 'governance-test',
  secretAccessKey: process.env.INT_SECRET_KEY ?? 'governance-test-secret',
}
const client = new S3Client({ endpoint, region: 'us-east-1', credentials, forcePathStyle: true })
const { prisma } = await import('../dist/lib/prisma.js')
const { encryptStorageCredentials } = await import('../dist/lib/storage/credentialsCrypto.js')
const { invalidateStorageRuntimeCache } = await import('../dist/lib/storage/runtime.js')
const {
  createExport,
  claimExport,
  materializeExport,
  executeExport,
  downloadExport,
  cleanupExports,
} = await import('../dist/modules/adminExports/service.js')
const { cleanupUnreferencedObjects } = await import('../dist/lib/fileCleanup.js')
const suffix = randomUUID().slice(0, 8)
const buckets = [`gov-export-old-${suffix}`, `gov-export-new-${suffix}`]
const previous = await prisma.storageRuntime.findUnique({ where: { id: 1 } })
const providerIds = []
let actor, jobId
try {
  for (const bucket of buckets) await client.send(new CreateBucketCommand({ Bucket: bucket }))
  actor = await prisma.user.create({
    data: {
      email: `storage-${suffix}@example.test`,
      password: 'unusable-test-hash',
      nickname: 'snapshot-before',
      role: 'admin',
      status: 'active',
      mfaEnabled: true,
    },
  })
  await prisma.adminAuthorization.create({ data: { userId: actor.id, tier: 'super' } })
  const session = await prisma.refreshToken.create({
    data: {
      userId: actor.id,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
    },
  })
  const encrypted = encryptStorageCredentials({
    accessKey: credentials.accessKeyId,
    secretKey: credentials.secretAccessKey,
  })
  for (const bucket of buckets) {
    const provider = await prisma.storageProviderConfig.create({
      data: {
        type: 's3_compatible',
        name: bucket,
        status: 'verified',
        credentialsCiphertext: encrypted.ciphertext,
        credentialsKeyVersion: encrypted.keyVersion,
        publicConfig: {
          endpoint,
          region: 'us-east-1',
          publicBucket: bucket,
          privateBucket: bucket,
          forcePathStyle: true,
        },
      },
    })
    providerIds.push(provider.id)
  }
  const activate = async (id) => {
    await prisma.$transaction(async (tx) => {
      await tx.storageProviderConfig.updateMany({
        where: { status: 'active' },
        data: { status: 'disabled' },
      })
      await tx.storageProviderConfig.update({ where: { id }, data: { status: 'active' } })
      await tx.storageRuntime.upsert({
        where: { id: 1 },
        create: { id: 1, activeConfigId: id, configVersion: 1 },
        update: { activeConfigId: id, configVersion: { increment: 1 } },
      })
    })
    invalidateStorageRuntimeCache()
  }
  await activate(providerIds[0])
  const created = await createExport(
    {
      userId: actor.id,
      role: 'admin',
      sid: session.sessionId,
      mfaVerified: true,
      mfaVersion: actor.mfaVersion,
    },
    `storage:${suffix}`,
    {
      kind: 'users',
      filters: { q: String(actor.id) },
    },
  )
  jobId = created.id
  const claimed = await claimExport()
  assert.equal(claimed?.id, jobId, 'rehearsal DB must have no other pending exports')
  await materializeExport(claimed)
  await prisma.user.update({
    where: { id: actor.id },
    data: { nickname: 'changed-after-snapshot' },
  })
  await executeExport(claimed)
  const job = await prisma.adminExportJob.findUniqueOrThrow({ where: { id: jobId } })
  assert.equal(job.status, 'succeeded')
  assert.equal(job.providerConfigId, providerIds[0])
  assert.equal((await fetch(`${endpoint}/${buckets[0]}/${job.objectKey}`)).status, 403)
  await activate(providerIds[1])
  await prisma.storageProviderConfig.update({
    where: { id: providerIds[0] },
    data: { status: 'disabled' },
  })
  const download = await downloadExport(actor.id, jobId)
  assert.match(new URL(download.url).pathname, new RegExp(`^/${buckets[0]}/`))
  assert.ok(Number(new URL(download.url).searchParams.get('X-Amz-Expires')) <= 60)
  const response = await fetch(download.url)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment/)
  const csv = await response.text()
  assert.match(csv, /snapshot-before/)
  assert.doesNotMatch(csv, /changed-after-snapshot/)
  await prisma.adminExportJob.update({
    where: { id: jobId },
    data: { expiresAt: new Date(Date.now() + 48 * 3600000) },
  })
  await cleanupUnreferencedObjects(new Date(Date.now() + 25 * 3600000))
  assert.equal((await fetch((await downloadExport(actor.id, jobId)).url)).status, 200)
  await prisma.adminExportJob.update({
    where: { id: jobId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  await assert.rejects(downloadExport(actor.id, jobId), { code: 'EXPORT_EXPIRED' })
  await cleanupExports()
  assert.equal(await prisma.adminExportRow.count({ where: { jobId } }), 0)
  assert.equal(
    (await prisma.adminExportJob.findUniqueOrThrow({ where: { id: jobId } })).status,
    'expired',
  )
  assert.equal((await fetch(download.url)).status, 404)
  console.log(
    'PASS: real MinIO private export, immutable snapshot, bound historical provider, live GC retention, short signed download and expiry cleanup',
  )
} finally {
  await prisma.storageProviderConfig.updateMany({
    where: { id: { in: providerIds } },
    data: { status: 'disabled' },
  })
  if (previous?.activeConfigId)
    await prisma.storageProviderConfig.update({
      where: { id: previous.activeConfigId },
      data: { status: 'active' },
    })
  if (previous)
    await prisma.storageRuntime.update({
      where: { id: 1 },
      data: { activeConfigId: previous.activeConfigId, configVersion: { increment: 1 } },
    })
  else await prisma.storageRuntime.deleteMany({ where: { id: 1 } })
  invalidateStorageRuntimeCache()
  if (jobId) {
    await prisma.adminExportRow.deleteMany({ where: { jobId } })
    await prisma.adminExportJob.deleteMany({ where: { id: jobId } })
  }
  if (actor) {
    await prisma.adminCommandReceipt.deleteMany({ where: { actorUserId: actor.id } })
    await prisma.adminLog.deleteMany({ where: { adminUserId: actor.id } })
    await prisma.refreshToken.deleteMany({ where: { userId: actor.id } })
    await prisma.adminAuthorization.deleteMany({ where: { userId: actor.id } })
    await prisma.user.delete({ where: { id: actor.id } })
  }
  await prisma.storedObject.deleteMany({ where: { providerConfigId: { in: providerIds } } })
  await prisma.storageProviderConfig.deleteMany({ where: { id: { in: providerIds } } })
  for (const bucket of buckets) {
    try {
      await client.send(new DeleteBucketCommand({ Bucket: bucket }))
    } catch {
      /* Preserve failed verification objects for diagnosis. */
    }
  }
  client.destroy()
  await prisma.$disconnect()
}
