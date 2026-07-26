import type { Prisma } from '@prisma/client'
import { logInventoryChange } from '../../lib/inventoryLog.js'

// 退款回补策略输入：两条退款路径（管理员仲裁 disputed→refunded、商家拒单
// pending→refunded）在各自的退款事务内传入订单快照字段。
export interface RefundInventoryOrder {
  id: number
  productId: number
  offerId: number | null
  merchantId: number | null
  deliveryModeSnapshot: string | null
}

export interface RefundInventoryOptions {
  // 退款前的订单状态决定"是否已交付"：pending = 未交付（可回补容量），
  // disputed = 已交付后争议（容量视为已消耗）。
  fromStatus: 'pending' | 'disputed'
  actorUserId: number
}

/**
 * P5.5 T4：退款回补库存策略（评审通过的策略矩阵），必须在退款事务内调用，
 * 与积分退还 / 结算作废原子生效。
 *
 * - 所有退款：Offer.sales / Product.sales 各 -1（公开销量口径为净成交；
 *   带 sales > 0 防负，兼容历史脏数据，计数为 0 时静默跳过不抛错）。
 * - instant_inventory：关联卡密 sold → void 并记 refund_void（delta 0）。
 *   内容交付即泄密，绝不回到 available；无关联条目或已 void（历史回填）
 *   时跳过，保证幂等。
 * - manual_service 且退款前为 pending（商家拒单，尚未交付）：限量规格回补
 *   容量 Offer.stock +1 / Product.stock +1，记 refund_restock（delta +1）。
 * - instant_fixed / manual_service 已交付后争议（disputed）：不回补——固定
 *   内容已泄露、已消耗的服务名额不复活。
 * - 快照为空的迁移前历史订单：保守处理，只做销量净减，不回补、不报废
 *   （无法可靠判定履约形态，宁少补不错补）。
 */
export async function applyRefundInventoryPolicy(
  tx: Prisma.TransactionClient,
  order: RefundInventoryOrder,
  opts: RefundInventoryOptions
): Promise<void> {
  // 1) 销量净值：退款单从公开销量计数器中扣除。updateMany + gt: 0 防负——
  //    历史回填前产生的脏数据可能已经是 0，此时静默跳过而非抛错回滚退款。
  if (order.offerId != null) {
    await tx.offer.updateMany({
      where: { id: order.offerId, sales: { gt: 0 } },
      data: { sales: { decrement: 1 } },
    })
  }
  await tx.product.updateMany({
    where: { id: order.productId, sales: { gt: 0 } },
    data: { sales: { decrement: 1 } },
  })

  const mode = order.deliveryModeSnapshot

  if (mode === 'instant_inventory') {
    // 2) 已售卡密报废：orderId 在 InventoryItem 上唯一，按订单反查本单领取的
    //    条目。仅 sold → void（可用量不变，delta 0）；条目缺失或已被历史迁移
    //    回填为 void 时直接跳过——重复仲裁本身被状态机拦截，这里只兜底幂等。
    const item = await tx.inventoryItem.findUnique({
      where: { orderId: order.id },
      select: { id: true, status: true, offerId: true },
    })
    if (item && item.status === 'sold') {
      await tx.inventoryItem.update({
        where: { id: item.id },
        data: { status: 'void' },
      })
      await logInventoryChange(tx, {
        productId: order.productId,
        // 条目自身的 offerId 是领取时的真相；历史单 Order.offerId 可能为空。
        offerId: item.offerId,
        merchantId: order.merchantId,
        actorUserId: opts.actorUserId,
        action: 'refund_void',
        delta: 0,
        orderId: order.id,
        reason: '退款报废已售卡密（不回补可用库存）',
      })
    }
    return
  }

  if (mode === 'manual_service' && opts.fromStatus === 'pending') {
    // 3) 未交付的人工服务单：商家拒单时服务名额未被消耗，限量规格回补容量
    //    （镜像下单时的 Offer/Product stock 同事务扣减）。offerId 为空的历史
    //    单无从定位规格容量，只做销量净减。
    if (order.offerId == null) return
    const offer = await tx.offer.findUnique({
      where: { id: order.offerId },
      select: { id: true, stockMode: true },
    })
    if (!offer || offer.stockMode !== 'limited') return

    await tx.offer.update({
      where: { id: offer.id },
      data: { stock: { increment: 1 } },
    })
    await tx.product.update({
      where: { id: order.productId },
      data: { stock: { increment: 1 } },
    })
    await logInventoryChange(tx, {
      productId: order.productId,
      offerId: offer.id,
      merchantId: order.merchantId,
      actorUserId: opts.actorUserId,
      action: 'refund_restock',
      delta: 1,
      orderId: order.id,
      reason: '商家拒单回补未交付服务名额',
    })
  }

  // 4) instant_fixed / manual_service 已交付后争议 / 快照为空的历史订单：
  //    不回补（固定内容已泄露、已消耗名额不复活、历史形态无法判定）。
}
