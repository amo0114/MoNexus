import type { Prisma } from '@prisma/client'
import { accountSpendingRestricted } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'

type SpendingPolicyDb = Pick<Prisma.TransactionClient, 'accountRestriction'>

/** Shared by checkout previews and transactional order/promotion debits. */
export async function hasActiveSpendingRestriction(userId: number, db: SpendingPolicyDb = prisma): Promise<boolean> {
  const restriction = await db.accountRestriction.findFirst({
    where: { userId, status: 'active', blocksPointSpending: true },
    select: { id: true },
  })
  return restriction != null
}

export async function assertSpendingNotRestricted(userId: number, db: SpendingPolicyDb = prisma): Promise<void> {
  if (await hasActiveSpendingRestriction(userId, db)) throw accountSpendingRestricted()
}
