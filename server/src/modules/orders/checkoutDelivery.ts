import { Prisma, type Offer, type Order } from '@prisma/client'
import { parseStoredStructuredContent, structuredContentToJson, type StructuredDeliveryContent } from '../../lib/deliveryFields.js'
import { badRequest } from '../../lib/httpError.js'
import { resolveFulfillmentStrategy } from '../../lib/productCatalog/templates/fulfillmentStrategy.js'
import type { FulfillmentOfferInput, FulfillmentStrategy } from '../../lib/productCatalog/templates/types.js'
import { resolveSubscriptionExpiresAt } from './fulfillment.js'
import { isInstantMode } from './statusPolicy.js'

/** Map a loaded Offer onto the resolver input. Does not invent extra columns. */
function fulfillmentInputFromOffer(offer: FulfillmentOfferInput): FulfillmentOfferInput {
  return {
    deliveryMode: offer.deliveryMode,
    stockMode: offer.stockMode,
    fixedContentType: offer.fixedContentType,
    fixedContent: offer.fixedContent,
    fixedFileId: offer.fixedFileId,
    deliveryFields: offer.deliveryFields,
    autoProvision: offer.autoProvision,
    externalIntegration: offer.externalIntegration,
    externalSku: offer.externalSku,
    fixedStructuredContent: offer.fixedStructuredContent,
  }
}

/**
 * Select the existing delivery write path.
 * P4b: manual_service may carry deliveryFields as the merchant-fulfillment
 * template (filled at deliver time). The catalog resolver treats that as
 * mixed instant config; retry without those fields so the original freeze
 * path still runs. Other ok:false results stay unpurchasable.
 */
export function resolveOrderFulfillmentStrategy(offer: FulfillmentOfferInput) {
  const input = fulfillmentInputFromOffer(offer)
  const resolved = resolveFulfillmentStrategy(input)
  if (resolved.ok) return resolved.strategy
  const isPlainManual =
    input.deliveryMode === 'manual_service'
    && !input.autoProvision
    && (input.externalIntegration == null || input.externalIntegration === '')
  if (isPlainManual) {
    const retry = resolveFulfillmentStrategy({ ...input, deliveryFields: null })
    if (retry.ok && retry.strategy.kind === 'manual') return retry.strategy
  }
  throw badRequest('商品暂不可购买，请联系商家')
}

export async function recordInstantDeliveryInTx(tx: Prisma.TransactionClient, input: {
  order: Pick<Order, 'id' | 'renewalOfOrderId' | 'validityDaysSnapshot'>
  offer: Pick<Offer, 'id' | 'fixedContent' | 'fixedContentType' | 'fixedStructuredContent'>
  purchasedFile: { id: number } | null | undefined
  strategy: FulfillmentStrategy
  deliveryMode: string
  userId: number
  productId: number
}) {
  const { order, offer, purchasedFile, strategy, deliveryMode, userId, productId } = input
  let deliveryContent: string | undefined
  let deliveryContentType: string | undefined
  let deliveryStructuredContent: StructuredDeliveryContent | null = null

  // P6a：即时交付的订阅到期时刻（null = 永久）。续费单且原单未过期时
  // 自原到期顺延——与人工交付路径共用同一解析逻辑（fulfillment.ts）。
  const subscriptionExpiresAt = isInstantMode(deliveryMode)
    ? await resolveSubscriptionExpiresAt(tx, order, order.validityDaysSnapshot, new Date())
    : null

  if (strategy.kind === 'inventory') {
    // Claim one row in the database instead of first reading a candidate
    // and then conditionally updating it. SKIP LOCKED lets simultaneous
    // buyers move on to the next available secret rather than all racing
    // for the first row and unnecessarily rejecting valid purchases.
    const reservedItems = await tx.$queryRaw<Array<{ content: string; structuredContent: unknown }>>(Prisma.sql`
      UPDATE "InventoryItem"
      SET "status" = 'sold',
          "orderId" = ${order.id},
          "soldToUserId" = ${userId},
          "soldAt" = NOW()
      WHERE "id" = (
        SELECT "id"
        FROM "InventoryItem"
        WHERE "offerId" = ${offer.id}
          AND "status" = 'available'
        ORDER BY "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING "content", "structuredContent"
    `)
    const item = reservedItems[0]
    if (!item) throw badRequest('库存不足，请稍后再试')

    deliveryContent = item.content
    deliveryContentType = 'text'
    // P4b：条目携带的自包含快照 { fields, values } 原样落进交付记录——
    // 商家后续改模板不影响这笔订单的字段化展示；非法形态按纯文本兜底。
    deliveryStructuredContent = parseStoredStructuredContent(item.structuredContent)

    await tx.deliveryRecord.create({
      data: {
        orderId: order.id,
        userId,
        productId,
        content: item.content,
        contentType: 'text',
        structuredContent: deliveryStructuredContent
          ? structuredContentToJson(deliveryStructuredContent)
          : undefined,
        status: 'delivered',
        deliveredAt: new Date(),
        expiresAt: subscriptionExpiresAt,
      },
    })

  } else if (strategy.kind === 'fixed_file') {
    if (!purchasedFile) throw badRequest('商品暂不可购买，请联系商家')
    // P5：下单事务冻结文件引用——商家换文件只影响后续订单，
    // 本单下载永远按这份快照授权，绝不回查当前 Offer。
    deliveryContentType = 'file'
    await tx.deliveryRecord.create({
      data: {
        orderId: order.id,
        userId,
        productId,
        content: null,
        contentType: 'file',
        fileId: purchasedFile.id,
        status: 'delivered',
        deliveredAt: new Date(),
        expiresAt: subscriptionExpiresAt,
      },
    })
  } else if (strategy.kind === 'fixed_text' || strategy.kind === 'fixed_url') {
    deliveryContent = offer.fixedContent!
    deliveryContentType = offer.fixedContentType
    // Shared-account freeze: Offer.fixedStructuredContent → DeliveryRecord.
    // InventoryItem claim/dedupe above is unchanged.
    deliveryStructuredContent = parseStoredStructuredContent(offer.fixedStructuredContent)

    await tx.deliveryRecord.create({
      data: {
        orderId: order.id,
        userId,
        productId,
        content: offer.fixedContent,
        contentType: offer.fixedContentType,
        structuredContent: deliveryStructuredContent
          ? structuredContentToJson(deliveryStructuredContent)
          : undefined,
        status: 'delivered',
        deliveredAt: new Date(),
        expiresAt: subscriptionExpiresAt,
      },
    })
  }
  // manual / merchant_webhook / external provider: freeze path already ran; no instant DeliveryRecord.

  return { deliveryContent, deliveryContentType, deliveryStructuredContent }
}
