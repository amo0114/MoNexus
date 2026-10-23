import type { Prisma } from '@prisma/client'
import { badRequest } from './httpError.js'
import { logInventoryChange } from './inventoryLog.js'
import { syncProductProjection } from './offers.js'

/**
 * capacity 调整核心（T-CAT-BE-004）：CAS 条件 decrement 保证并发减少永不为负
 * （AC-CAT-007）。即时库存只能 import/void，非即时 limited 只能 capacity（动作互斥）。
 * 商家与管理端（平台自营，merchantId=null）共用，调用方负责归属校验与缓存失效。
 */
export async function adjustOfferCapacity(
  tx: Prisma.TransactionClient,
  productId: number,
  offer: { id: number; deliveryMode: string; stockMode: string },
  merchantId: number | null,
  actorUserId: number,
  input: { delta: number; reason: string }
) {
  if (offer.deliveryMode === 'instant_inventory') {
    throw badRequest('即时库存商品请通过交付库存导入或作废管理')
  }
  if (offer.stockMode !== 'limited') {
    throw badRequest('不限量商品无需调整可售名额')
  }

  if (input.delta > 0) {
    const updated = await tx.offer.updateMany({
      where: {
        id: offer.id,
        stockMode: 'limited',
        deliveryMode: { not: 'instant_inventory' },
      },
      data: { stock: { increment: input.delta } },
    })
    if (updated.count !== 1) throw badRequest('商品库存模式已变更，请刷新后重试')
  } else {
    const updated = await tx.offer.updateMany({
      where: {
        id: offer.id,
        stockMode: 'limited',
        deliveryMode: { not: 'instant_inventory' },
        stock: { gte: -input.delta },
      },
      data: { stock: { decrement: -input.delta } },
    })
    if (updated.count !== 1) throw badRequest('减少数量不能超过当前可售名额')
  }

  await syncProductProjection(tx, productId)
  const updatedOffer = await tx.offer.findUniqueOrThrow({
    where: { id: offer.id },
    select: { stock: true },
  })
  await logInventoryChange(tx, {
    productId,
    offerId: offer.id,
    merchantId,
    actorUserId,
    action: 'capacity_adjust',
    delta: input.delta,
    reason: input.reason,
  })
  return { stock: updatedOffer.stock }
}
