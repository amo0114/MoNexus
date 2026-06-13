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

function displayNameFor(user: { nickname: string | null; email: string }) {
  return user.nickname?.trim() || maskEmail(user.email)
}

// 安全红线：公开接口响应字段白名单，绝不含 email 原文 / userId / orderId。
export async function listProductReviews(productId: number, page = 1, pageSize = 10) {
  const where = { productId, status: 'visible' }
  const [total, rows] = await prisma.$transaction([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        rating: true,
        comment: true,
        editedAt: true,
        createdAt: true,
        user: { select: { nickname: true, email: true } },
      },
    }),
  ])

  return {
    items: rows.map(row => ({
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      editedAt: row.editedAt,
      createdAt: row.createdAt,
      displayName: displayNameFor(row.user),
    })),
    total,
    page,
    pageSize,
  }
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

// 管理端列表：admin 是可信面，允许返回 email/orderId 等公开接口禁止的字段；含 removed 行供运营审计。
export async function listReviewsForAdmin(filters: { productId?: number; page: number; pageSize: number }) {
  const where = filters.productId ? { productId: filters.productId } : {}
  const [total, items] = await prisma.$transaction([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true,
        productId: true,
        orderId: true,
        rating: true,
        comment: true,
        status: true,
        createdAt: true,
        user: { select: { id: true, email: true } },
      },
    }),
  ])
  return { items, total, page: filters.page, pageSize: filters.pageSize }
}

// 软删：status=removed，行保留（审计 + orderId unique 继续占用，删的是违规内容不是重评机会）。
export async function removeReviewByAdmin(adminUserId: number, reviewId: number) {
  return prisma.$transaction(async tx => {
    const review = await tx.review.findUnique({
      where: { id: reviewId },
      select: { id: true, productId: true, status: true },
    })
    if (!review) throw notFound('评价不存在')
    if (review.status === 'removed') throw badRequest('评价已被移除')

    // 与 create/update 保持同一锁序：先持 Product 行锁再写 Review 再重算聚合。
    await lockProductRow(tx, review.productId)

    const updated = await tx.review.updateMany({
      where: { id: reviewId, status: 'visible' },
      data: { status: 'removed' },
    })
    if (updated.count !== 1) throw badRequest('评价已被移除')

    await recalcProductRating(tx, review.productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '移除评价',
        targetType: 'review',
        targetId: review.id,
        detail: `评价 #${review.id}（商品 #${review.productId}）已移除`,
      },
    })
    return { id: review.id, status: 'removed' }
  })
}

export async function updateOrderReview(
  userId: number,
  orderId: number,
  input: { rating: number; comment?: string }
) {
  return prisma.$transaction(async tx => {
    const review = await tx.review.findUnique({
      where: { orderId },
      select: { id: true, userId: true, productId: true, status: true },
    })
    if (!review || review.userId !== userId) throw notFound('评价不存在')
    if (review.status !== 'visible') throw badRequest('评价已被移除，不可修改')

    // 本函数对 Review 是 UPDATE 而非 INSERT，外键不会重新校验（无 KEY SHARE 死锁风险），
    // 但聚合重算仍需持 Product 行锁，且必须在 updateMany 之前取锁以保持全局锁序一致。
    await lockProductRow(tx, review.productId)

    // 禁止 read-then-update：条件 updateMany + 断言行数，保证「只能改一次」在并发下原子成立。
    const updated = await tx.review.updateMany({
      where: {
        orderId,
        userId,
        status: 'visible',
        editedAt: null,
        editableUntil: { gt: new Date() },
      },
      data: {
        rating: input.rating,
        comment: input.comment?.trim() || null,
        editedAt: new Date(),
      },
    })
    if (updated.count !== 1) throw badRequest('评价修改窗口已过或已修改过')

    await recalcProductRating(tx, review.productId)
    return tx.review.findUnique({ where: { orderId } })
  })
}
