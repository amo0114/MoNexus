import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, conflict } from '../../lib/httpError.js'
import { normalizeOrderStatus } from '../orders/fulfillment.js'

const EDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function maskEmail(email: string) {
  const [local, domain] = email.split('@')
  const keep = local.length <= 2 ? 1 : 2
  return `${local.slice(0, keep)}***@${domain}`
}

// 必须先锁 Product 行再重算：Read Committed 下不锁行的并发评价会各自读旧明细互相覆盖聚合。
// 调用方必须在 INSERT Review 之前就持有该锁（见 lockProductRow）：Review→Product 外键校验会对
// Product 行加 FOR KEY SHARE，若先 INSERT 再 FOR UPDATE，两个并发事务会互等对方的 KEY SHARE 而死锁。
async function lockProductRow(tx: Prisma.TransactionClient, productId: number) {
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`
}

async function recalcProductRating(tx: Prisma.TransactionClient, productId: number) {
  const agg = await tx.review.aggregate({
    where: { productId, status: 'visible' },
    _avg: { rating: true },
    _count: { _all: true },
  })
  const count = agg._count._all
  const avg = count > 0 ? Math.round((agg._avg.rating ?? 0) * 10) / 10 : 0
  await tx.product.update({
    where: { id: productId },
    data: { ratingAvg: avg, ratingCount: count },
  })
}

const REVIEWABLE_STATUSES = new Set(['delivered', 'closed'])

export async function createOrderReview(
  userId: number,
  orderId: number,
  input: { rating: number; comment?: string }
) {
  return prisma.$transaction(async tx => {
    const order = await tx.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, productId: true, status: true },
    })
    if (!order) throw notFound('订单不存在')
    if (!REVIEWABLE_STATUSES.has(normalizeOrderStatus(order.status))) {
      throw badRequest('订单当前状态不可评价')
    }

    await lockProductRow(tx, order.productId)

    let review
    try {
      review = await tx.review.create({
        data: {
          productId: order.productId,
          userId,
          orderId,
          rating: input.rating,
          comment: input.comment?.trim() || null,
          editableUntil: new Date(Date.now() + EDIT_WINDOW_MS),
        },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('该订单已评价')
      }
      throw err
    }

    await recalcProductRating(tx, order.productId)
    return review
  })
}
