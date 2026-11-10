import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { availableInLots } from './allocation.js'
import type { LotFilter, WalletOriginKind } from './types.js'

type Db = Prisma.TransactionClient | typeof prisma

/** Available points held by matching lots. Call after locking the account. */
export async function availablePointsIn(tx: Prisma.TransactionClient, userId: number, filter: LotFilter) {
  return availableInLots(tx, userId, filter)
}

export async function findOperationByKey(db: Db, operationKey: string) {
  return db.walletOperation.findUnique({ where: { operationKey } })
}

export type SourceComposition = Partial<Record<WalletOriginKind, number>>

/**
 * Original payment composition of an order by origin, independent of later
 * refunds; also the basis for reward-subsidy responsibility.
 */
export async function orderPaymentComposition(db: Db, orderId: number) {
  const ops = await db.walletOperation.findMany({
    where: { operationKey: { in: [`order:${orderId}:spend`, `order:${orderId}:reserve`] } },
    select: { id: true, kind: true },
  })
  const op = ops[0]
  if (!op) return null
  const rows = await db.walletAllocation.findMany({
    where: { operationId: op.id },
    select: { frozenDelta: true, consumedDelta: true, lot: { select: { originKind: true } } },
  })
  const result: SourceComposition = {}
  for (const row of rows) {
    const points = Math.max(row.frozenDelta, row.consumedDelta)
    if (points <= 0) continue
    const origin = row.lot.originKind as WalletOriginKind
    result[origin] = (result[origin] ?? 0) + points
  }
  return result
}

/** Current available/frozen points per origin for one account. */
export async function accountSources(db: Db, userId: number) {
  const groups = await db.pointLot.groupBy({
    by: ['originKind'],
    where: { userId },
    _sum: { availablePoints: true, frozenPoints: true, issuedPoints: true },
  })
  return groups.map(group => ({
    origin: group.originKind as WalletOriginKind,
    available: group._sum.availablePoints ?? 0,
    frozen: group._sum.frozenPoints ?? 0,
    issued: group._sum.issuedPoints ?? 0,
  }))
}

export type WalletInvariantViolation = {
  userId: number
  balance: number
  frozenBalance: number
  lotAvailable: number
  lotFrozen: number
}

/**
 * Read-only conservation check: initialized accounts must equal their lots.
 * Reports differences; never picks one side to overwrite the other.
 */
export async function findWalletInvariantViolations(db: Db = prisma, limit = 100): Promise<WalletInvariantViolation[]> {
  const rows = await db.$queryRaw<Array<{
    userId: number
    balance: number
    frozenBalance: number
    lotAvailable: bigint | null
    lotFrozen: bigint | null
  }>>`
    SELECT a."userId", a."balance", a."frozenBalance",
           SUM(l."availablePoints") AS "lotAvailable", SUM(l."frozenPoints") AS "lotFrozen"
    FROM "PointAccount" a
    LEFT JOIN "PointLot" l ON l."userId" = a."userId"
    WHERE a."walletInitializedAt" IS NOT NULL
    GROUP BY a."userId", a."balance", a."frozenBalance"
    HAVING a."balance" <> COALESCE(SUM(l."availablePoints"), 0)
        OR a."frozenBalance" <> COALESCE(SUM(l."frozenPoints"), 0)
    ORDER BY a."userId"
    LIMIT ${limit}`
  return rows.map(row => ({
    userId: row.userId,
    balance: row.balance,
    frozenBalance: row.frozenBalance,
    lotAvailable: Number(row.lotAvailable ?? 0),
    lotFrozen: Number(row.lotFrozen ?? 0),
  }))
}
