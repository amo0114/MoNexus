import type { Prisma } from '@prisma/client'

// `InventoryLog` is shared by per-recipient delivery inventory and the
// manually managed quantity used by limited fixed/manual products.  A
// capacity adjustment never touches an InventoryItem, but it must still be
// attributable to an operator and a stated reason.
export type InventoryLogAction = 'import' | 'void' | 'sale' | 'capacity_adjust'

export interface InventoryLogInput {
  productId: number
  merchantId?: number | null
  actorUserId: number
  action: InventoryLogAction
  delta: number
  reason?: string | null
  orderId?: number | null
  batchId?: string | null
}

/**
 * 在调用方的事务内写入一条库存流水。
 *
 * 约定：delta 为整数且非零。即时库存的 import/void 与 InventoryItem
 * 状态变更处于同一事务；限量固定内容/人工服务的 capacity_adjust 与
 * Product.stock（可售/服务名额）变更处于同一事务。
 */
export async function logInventoryChange(
  tx: Prisma.TransactionClient,
  input: InventoryLogInput
) {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new Error('InventoryLog delta 必须是非零整数')
  }
  if (input.action === 'sale' && (input.delta !== -1 || !input.orderId)) {
    throw new Error('sale 库存流水必须关联订单且数量为 -1')
  }
  if (input.action !== 'sale' && input.orderId != null) {
    throw new Error('只有 sale 库存流水可以关联订单')
  }
  if (input.action === 'import' && !input.batchId) {
    throw new Error('import 库存流水必须关联导入批次')
  }
  if (input.action !== 'import' && input.batchId != null) {
    throw new Error('只有 import 库存流水可以关联导入批次')
  }

  return tx.inventoryLog.create({
    data: {
      productId: input.productId,
      merchantId: input.merchantId ?? null,
      actorUserId: input.actorUserId,
      action: input.action,
      delta: input.delta,
      reason: input.reason ?? null,
      orderId: input.orderId ?? null,
      batchId: input.batchId ?? null,
    },
  })
}
