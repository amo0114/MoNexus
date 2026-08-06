import { prisma } from '../prisma.js'
import type { Prisma } from '@prisma/client'

export type BucketRole = 'public' | 'private'
export type StoredObjectSource = 'upload_image' | 'delivery_file'

export function providerRefFor(providerConfigId: number | null | undefined): string {
  return providerConfigId == null ? 'env' : String(providerConfigId)
}

export async function registerStoredObject(input: {
  providerConfigId: number | null
  bucketRole: BucketRole
  objectKey: string
  size?: number
  checksum?: string
  mimeType?: string
  source?: StoredObjectSource
  sourceId?: number
  client?: Prisma.TransactionClient | typeof prisma
}) {
  const db = input.client ?? prisma
  const providerRef = providerRefFor(input.providerConfigId)
  return db.storedObject.upsert({
    where: {
      bucketRole_objectKey_providerRef: {
        bucketRole: input.bucketRole,
        objectKey: input.objectKey,
        providerRef,
      },
    },
    create: {
      providerConfigId: input.providerConfigId,
      providerRef,
      bucketRole: input.bucketRole,
      objectKey: input.objectKey,
      size: input.size,
      checksum: input.checksum,
      mimeType: input.mimeType,
      source: input.source,
      sourceId: input.sourceId,
      status: 'active',
    },
    update: {
      providerConfigId: input.providerConfigId,
      size: input.size,
      checksum: input.checksum,
      mimeType: input.mimeType,
      source: input.source,
      sourceId: input.sourceId,
      status: 'active',
    },
  })
}

export async function findStoredObject(bucketRole: BucketRole, objectKey: string) {
  return prisma.storedObject.findFirst({
    where: { bucketRole, objectKey, status: 'active' },
    orderBy: { id: 'desc' },
  })
}
