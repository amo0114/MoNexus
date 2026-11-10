import type { Prisma } from '@prisma/client'
import { pointBalanceConflict } from '../../lib/httpError.js'
import type { LotFilter } from './types.js'

type Tx = Prisma.TransactionClient

export type Movement = {
  lotId: number
  availableDelta: number
  frozenDelta: number
  consumedDelta: number
  parentAllocationId?: number | null
}

export type Pick = { lotId: number; points: number }

/**
 * Deterministic FIFO over the caller's lots: preferred source operations first,
 * then entry order (id). Callers hold the account lock, which serializes every
 * lot write for this user, so no separate lot lock is needed.
 */
export async function pickLots(
  tx: Tx,
  userId: number,
  amount: number,
  field: 'availablePoints' | 'frozenPoints',
  filter: LotFilter & { legacyOnly?: boolean } = {},
  allowPartial = false,
): Promise<Pick[]> {
  const lots = await tx.pointLot.findMany({
    where: {
      userId,
      [field]: { gt: 0 },
      ...(filter.origins ? { originKind: { in: filter.origins } } : {}),
      ...(filter.onlySourceOperationIds ? { sourceOperationId: { in: filter.onlySourceOperationIds } } : {}),
      ...(filter.legacyOnly ? { sourceOperation: { kind: 'legacy_init' } } : {}),
    },
    select: { id: true, sourceOperationId: true, availablePoints: true, frozenPoints: true },
    orderBy: { id: 'asc' },
  })
  const preferred = new Set(filter.preferSourceOperationIds ?? [])
  lots.sort((a, b) => Number(preferred.has(b.sourceOperationId)) - Number(preferred.has(a.sourceOperationId)) || a.id - b.id)

  const picks: Pick[] = []
  let left = amount
  for (const lot of lots) {
    if (left === 0) break
    const take = Math.min(left, lot[field])
    picks.push({ lotId: lot.id, points: take })
    left -= take
  }
  if (left > 0 && !allowPartial) {
    // The account row already accepted the change, so missing lot cover is a
    // projection mismatch, not an ordinary "insufficient points" case.
    throw pointBalanceConflict('积分来源记录与余额不一致，请联系管理员')
  }
  return picks
}

export async function availableInLots(tx: Tx, userId: number, filter: LotFilter): Promise<number> {
  const result = await tx.pointLot.aggregate({
    where: {
      userId,
      availablePoints: { gt: 0 },
      ...(filter.origins ? { originKind: { in: filter.origins } } : {}),
      ...(filter.onlySourceOperationIds ? { sourceOperationId: { in: filter.onlySourceOperationIds } } : {}),
    },
    _sum: { availablePoints: true },
  })
  return result._sum.availablePoints ?? 0
}

/**
 * What is still outstanding on an operation's allocations: frozen points of a
 * reserve not yet captured/released, or consumed points of a spend/capture not
 * yet refunded. Children carry the opposite sign of the parent delta.
 */
export async function outstandingAllocations(
  tx: Tx,
  operationId: number,
  field: 'frozenDelta' | 'consumedDelta',
): Promise<Array<{ allocationId: number; lotId: number; points: number }>> {
  const rows = await tx.walletAllocation.findMany({
    where: { operationId, [field]: { gt: 0 } },
    select: { id: true, lotId: true, [field]: true, children: { select: { [field]: true } } },
    orderBy: { id: 'asc' },
  }) as unknown as Array<{ id: number; lotId: number; children: Array<Record<string, number>> } & Record<string, number>>
  return rows
    .map(row => ({
      allocationId: row.id,
      lotId: row.lotId,
      points: row[field] + row.children.reduce((sum, child) => sum + child[field], 0),
    }))
    .filter(row => row.points > 0)
}

export async function applyMovements(tx: Tx, movements: Movement[]) {
  for (const m of movements) {
    // PointLot CHECK enforces non-negative buckets and issued = sum of buckets.
    await tx.$executeRaw`
      UPDATE "PointLot"
      SET "availablePoints" = "availablePoints" + ${m.availableDelta},
          "frozenPoints" = "frozenPoints" + ${m.frozenDelta},
          "consumedPoints" = "consumedPoints" + ${m.consumedDelta}
      WHERE "id" = ${m.lotId}`
  }
}
