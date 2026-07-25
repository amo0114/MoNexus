import { prisma } from '../../lib/prisma.js'
import { notFound, badRequest } from '../../lib/httpError.js'
import { getProductFulfillmentMode } from '../orders/fulfillment.js'

export type CheckoutPreview = {
  productId: number
  productName: string
  price: number
  deliveryMode: string
  // debit = 即时扣除；hold = 冻结，商家履约后扣除，拒单/退款返还
  chargeType: 'debit' | 'hold'
  balanceBefore: number
  balanceAfter: number
  sufficient: boolean
  // 与下单事务同一套前置校验的只读镜像：售罄、商家不可用、固定内容缺失
  // 在预览阶段就暴露出来，避免用户看到"可支付"后才在确认时失败。
  purchasable: boolean
  unpurchasableReason?: string
}

/**
 * Read-only checkout quote. Creates nothing and locks nothing; the order
 * transaction re-validates price, stock and balance atomically at confirm
 * time. Balance figures use the same "available balance" ledger the debit /
 * hold paths operate on (PointAccount.balance excludes frozenBalance).
 */
export async function getCheckoutPreview(userId: number, productId: number): Promise<CheckoutPreview> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      price: true,
      status: true,
      deliveryMode: true,
      stockMode: true,
      stock: true,
      fixedContent: true,
      merchant: { select: { status: true } },
    },
  })
  if (!product) throw notFound('商品不存在')
  if (product.status !== 'active') throw badRequest('商品已下架')

  const account = await prisma.pointAccount.findUnique({ where: { userId } })
  if (!account) throw notFound('积分账户不存在')

  const deliveryMode = getProductFulfillmentMode(product.deliveryMode)

  // 与 createOrder 事务内前置校验一致的顺序与文案（只读版本，无锁）。
  let unpurchasableReason: string | undefined
  if (product.merchant && product.merchant.status !== 'active') {
    unpurchasableReason = '商家暂不可用'
  } else if (deliveryMode === 'instant_fixed' && !product.fixedContent) {
    unpurchasableReason = '商品暂不可购买，请联系商家'
  } else if (deliveryMode === 'instant_inventory') {
    const available = await prisma.inventoryItem.count({
      where: { productId: product.id, status: 'available' },
    })
    if (available <= 0) unpurchasableReason = '库存不足，请稍后再试'
  } else if (product.stockMode === 'limited' && product.stock <= 0) {
    unpurchasableReason = '库存不足，请稍后再试'
  }

  return {
    productId: product.id,
    productName: product.name,
    price: product.price,
    deliveryMode,
    chargeType: deliveryMode === 'manual_service' ? 'hold' : 'debit',
    balanceBefore: account.balance,
    // 余额不足时仍返回预览（差额为负），前端据此禁用按钮并提示缺口。
    balanceAfter: account.balance - product.price,
    sufficient: account.balance >= product.price,
    purchasable: unpurchasableReason == null,
    unpurchasableReason,
  }
}
