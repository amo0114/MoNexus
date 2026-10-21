import { resolvePagination } from '../../lib/pagination.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { onFakaOrderRefundedInTx, scheduleFakaRevokeAttempt } from '../fakaBridge/service.js'
import { serializeAdminOrderDetail, serializeAdminOrderList } from '../orders/serializers.js'
import { transitionOrderStatus } from '../orders/fulfillment.js'
import {
  refundPaidOrder,
  releaseHeldOrder,
  settleHeldOrder,
  voidRefundableSettlement,
} from '../orders/accounting.js'
import { applyRefundInventoryPolicy } from '../orders/refundInventory.js'
import type { ListOrdersQuery, ResolveOrderInput } from './schema.js'

function buildAdminOrderWhere(query: ListOrdersQuery): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {}

  if (query.status) {
    // 历史数据存在 legacy 'completed'，与 delivered 等价
    where.status = query.status === 'delivered' ? { in: ['delivered', 'completed'] } : query.status
  }

  if (query.q) {
    const conditions: Prisma.OrderWhereInput[] = [
      { user: { email: { contains: query.q, mode: 'insensitive' } } },
    ]
    const numeric = Number(query.q)
    if (/^\d+$/.test(query.q) && Number.isSafeInteger(numeric) && numeric > 0) {
      conditions.push({ id: numeric })
    }
    where.OR = conditions
  }

  if (query.fromDate || query.toDate) {
    const createdAtFilter: Prisma.DateTimeFilter = {}
    if (query.fromDate) {
      // 起始日包含：UTC 零点
      createdAtFilter.gte = new Date(`${query.fromDate}T00:00:00.000Z`)
    }
    if (query.toDate) {
      // 结束日次日零点排除：UTC 次日零点
      const nextDay = new Date(`${query.toDate}T00:00:00.000Z`)
      nextDay.setUTCDate(nextDay.getUTCDate() + 1)
      createdAtFilter.lt = nextDay
    }
    where.createdAt = createdAtFilter
  }

  return where
}

export async function listAllOrders(query: ListOrdersQuery = {}) {
  const { page, pageSize } = await resolvePagination(query.page, query.pageSize)
  const where = buildAdminOrderWhere(query)

  const [total, orders] = await prisma.$transaction([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, email: true } },
        merchant: { select: { id: true, name: true } },
        product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, price: true } },
        // P6：仲裁需要订阅到期视角——只选 expiresAt（序列化补 expired），内容仍不出列表。
        delivery: { select: { status: true, expiresAt: true } },
        // P7b：列表徽标需要任务态安全投影（复审 P2：UI 已渲染，select 必须跟上）。
        provisionTask: { select: { status: true, attempts: true, lastError: true, lastHttpStatus: true, nextAttemptAt: true, merchantNotifiedAt: true, updatedAt: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  return { items: orders.map(serializeAdminOrderList), total, page, pageSize }
}

export async function getOrderDetail(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      user: { select: { id: true, email: true } },
      merchant: { select: { id: true, name: true } },
      product: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true,
          imageUrl: true,
          price: true,
          // 仅 id：序列化映射为 product.fakaBridge，原始 link 不进 DTO。
          externalCatalogLink: { select: { id: true } },
        },
      },
      // P6：详情补订阅到期时刻，供仲裁判断交付是否仍在有效期内。
      delivery: { select: { content: true, status: true, expiresAt: true } },
      // P7b：仲裁上下文透出自动开通任务态 + 脱敏诊断码（安全投影）。
      provisionTask: { select: { status: true, attempts: true, lastError: true, lastHttpStatus: true, nextAttemptAt: true, merchantNotifiedAt: true, updatedAt: true } },
      // Xboard/Faka：只投影任务 id，供前端隐藏平台人工履约入口。
      fakaBridgeTask: { select: { id: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return serializeAdminOrderDetail(order)
}

// ---- Order Arbitration ----
//
// PRD §4.3.1：disputed 订单由管理员仲裁，结果为 refunded 时回滚冻结积分到用户余额，
// Settlement 设为 voided；结果为 close 时扣减冻结积分，Settlement 从 holding 转为 pending。
export async function resolveOrder(
  adminUserId: number,
  orderId: number,
  input: ResolveOrderInput
) {
  await prisma.$transaction(async tx => {
    // 复审二 P1：事务起点先锁订单行，再读取校验。仲裁退款此前的写序是
    // Offer/Product（回补策略）→ Order（状态迁移），而续费下单是 Order
    // （原单 FOR UPDATE）→ Offer/Product（销量/库存）——disputed 的订阅
    // 原单仍可续费，两条路径并发即 Order↔Offer 循环等待死锁。统一为
    // "先锁 Order 再碰 Offer/Product"后，续费与仲裁在原单行上串行化。
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        userId: true,
        price: true,
        holdingPoints: true,
        fundsHeld: true,
        // P5.5 T4：退款回补策略需要的履约快照与归属字段。
        productId: true,
        offerId: true,
        merchantId: true,
        deliveryModeSnapshot: true,
      },
    })
    if (!order) throw notFound('订单不存在')
    if (order.status !== 'disputed') throw badRequest('仅争议中的订单可仲裁')

    const toStatus = input.result === 'refund' ? 'refunded' : 'closed'
    const action = input.result === 'refund' ? 'admin.resolve.refund' : 'admin.resolve.close'
    const publicNote = input.result === 'refund'
      ? '管理员仲裁：退款，积分已退还'
      : '管理员仲裁：关闭，积分已扣减'

    // Claim any unsettled merchant amount before changing the order state.  A
    // pending settlement cannot race ahead and be paid after a refund.
    if (input.result === 'refund') {
      await voidRefundableSettlement(tx, order.id)
      // P5.5 T4：仲裁退款的库存侧效果与积分退还/结算作废同事务——已交付
      // （disputed 只能来自 delivered）：卡密报废、销量净减、不回补容量。
      await applyRefundInventoryPolicy(tx, order, {
        fromStatus: 'disputed',
        actorUserId: adminUserId,
      })
    }

    await transitionOrderStatus(
      {
        orderId,
        toStatus,
        actorRole: 'admin',
        actorUserId: adminUserId,
        action,
        publicNote: input.note ? `${publicNote}（${input.note}）` : publicNote,
        internalNote: input.note,
      },
      tx
    )

    if (input.result === 'refund') {
      if (order.holdingPoints != null && order.holdingPoints > 0) {
        await releaseHeldOrder(tx, order, `管理员仲裁释放冻结积分: #${order.id}`)
      } else {
        await refundPaidOrder(tx, order, `管理员仲裁退款: #${order.id}`)
      }
      // FakaBridge：取消未开通任务 / 排队撤销已开通 Xboard 订阅
      await onFakaOrderRefundedInTx(tx, orderId)
    } else {
      await settleHeldOrder(tx, order, `管理员仲裁扣款: #${order.id}`)
      await tx.order.update({
        where: { id: orderId },
        data: { confirmedAt: new Date() },
      })
    }

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: input.result === 'refund' ? '仲裁退款' : '仲裁关闭',
        targetType: 'order',
        targetId: orderId,
        detail: input.note ? `仲裁结果: ${input.result}，备注: ${input.note}` : `仲裁结果: ${input.result}`,
      },
    })
  })

  // Kick revoke worker outside the transaction
  if (input.result === 'refund') {
    const task = await prisma.fakaBridgeTask.findUnique({
      where: { orderId },
      select: { id: true, revokeStatus: true },
    })
    if (task?.revokeStatus === 'pending') {
      scheduleFakaRevokeAttempt(task.id)
    }
  }

  return getOrderDetail(orderId)
}
