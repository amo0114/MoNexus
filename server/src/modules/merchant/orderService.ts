import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, HttpError } from '../../lib/httpError.js'
import { createOrderStatusEvent, transitionOrderStatus } from '../orders/fulfillment.js'
import { isInstantMode, normalizeOrderStatus, type FulfillmentOrderStatus } from '../orders/statusPolicy.js'
import { releaseHeldOrder, settleHeldOrder } from '../orders/accounting.js'
import { applyRefundInventoryPolicy } from '../orders/refundInventory.js'
import { serializeMerchantOrder } from '../orders/serializers.js'
import { canonicalDeliveryText, parseStoredDeliveryFields, validateDeliveryValues, type StructuredDeliveryContent } from '../../lib/deliveryFields.js'
import { onFakaOrderRefundedInTx } from '../fakaBridge/service.js'
import { assertMyDeliveryFile } from './deliveryFilePolicy.js'
import type { MerchantOrderListQuery } from './schema.js'

// ---- Orders ----

function endOfDate(date: string) {
  const end = new Date(`${date}T00:00:00.000Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  return end
}

function getDateRange(query: MerchantOrderListQuery) {
  if (!query.dateFrom && !query.dateTo) return undefined

  return {
    ...(query.dateFrom ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) } : {}),
    ...(query.dateTo ? { lt: endOfDate(query.dateTo) } : {}),
  }
}

function getOrderStatusWhere(status?: FulfillmentOrderStatus) {
  if (!status) return undefined
  return status === 'delivered' ? { in: ['delivered', 'completed'] } : status
}

function buildOrderWhere(merchantId: number, query: MerchantOrderListQuery): Prisma.OrderWhereInput {
  return {
    merchantId,
    ...(query.status ? { status: getOrderStatusWhere(query.status) } : {}),
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.dateFrom || query.dateTo ? { createdAt: getDateRange(query) } : {}),
    ...(query.q
      ? {
          OR: [
            { product: { name: { contains: query.q, mode: 'insensitive' } } },
            { user: { email: { contains: query.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }
}

function getOrderDeliveryMode(order: {
  deliveryModeSnapshot?: string | null
  product?: { deliveryMode?: string | null } | null
}) {
  // 迁移前的历史订单在快照字段为空时仍按原商品模式工作；新订单始终使用快照。
  return order.deliveryModeSnapshot ?? order.product?.deliveryMode
}

function getAvailableActions(order: {
  status: string
  deliveryModeSnapshot?: string | null
  product?: { deliveryMode?: string | null } | null
}) {
  const status = normalizeOrderStatus(order.status)
  const deliveryMode = getOrderDeliveryMode(order)

  // pending 状态下商家可接单（start_fulfillment）或拒单（reject）；
  // 拒单只对 manual_service 有意义，但即时模式创建即 delivered 不会进入 pending
  if (status === 'pending') return ['start_fulfillment', 'reject']
  // P6b：履约中的人工服务单可交付，也可发进度更新（post_progress 不改状态）
  if (status === 'processing' && deliveryMode === 'manual_service') return ['deliver', 'post_progress']
  if (status === 'disputed') return ['respond_dispute']
  return []
}

function computeSlaExceeded(order: {
  status?: string
  fulfillmentDeadline?: Date | null
}): boolean {
  if (!order.fulfillmentDeadline) return false
  const status = order.status ? normalizeOrderStatus(order.status) : null
  if (status !== 'pending' && status !== 'processing') return false
  return order.fulfillmentDeadline.getTime() < Date.now()
}

export async function listMyOrders(merchantId: number, query: MerchantOrderListQuery) {
  const where = buildOrderWhere(merchantId, query)
  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, email: true } },
        product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, price: true, deliveryMode: true } },
        delivery: { select: { status: true, publicNote: true, deliveredAt: true } },
        settlement: { select: { settlementAmount: true, status: true, settledAt: true } },
        // P7b：任务态徽标（开通中/已自动交付/已降级人工 + 脱敏诊断码）。
        provisionTask: { select: { status: true, attempts: true, lastError: true, lastHttpStatus: true, nextAttemptAt: true, merchantNotifiedAt: true, updatedAt: true } },
      },
      // P6c：sort=booking 时预约日期升序（最近的预约最先处理），无预约单
      // （bookingDate=null）排后并沿用默认时间倒序；命中 (merchantId, bookingDate) 索引。
      orderBy: query.sort === 'booking'
        ? [{ bookingDate: { sort: 'asc', nulls: 'last' } as const }, { createdAt: 'desc' as const }]
        : { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.order.count({ where }),
  ])

  return {
    items: items.map(order => ({
      ...serializeMerchantOrder(order),
      holdingPoints: order.holdingPoints,
      fulfillmentDeadline: order.fulfillmentDeadline,
      // P6c：预约日期（null = 非预约单）；列表/详情均透出供商家排期。
      bookingDate: order.bookingDate,
      slaExceeded: computeSlaExceeded(order),
      availableActions: getAvailableActions(order),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  }
}

export async function getMyOrderDetail(merchantId: number, orderId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, merchantId },
    include: {
      user: { select: { id: true, email: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, price: true, deliveryMode: true } },
      delivery: {
        select: {
          status: true, publicNote: true, deliveredAt: true,
          // P6a：订阅到期时刻。商家视角只展示、永不遮蔽（履约凭据）。
          expiresAt: true,
          // P5：附件元数据（商家核对已交付文件）；content 本体照旧不进商家详情。
          file: { select: { fileName: true, size: true, status: true } },
        },
      },
      settlement: { select: { settlementAmount: true, status: true, settledAt: true } },
      // P7b：任务态透出 + 脱敏诊断码，供商家判断是否人工介入。
      provisionTask: { select: { status: true, attempts: true, lastError: true, lastHttpStatus: true, nextAttemptAt: true, merchantNotifiedAt: true, updatedAt: true } },
      statusEvents: {
        select: {
          id: true,
          actorRole: true,
          fromStatus: true,
          toStatus: true,
          action: true,
          publicNote: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!order) throw notFound('订单不存在')
  return {
    ...serializeMerchantOrder(order),
    holdingPoints: order.holdingPoints,
    fulfillmentDeadline: order.fulfillmentDeadline,
    // P6c：预约日期（null = 非预约单）。
    bookingDate: order.bookingDate,
    slaExceeded: computeSlaExceeded(order),
    availableActions: getAvailableActions(order),
    // 详情显式回填：买家购买前填写的信息是商家的履约依据。
    purchaseFormSnapshot: order.purchaseFormSnapshot ?? null,
    purchaseFormAnswers: order.purchaseFormAnswers ?? null,
  }
}

async function assertMerchantOrder(merchantId: number, orderId: number, tx: Prisma.TransactionClient) {
  const order = await tx.order.findFirst({
    where: { id: orderId, merchantId },
    select: {
      id: true,
      status: true,
      userId: true,
      holdingPoints: true,
      fundsHeld: true,
      deliveryModeSnapshot: true,
      offerId: true,
      deliveryFieldsSnapshot: true,
      product: { select: { deliveryMode: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return order
}

export async function startOrderFulfillment(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: { publicNote?: string; internalNote?: string }
) {
  await prisma.$transaction(async tx => {
    await assertMerchantOrder(merchantId, orderId, tx)
    await transitionOrderStatus({
      orderId,
      toStatus: 'processing',
      actorRole: 'merchant',
      actorUserId,
      action: 'merchant.fulfillment.start',
      publicNote: input.publicNote,
      internalNote: input.internalNote,
    }, tx)
  })

  return getMyOrderDetail(merchantId, orderId)
}

export async function deliverOrderFulfillment(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: {
    deliveryContent?: string
    /** P4b：按规格模板交付的字段值；与 deliveryContent 二选一。 */
    structuredValues?: Record<string, string>
    /** P5：交付附件（先经交付文件上传获得）；可与文本/结构化并存。 */
    attachmentFileId?: number
    publicNote?: string
    internalNote?: string
  }
) {
  await prisma.$transaction(async tx => {
    const order = await assertMerchantOrder(merchantId, orderId, tx)
    if (getOrderDeliveryMode(order) !== 'manual_service') {
      throw badRequest('只有人工服务订单可由商家履约交付')
    }
    // P5：附件必须是本商家上传且可用的文件（别家 404 防枚举，吊销 400）。
    if (input.attachmentFileId != null) {
      await assertMyDeliveryFile(tx, merchantId, input.attachmentFileId)
    }

    // P4b：按订单的模板快照（下单时冻结，商家改模板不影响本单契约）强制分支：
    // - 有模板：必须提交完整 structuredValues，拒绝纯文本与空对象——否则商家
    //   可绕过 API 把必填模板订单标记为已发货且交付内容为空；
    // - 无模板：必须提交非空 deliveryContent，拒绝结构化字段；
    // - 二者同时提交拒绝（意图不明确，宁可让调用方改正）。
    const fields = parseStoredDeliveryFields(order.deliveryFieldsSnapshot)
    const hasStructured = input.structuredValues != null && Object.keys(input.structuredValues).length > 0
    const hasText = (input.deliveryContent ?? '').trim().length > 0
    if (hasStructured && hasText) {
      throw badRequest('结构化字段与纯文本发货内容只能提交其一')
    }
    let deliveryContent = input.deliveryContent
    let deliveryStructuredContent: StructuredDeliveryContent | null = null
    if (fields.length > 0) {
      if (!hasStructured) throw badRequest('该订单需按交付字段模板逐项发货')
      const values = validateDeliveryValues(fields, input.structuredValues)
      deliveryContent = canonicalDeliveryText(fields, values)
      deliveryStructuredContent = { fields, values }
    } else {
      if (hasStructured) throw badRequest('该订单为纯文本交付，请提交发货内容')
      // P5：附件本身就是合法交付物——纯文本内容与附件至少其一。
      if (!hasText && input.attachmentFileId == null) throw badRequest('发货内容不能为空')
    }

    await transitionOrderStatus({
      orderId,
      toStatus: 'delivered',
      actorRole: 'merchant',
      actorUserId,
      action: 'merchant.fulfillment.deliver',
      deliveryContent,
      deliveryStructuredContent,
      deliveryFileId: input.attachmentFileId ?? null,
      publicNote: input.publicNote,
      internalNote: input.internalNote,
    }, tx)

  })

  return getMyOrderDetail(merchantId, orderId)
}

// P6b：单订单每小时最多 6 条进度更新（审计表即计数器）。
// P7a 复核：复审 P2-4 的订单行 FOR UPDATE（下方）已把 count→create 整体
// 串行化——READ COMMITTED 下取到锁后的语句可见先行事务提交的事件，计数
// 不会超发，且这是 DB 行锁，跨实例同样成立。并发回归见
// __tests__/p7a-multi-instance.test.ts。
const PROGRESS_RATE_LIMIT = 6
const PROGRESS_RATE_WINDOW_MS = 60 * 60 * 1000

/**
 * P6b：商家发布履约进度。仅写 OrderStatusEvent（fromStatus=toStatus='processing'），
 * 不改 order.status——决策 ③：进度不引入新订单状态。note 即买家时间线上的
 * publicNote。
 */
export async function postOrderProgress(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: { note: string }
) {
  await prisma.$transaction(async tx => {
    // 归属校验沿用统一入口：他人/不存在的订单一律 404 防枚举。
    const order = await assertMerchantOrder(merchantId, orderId, tx)
    // 复审 P2-4：先锁订单行再终检状态。进度写入与交付并发时，进度事务在
    // 旧快照上看到 processing、提交时订单已 delivered——买家时间线会出现
    // 交付之后的 processing→processing 事件。FOR UPDATE 与
    // transitionOrderStatus 的行更新互斥：交付先提交则此处重读拒绝，
    // 进度先拿锁则交付排队在其后，事件序保持正确。
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`
    const fresh = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    })
    if (
      normalizeOrderStatus(fresh.status) !== 'processing'
      || getOrderDeliveryMode(order) !== 'manual_service'
    ) {
      throw badRequest('仅履约中的人工服务订单可更新进度')
    }

    const recent = await tx.orderStatusEvent.count({
      where: {
        orderId: order.id,
        action: 'merchant.progress',
        createdAt: { gte: new Date(Date.now() - PROGRESS_RATE_WINDOW_MS) },
      },
    })
    if (recent >= PROGRESS_RATE_LIMIT) {
      throw new HttpError(429, 'PROGRESS_RATE_LIMITED', '进度更新过于频繁，请稍后再试')
    }

    await createOrderStatusEvent(tx, {
      orderId: order.id,
      actorUserId,
      actorRole: 'merchant',
      fromStatus: 'processing',
      toStatus: 'processing',
      action: 'merchant.progress',
      publicNote: input.note,
    })
  })

  return { ok: true }
}

export async function respondToOrderDispute(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: { resolution: 'resume' | 'close'; publicNote?: string; internalNote?: string }
) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await assertMerchantOrder(merchantId, orderId, tx)
    // 即时模式（instant_*）内容已交付，恢复履约直接回到 delivered；人工服务单回 processing 由商家重新交付
    const resumeTarget: FulfillmentOrderStatus =
      isInstantMode(getOrderDeliveryMode(order) ?? '') ? 'delivered' : 'processing'
    await transitionOrderStatus({
      orderId,
      toStatus: input.resolution === 'resume' ? resumeTarget : 'closed',
      actorRole: 'merchant',
      actorUserId,
      action: `merchant.dispute.${input.resolution}`,
      publicNote: input.publicNote,
      internalNote: input.internalNote,
    }, tx)

    // 商家对人工服务争议选择关闭时，和用户确认关闭、管理员裁决关闭
    // 使用同一资金结算路径。此前这里只改订单状态，会遗留冻结积分和 holding Settlement。
    if (input.resolution === 'close') {
      await settleHeldOrder(tx, order, `商家争议关闭扣款: #${order.id}`)
      await tx.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date() },
      })
    }
  })

  return getMyOrderDetail(merchantId, orderId)
}

export async function rejectOrder(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: { publicNote?: string; internalNote?: string }
) {
  // 商家拒单（pending → refunded）：仅 manual_service 走 pending；即时模式创建即 delivered 不会进入 pending。
  // 拒单后立即退还冻结积分（holdingPoints），Settlement holding → voided。
  await prisma.$transaction(async tx => {
    const order = await tx.order.findFirst({
      where: { id: orderId, merchantId },
      select: {
        id: true,
        status: true,
        userId: true,
        holdingPoints: true,
        fundsHeld: true,
        deliveryModeSnapshot: true,
        // P5.5 T4：退款回补策略需要的归属字段。
        productId: true,
        offerId: true,
        merchantId: true,
        product: { select: { deliveryMode: true } },
      },
    })
    if (!order) throw notFound('订单不存在')

    if (getOrderDeliveryMode(order) !== 'manual_service') {
      throw badRequest('仅人工服务订单可拒单')
    }

    // 状态流转：pending → refunded（由 transitionOrderStatus 校验合法性）
    await transitionOrderStatus({
      orderId,
      toStatus: 'refunded',
      actorRole: 'merchant',
      actorUserId,
      action: 'merchant.fulfillment.reject',
      publicNote: input.publicNote ?? '商家拒绝接单，积分已退还',
      internalNote: input.internalNote,
    }, tx)

    await releaseHeldOrder(tx, order, `商家拒单释放冻结积分: #${order.id}`)

    // P5.5 T4：拒单退款的库存侧效果与积分退还同事务——未交付（pending），
    // 限量规格回补服务名额，销量净减。
    await applyRefundInventoryPolicy(tx, order, {
      fromStatus: 'pending',
      actorUserId,
    })

    // FakaBridge：拒单时取消尚未开通的任务（避免退款后仍外呼开通）
    await onFakaOrderRefundedInTx(tx, orderId)
  })

  return getMyOrderDetail(merchantId, orderId)
}
