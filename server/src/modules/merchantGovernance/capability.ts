import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { forbidden, notFound } from '../../lib/httpError.js'
import { isAccountBanned } from '../accountGovernance/status.js'
/** Caller must acquire an existing order's root lock before this merchant lock. */
export async function assertMerchantOperation(
  tx: Prisma.TransactionClient,
  merchantId: number,
  activeOnly = true,
  lock = true,
) {
  if (lock) await tx.$queryRaw`SELECT id FROM "Merchant" WHERE id=${merchantId} FOR SHARE`
  const m = await tx.merchant.findUnique({
    where: { id: merchantId },
    select: { userId: true, status: true },
  })
  if (!m) throw notFound('商家不存在')
  if (
    (await isAccountBanned(m.userId, tx)) ||
    !(activeOnly ? m.status === 'active' : ['active', 'suspended'].includes(m.status))
  )
    throw forbidden('当前商家能力不允许此操作')
  return m
}
export async function merchantOrderActions(merchantId: number, actions: string[]) {
  const m = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { status: true, userId: true },
  })
  if (!m || (await isAccountBanned(m.userId))) return []
  if (m.status === 'active') return actions
  return m.status === 'suspended' ? actions.filter((a) => a !== 'start_fulfillment') : []
}
