import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, HttpError } from '../../lib/httpError.js'
import {
  createOrderStatusEvent,
  getProductFulfillmentMode,
  isInstantMode,
  normalizeOrderStatus,
  transitionOrderStatus,
} from './fulfillment.js'
import { debitAvailablePoints, holdAvailablePoints, settleHeldOrder } from './accounting.js'
import {
  claimIdempotencyKey,
  completeIdempotencyClaim,
  releaseIdempotencyClaim,
} from './idempotency.js'
import { serializeUserOrderDetail, serializeUserOrderList } from './serializers.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import { parseStoredPurchaseForm, validatePurchaseFormAnswers, computePurchaseFormVersion } from '../../lib/purchaseForm.js'
import { assertCheckoutVerification } from '../checkout/verification.js'

// manual_service 商家履约 SLA：创建订单后 7 天内需交付，M3-S2 工作台高亮超时
const FULFILLMENT_SLA_MS = 7 * 24 * 60 * 60 * 1000

export type CreateOrderOptions = {
  // 服务端最终价确认：与商品当前价不一致时拒单（409 PRICE_CHANGED），
  // 用户必须针对新价格重新确认，而不是静默按新价格成交。
  expectedPrice?: number
  // 同一结算意图（双击/超时重试/网络重放)只允许产生一笔订单。
  idempotencyKey?: string
  // 购买前表单答案：按商品当前定义校验后与定义一并快照进订单。
  formAnswers?: Record<string, string>
  // 结算预览返回的表单版本：商家在预览后改动表单时拒单（409 CHECKOUT_CHANGED）。
  expectedPurchaseFormVersion?: string
  // 高风险二次验证：触发阈值时必须携带的登录密码（checkout/verification.ts）。
  verificationPassword?: string
}

export async function createOrder(
  userId: number,
  productId: number,
  options: CreateOrderOptions = {}
) {
  const { expectedPrice, idempotencyKey, formAnswers, expectedPurchaseFormVersion, verificationPassword } = options

  let claimToken: string | undefined
  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(userId, idempotencyKey, {
      productId,
      expectedPrice,
      purchaseFormVersion: expectedPurchaseFormVersion,
      formAnswers,
    })
    if (claim.kind === 'replay') return buildReplayResponse(claim.orderId, userId)
    claimToken = claim.claimToken
  }

  try {
    // 高风险二次验证：幂等 claim 之后、订单事务之前（bcrypt 慢操作不进事务）。
    // 验证前先做轻量的价格/表单版本预检——商家改价（或改表单）恰好把订单推过
    // 验证阈值时，必须优先返回 409 让前端重新报价（新 preview 会带上密码框），
    // 而不是先返回 VERIFICATION_REQUIRED 把用户卡在没有密码框的旧弹窗里。
    // 这里只是预检，事务内仍保留最终一致性校验；商品缺失由事务内统一 404。
    const current = await prisma.product.findUnique({
      where: { id: productId },
      select: { price: true, purchaseForm: true },
    })
    if (current) {
      if (expectedPrice != null && expectedPrice !== current.price) {
        throw new HttpError(409, 'PRICE_CHANGED', '商品信息已变化，请重新确认')
      }
      if (
        expectedPurchaseFormVersion != null &&
        expectedPurchaseFormVersion !== computePurchaseFormVersion(parseStoredPurchaseForm(current.purchaseForm))
      ) {
        throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
      }
      // 服务端按当前价重算触发条件，不信任 preview 的 requiresVerification 声明。
      // 失败抛错走下面的 release 路径，同 key 可换密码重试同一意图。
      await assertCheckoutVerification(userId, current.price, verificationPassword)
    }
    return await createOrderOnce(userId, productId, {
      expectedPrice,
      idempotencyKey,
      formAnswers,
      expectedPurchaseFormVersion,
      claimToken,
    })
  } catch (err) {
    // 事务已回滚，释放幂等占用让用户可以用同一 key 重试同一意图。
    // 释放按租约 token 定向：若占用已被其他请求接管，这里不会误删。
    if (idempotencyKey && claimToken) {
      await releaseIdempotencyClaim(userId, idempotencyKey, claimToken)
    }
    throw err
  }
}

/** Rebuild the createOrder response shape for an idempotent replay. */
async function buildReplayResponse(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      product: { select: { name: true } },
      merchant: { select: { id: true, name: true } },
      delivery: { select: { content: true, contentType: true } },
    },
  })
  // 幂等记录指向的订单只可能因数据被外部改动而缺失。
  if (!order) throw notFound('订单不存在')

  const account = await prisma.pointAccount.findUnique({ where: { userId } })
  return {
    orderId: order.id,
    productName: order.productNameSnapshot ?? order.product.name,
    price: order.price,
    status: normalizeOrderStatus(order.status),
    deliveryMode: getProductFulfillmentMode(order.deliveryModeSnapshot),
    deliveryContent: order.delivery?.content ?? undefined,
    deliveryContentType: order.delivery?.contentType ?? undefined,
    balanceAfter: account?.balance ?? 0,
    merchantId: order.merchantId,
    merchantName: order.merchant?.name ?? null,
    idempotentReplay: true,
  }
}

async function createOrderOnce(
  userId: number,
  productId: number,
  {
    expectedPrice,
    idempotencyKey,
    formAnswers,
    expectedPurchaseFormVersion,
    claimToken,
  }: CreateOrderOptions & { claimToken?: string }
) {
  const result = await prisma.$transaction(async tx => {
    const account = await tx.pointAccount.findUnique({ where: { userId } })
    if (!account) throw notFound('积分账户不存在')

    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) throw notFound('商品不存在')
    if (product.status !== 'active') throw badRequest('商品已下架')
    if (expectedPrice != null && expectedPrice !== product.price) {
      throw new HttpError(409, 'PRICE_CHANGED', '商品信息已变化，请重新确认')
    }
    // 购买前表单：先做版本比对——商家在买家打开弹窗后改动表单（新增必填、
    // 删选项等）时，买家看到的还是旧表单，必须重新报价确认而不是校验失败 400。
    const purchaseFormFields = parseStoredPurchaseForm(product.purchaseForm)
    if (
      expectedPurchaseFormVersion != null &&
      expectedPurchaseFormVersion !== computePurchaseFormVersion(purchaseFormFields)
    ) {
      throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
    }
    const purchaseFormAnswers = validatePurchaseFormAnswers(purchaseFormFields, formAnswers)
    const deliveryMode = getProductFulfillmentMode(product.deliveryMode)

    if (deliveryMode === 'instant_fixed' && !product.fixedContent) {
      throw badRequest('商品暂不可购买，请联系商家')
    }
    if (deliveryMode !== 'instant_inventory' && product.stockMode === 'limited' && product.stock <= 0) {
      throw badRequest('库存不足，请稍后再试')
    }

    let merchantId: number | null = null
    let merchantName: string | null = null
    let commissionRate = 0
    let commissionAmount = 0

    if (product.merchantId != null) {
      const merchant = await tx.merchant.findUnique({ where: { id: product.merchantId } })
      if (!merchant || merchant.status !== 'active') throw badRequest('商家暂不可用')

      merchantId = merchant.id
      merchantName = merchant.name
      commissionRate = Number(merchant.commissionRate)
      commissionAmount = Math.floor(product.price * commissionRate)
    }

    const isManual = deliveryMode === 'manual_service'

    // 积分流转规则（PRD §4.3.1）：
    // - instant_* 模式：即时扣减，PointLog 'out'，Settlement 'pending'
    // - manual_service：原子地从可用积分转入冻结余额，Settlement 'holding'
    let orderHoldingPoints: number | null = null
    let orderFulfillmentDeadline: Date | null = null
    let balanceAfter = account.balance
    let settledSettlementStatus: 'pending' | 'holding' = 'pending'
    let fundsHeld = false

    if (isManual) {
      // 虚拟服务订单：冻结真实占用可用积分，避免同一余额被多笔订单重复使用。
      orderHoldingPoints = product.price
      orderFulfillmentDeadline = new Date(Date.now() + FULFILLMENT_SLA_MS)
      settledSettlementStatus = 'holding'
      balanceAfter = await holdAvailablePoints(tx, userId, product.price)
      fundsHeld = true
    } else {
      // 即时模式：带余额条件的原子扣减，禁止并发下单透支。
      balanceAfter = await debitAvailablePoints(tx, userId, product.price)
    }

    const order = await tx.order.create({
      data: {
        userId,
        productId,
        price: product.price,
        status: isInstantMode(deliveryMode) ? 'delivered' : 'pending',
        merchantId,
        commissionRate,
        commissionAmount,
        deliveryModeSnapshot: deliveryMode,
        productNameSnapshot: product.name,
        productTypeSnapshot: product.type,
        productIconSnapshot: product.icon,
        productImageUrlSnapshot: product.imageUrl,
        holdingPoints: orderHoldingPoints,
        fundsHeld,
        fulfillmentDeadline: orderFulfillmentDeadline,
        // 定义与答案一并快照：商家之后改表单不影响本单的展示与履约依据。
        ...(purchaseFormFields.length > 0 ? { purchaseFormSnapshot: purchaseFormFields } : {}),
        ...(purchaseFormAnswers ? { purchaseFormAnswers } : {}),
      },
    })

    await createOrderStatusEvent(tx, {
      orderId: order.id,
      actorUserId: userId,
      actorRole: 'user',
      fromStatus: null,
      toStatus: order.status,
      action: `order.created.${deliveryMode}`,
    })

    let deliveryContent: string | undefined
    let deliveryContentType: string | undefined

    if (deliveryMode === 'instant_inventory') {
      // Claim one row in the database instead of first reading a candidate
      // and then conditionally updating it. SKIP LOCKED lets simultaneous
      // buyers move on to the next available secret rather than all racing
      // for the first row and unnecessarily rejecting valid purchases.
      const reservedItems = await tx.$queryRaw<Array<{ id: number; content: string }>>(Prisma.sql`
        UPDATE "InventoryItem"
        SET "status" = 'sold',
            "orderId" = ${order.id},
            "soldToUserId" = ${userId},
            "soldAt" = NOW()
        WHERE "id" = (
          SELECT "id"
          FROM "InventoryItem"
          WHERE "productId" = ${productId}
            AND "status" = 'available'
          ORDER BY "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING "id", "content"
      `)
      const item = reservedItems[0]
      if (!item) throw badRequest('库存不足，请稍后再试')

      deliveryContent = item.content
      deliveryContentType = 'text'

      await tx.deliveryRecord.create({
        data: {
          orderId: order.id,
          userId,
          productId,
          content: item.content,
          contentType: 'text',
          status: 'delivered',
          deliveredAt: new Date(),
        },
      })

    } else if (deliveryMode === 'instant_fixed') {
      deliveryContent = product.fixedContent!
      deliveryContentType = product.fixedContentType

      await tx.deliveryRecord.create({
        data: {
          orderId: order.id,
          userId,
          productId,
          content: product.fixedContent,
          contentType: product.fixedContentType,
          status: 'delivered',
          deliveredAt: new Date(),
        },
      })
    }

    await tx.pointLog.create({
      data: {
        userId,
        type: isManual ? 'hold' : 'out',
        amount: product.price,
        balanceAfter,
        reason: isManual ? `订单冻结积分: #${order.id}` : `兑换商品: ${product.name}`,
        orderId: order.id,
      },
    })

    if (merchantId != null) {
      await tx.settlement.create({
        data: {
          merchantId,
          orderId: order.id,
          orderAmount: product.price,
          commissionRate,
          commissionAmount,
          settlementAmount: product.price - commissionAmount,
          status: settledSettlementStatus,
        },
      })
    }

    if (deliveryMode === 'instant_inventory') {
      await tx.product.update({
        where: { id: productId },
        // 即时库存已经通过上面的 InventoryItem 原子领取变为 sold；
        // Product.stock 不再是该模式的库存来源或缓存投影。
        data: { sales: { increment: 1 } },
      })
    } else if (product.stockMode === 'limited') {
      // 条件更新防并发超卖：stock>0 才扣减，失败即售罄
      const updated = await tx.product.updateMany({
        where: { id: productId, stock: { gt: 0 } },
        data: { stock: { decrement: 1 }, sales: { increment: 1 } },
      })
      if (updated.count !== 1) throw badRequest('库存不足，请稍后再试')
    } else {
      await tx.product.update({
        where: { id: productId },
        data: { sales: { increment: 1 } },
      })
    }

    if (deliveryMode === 'instant_inventory' || product.stockMode === 'limited') {
      // Every finite sellable resource is consumed exactly once. This entry
      // is written in the same transaction as either the InventoryItem claim
      // or the numeric capacity decrement, while retaining only the order
      // reference—not any delivery secret.
      await logInventoryChange(tx, {
        productId,
        merchantId: product.merchantId,
        actorUserId: userId,
        action: 'sale',
        delta: -1,
        orderId: order.id,
      })
    }

    if (idempotencyKey && claimToken) {
      // 与订单创建同事务提交："订单存在"与"key 可重放"必须原子生效。
      // 租约 token 不匹配（占用已被接管）时抛错回滚，避免同 key 双单。
      await completeIdempotencyClaim(tx, userId, idempotencyKey, claimToken, order.id)
    }

    return {
      orderId: order.id,
      productName: product.name,
      price: product.price,
      status: normalizeOrderStatus(order.status),
      deliveryMode,
      deliveryContent,
      deliveryContentType,
      balanceAfter,
      merchantId,
      merchantName,
    }
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
}

export async function getOrderDetail(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      merchant: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, deliveryMode: true } },
      delivery: { select: { status: true, content: true, contentType: true, publicNote: true, deliveredAt: true } },
      review: {
        select: { rating: true, comment: true, status: true, editableUntil: true, editedAt: true, createdAt: true },
      },
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
  const normalized = normalizeOrderStatus(order.status)
  return {
    ...serializeUserOrderDetail(order),
    holdingPoints: order.holdingPoints ?? null,
    fulfillmentDeadline: order.fulfillmentDeadline ?? null,
    review: order.review ?? null,
    canReview: !order.review && (normalized === 'delivered' || normalized === 'closed'),
  }
}

function buildUserOrderWhere(userId: number, status?: string): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { userId }
  if (!status) return where

  const normalizedStatus = normalizeOrderStatus(status)
  where.status = normalizedStatus === 'delivered'
    ? { in: ['delivered', 'completed'] }
    : normalizedStatus

  return where
}

export async function getUserOrders(userId: number, page = 1, pageSize = 20, status?: string) {
  const orders = await prisma.order.findMany({
    where: buildUserOrderWhere(userId, status),
    include: {
      merchant: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, deliveryMode: true } },
      delivery: { select: { status: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
  return orders.map(order => ({
    ...serializeUserOrderList(order),
    holdingPoints: order.holdingPoints ?? null,
  }))
}

async function assertUserOwnsOrder(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { id: true },
  })
  if (!order) throw notFound('订单不存在')
}

export async function disputeOrder(orderId: number, userId: number) {
  await assertUserOwnsOrder(orderId, userId)
  await transitionOrderStatus({
    orderId,
    toStatus: 'disputed',
    actorRole: 'user',
    actorUserId: userId,
    action: 'user.dispute',
    publicNote: '用户发起争议',
  })

  return getOrderDetail(orderId, userId)
}

export async function closeOrder(orderId: number, userId: number) {
  // 用户确认关闭：积分正式扣减（若为 manual_service 冻结单）
  // PRD §4.3.1：delivered > 7 天自动 closed，积分正式扣减并触发 Settlement
  await assertUserOwnsOrder(orderId, userId)
  const result = await prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, holdingPoints: true, fundsHeld: true, status: true, productId: true },
    })
    if (!order) throw notFound('订单不存在')

    // 状态流转：delivered → closed
    const updated = await transitionOrderStatus(
      {
        orderId,
        toStatus: 'closed',
        actorRole: 'user',
        actorUserId: userId,
        action: 'user.close',
        publicNote: '用户确认关闭',
      },
      tx
    )

    // 若为冻结单，正式消耗冻结积分并允许商家结算。
    await settleHeldOrder(tx, order, `订单关闭扣款: #${order.id}`)

    await tx.order.update({
      where: { id: orderId },
      data: { confirmedAt: new Date() },
    })

    return updated
  })

  await invalidateProductPublicCache(result.productId, { list: 'coalesced' })
  return getOrderDetail(orderId, userId)
}
