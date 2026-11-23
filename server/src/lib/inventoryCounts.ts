import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

type Client = typeof prisma | Prisma.TransactionClient

// Use these instead of a relation `_count` with a `where` filter: Prisma
// compiles that into a GROUP BY over the whole InventoryItem table (seq scan
// of every row on every read). An explicit `IN` list hits the
// (offerId, status) / (productId, status) indexes.

export async function countAvailableByOfferId(offerIds: number[], db: Client = prisma): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  if (offerIds.length === 0) return counts
  const grouped = await db.inventoryItem.groupBy({
    by: ['offerId'],
    where: { offerId: { in: offerIds }, status: 'available' },
    _count: { _all: true },
  })
  for (const row of grouped) counts.set(row.offerId, row._count._all)
  return counts
}

export async function countAvailableByProductId(productIds: number[], db: Client = prisma): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  if (productIds.length === 0) return counts
  const grouped = await db.inventoryItem.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds }, status: 'available' },
    _count: { _all: true },
  })
  for (const row of grouped) counts.set(row.productId, row._count._all)
  return counts
}
