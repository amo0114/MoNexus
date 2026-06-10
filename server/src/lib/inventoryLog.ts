import type { Prisma } from '@prisma/client'

export type InventoryLogAction = 'import' | 'void'

export interface InventoryLogInput {
  productId: number
  merchantId?: number | null
  actorUserId: number
  action: InventoryLogAction
  delta: number
  reason?: string | null
}

/**
 * 在调用方的事务内写入一条库存流水。
 *
 * 约定：delta 为整数，导入为正、作废为负；必须与库存变更
 * （InventoryItem 状态翻转 + Product.stock 增减）处于同一事务，
 * 保证流水与库存永远一致。merchant 导入/作废与 admin 补货共用。
 */
export async function logInventoryChange(
  tx: Prisma.TransactionClient,
  input: InventoryLogInput
) {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new Error('InventoryLog delta 必须是非零整数')
  }

  return tx.inventoryLog.create({
    data: {
      productId: input.productId,
      merchantId: input.merchantId ?? null,
      actorUserId: input.actorUserId,
      action: input.action,
      delta: input.delta,
      reason: input.reason ?? null,
    },
  })
}
