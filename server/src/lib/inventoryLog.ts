import type { Prisma } from '@prisma/client'

// `InventoryLog` is shared by per-recipient delivery inventory and the
// manually managed quantity used by limited fixed/manual products.  A
// capacity adjustment never touches an InventoryItem, but it must still be
// attributable to an operator and a stated reason.
export type InventoryLogAction =
  | 'import'
  | 'void'
  | 'sale'
  | 'capacity_adjust'
  // P5.5 退款流水：refund_void = 已售卡密报废（可用量不变，delta 0）；
  // refund_restock = 未交付人工单回补有限容量（delta +1）。两者都挂订单，
  // 与该订单的 sale 行并存（orderId 已从唯一降级为普通索引）。
  | 'refund_void'
  | 'refund_restock'

/** 必须关联订单的动作（数据库 CHECK 同词表）。 */
const ORDER_LINKED_ACTIONS: ReadonlySet<InventoryLogAction> = new Set([
  'sale',
  'refund_void',
  'refund_restock',
])

export interface InventoryLogInput {
  productId: number
  // 变更发生在哪个 SKU（P4a 审计维度；可空兼容迁移前调用方）。
  offerId?: number | null
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
  // refund_void 是唯一允许 delta = 0 的动作：报废已售卡密不改变可用量。
  if (!Number.isInteger(input.delta) || (input.delta === 0 && input.action !== 'refund_void')) {
    throw new Error('InventoryLog delta 必须是非零整数')
  }
  if (input.action === 'sale' && input.delta !== -1) {
    throw new Error('sale 库存流水数量必须为 -1')
  }
  if (input.action === 'refund_void' && input.delta !== 0) {
    throw new Error('refund_void 库存流水数量必须为 0')
  }
  if (input.action === 'refund_restock' && input.delta !== 1) {
    throw new Error('refund_restock 库存流水数量必须为 +1')
  }
  if (ORDER_LINKED_ACTIONS.has(input.action) && !input.orderId) {
    throw new Error(`${input.action} 库存流水必须关联订单`)
  }
  if (!ORDER_LINKED_ACTIONS.has(input.action) && input.orderId != null) {
    throw new Error('只有 sale/refund_void/refund_restock 库存流水可以关联订单')
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
      offerId: input.offerId ?? null,
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
