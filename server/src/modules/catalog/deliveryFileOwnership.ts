import type { Prisma } from '@prisma/client'
import { badRequest, notFound } from '../../lib/httpError.js'

type DeliveryFileDb = Pick<Prisma.TransactionClient, 'deliveryFile' | '$queryRaw'>

export type DeliveryFileActor =
  | { kind: 'merchant'; merchantId: number }
  | { kind: 'admin' }

/**
 * Ownership and availability for offer binding and order delivery attachments.
 * Merchant files must match actor.merchantId; admin files must be platform-owned
 * (merchantId null). Other-merchant / missing → 404 (no enumeration);
 * revoked/deleted → 400.
 */
export async function assertOwnedActiveDeliveryFile(
  tx: DeliveryFileDb,
  actor: DeliveryFileActor,
  fileId: number,
): Promise<void> {
  // Serialize binding with lifecycle GC/revocation; re-read status after waiting.
  await tx.$queryRaw`SELECT id FROM "DeliveryFile" WHERE id=${fileId} FOR SHARE`
  const file = await tx.deliveryFile.findFirst({
    where: actor.kind === 'merchant'
      ? { id: fileId, merchantId: actor.merchantId }
      : { id: fileId, merchantId: null },
    select: { status: true },
  })
  if (!file) throw notFound('交付文件不存在')
  if (file.status !== 'active') throw badRequest('交付文件已不可用，请重新上传')
}
