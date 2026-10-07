import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import { notFound } from '../../../lib/httpError.js'
import { inspectProductReadiness } from '../../catalog/publicationReadiness.js'
import { DRAFT_BATCH_SIZE, DUE_WINDOW_MS, ITEM_LIMIT } from './rules.js'
import { draftItem, type AvailabilityRow, type ItemResult } from './dto.js'

export type ReadClient = Prisma.TransactionClient
export const readSnapshot = <T>(read: (db: ReadClient) => Promise<T>) => prisma.$transaction(read, {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
})

// Scopes the aggregation before counting inventory; no content columns, no per-offer queries.
function availabilityCte(merchantId: number, targetId?: number) {
  return Prisma.sql`WITH candidates AS (
    SELECT o.id, o."productId", o.name AS "offerName", p.name AS "productName",
      o."deliveryMode", o.stock
    FROM "Offer" o JOIN "Product" p ON p.id = o."productId"
    WHERE p."merchantId" = ${merchantId} AND p.status = 'active' AND p."archivedAt" IS NULL
      AND o.status = 'active' AND o."externalIntegration" IS NULL
      AND (o."deliveryMode" = 'instant_inventory' OR o."stockMode" = 'limited')
      ${targetId === undefined ? Prisma.empty : Prisma.sql`AND o.id = ${targetId}`}
  ), quantities AS (
    SELECT i."offerId", COUNT(*)::integer AS available
    FROM "InventoryItem" i JOIN candidates c ON c.id = i."offerId"
    WHERE i.status = 'available' AND c."deliveryMode" = 'instant_inventory'
    GROUP BY i."offerId"
  ), availability AS (
    SELECT c.id, c."productId", c."productName", c."offerName", c."deliveryMode",
      CASE WHEN c."deliveryMode" = 'instant_inventory' THEN COALESCE(q.available, 0) ELSE c.stock END AS available
    FROM candidates c LEFT JOIN quantities q ON q."offerId" = c.id
  )`
}

export async function queryAvailability(db: ReadClient, merchantId: number, threshold: number) {
  const cte = availabilityCte(merchantId)
  const items = await db.$queryRaw<AvailabilityRow[]>`${cte}
    SELECT * FROM availability WHERE available <= ${threshold} ORDER BY available, id LIMIT ${ITEM_LIMIT}`
  const [count] = await db.$queryRaw<Array<{ total: number }>>`${cte}
    SELECT COUNT(*)::integer AS total FROM availability WHERE available <= ${threshold}`
  return { items, matchedTotal: count.total }
}

export async function queryAvailabilityTarget(db: ReadClient, merchantId: number, id: number) {
  const owned = await db.offer.findFirst({ where: { id, product: { merchantId } }, select: { id: true } })
  if (!owned) throw notFound()
  const cte = availabilityCte(merchantId, id)
  const rows = await db.$queryRaw<AvailabilityRow[]>`${cte} SELECT * FROM availability`
  return rows[0] ?? null
}

export const fulfillmentSelect = {
  id: true, productId: true, offerId: true, status: true, fulfillmentDeadline: true,
  productNameSnapshot: true, offerNameSnapshot: true,
  product: { select: { name: true } }, offer: { select: { name: true } },
} satisfies Prisma.OrderSelect

export async function queryFulfillment(db: ReadClient, merchantId: number, now: Date) {
  const where: Prisma.OrderWhereInput = {
    merchantId, status: { in: ['pending', 'processing'] }, deliveryModeSnapshot: 'manual_service',
    fulfillmentDeadline: { not: null, lte: new Date(now.getTime() + DUE_WINDOW_MS) },
  }
  const items = await db.order.findMany({ where, select: fulfillmentSelect,
    orderBy: [{ fulfillmentDeadline: 'asc' }, { id: 'asc' }], take: ITEM_LIMIT })
  return { items, matchedTotal: await db.order.count({ where }) }
}

export async function queryDraftIds(merchantId: number, beforeProductId?: number) {
  return prisma.product.findMany({
    where: { merchantId, status: 'draft', archivedAt: null, ...(beforeProductId ? { id: { lt: beforeProductId } } : {}) },
    select: { id: true }, orderBy: { id: 'desc' }, take: DRAFT_BATCH_SIZE + 1,
  })
}

export async function queryDraftTarget(merchantId: number, id: number, now: Date): Promise<ItemResult> {
  return readSnapshot(async db => {
    const product = await db.product.findFirst({ where: { id, merchantId },
      select: { id: true, name: true, status: true, archivedAt: true, contentVersion: true } })
    if (!product) throw notFound()
    if (product.status !== 'draft' || product.archivedAt) return { targetId: id, state: 'ineligible' }
    // Ownership and readiness share a snapshot; defaults exactly match publication.
    const { readiness, availabilityOfferIds } = await inspectProductReadiness(id, db)
    return readiness.ready ? { targetId: id, state: 'clear' }
      : { targetId: id, state: 'match', item: draftItem(product, readiness.details, availabilityOfferIds, now) }
  })
}
