import type { Prisma } from '@prisma/client'
import { assertOwnedActiveDeliveryFile } from '../catalog/deliveryFileOwnership.js'

/**
 * P5：校验规格挂载的交付文件可用。归属别家 → 404（防枚举，与"文件不存在"
 * 不可区分）；revoked/deleted → 400（吊销即停售）。
 */
export async function assertMyDeliveryFile(tx: Pick<Prisma.TransactionClient, 'deliveryFile'>, merchantId: number, fileId: number) {
  return assertOwnedActiveDeliveryFile(tx, { kind: 'merchant', merchantId }, fileId)
}
