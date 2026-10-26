import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'

type DB = typeof prisma | Prisma.TransactionClient
export async function readRecoverySource(taskId: number, db: DB = prisma) {
  return db.fakaBridgeTask.findUnique({ where: { id: taskId }, select: {
    id: true, status: true, completedAt: true, requestOrderNo: true, emailSnapshot: true, xboardTradeNo: true,
    order: { select: { id: true, userId: true, status: true, createdAt: true,
      user: { select: { status: true, email: true, emailVerified: true } },
      delivery: { select: { status: true, deliveredAt: true, userId: true } },
    } },
  } })
}
export type RecoverySource = NonNullable<Awaited<ReturnType<typeof readRecoverySource>>>

export function sourceBlockReason(source: RecoverySource | null) {
  if (!source || source.status !== 'succeeded' || !source.completedAt || !source.xboardTradeNo) return 'source_incomplete' as const
  const { order } = source
  if (order.user.status !== '正常') return 'user_unavailable' as const
  if (!['delivered', 'closed', 'disputed', 'refunded'].includes(order.status)
    || order.delivery?.status !== 'delivered' || !order.delivery.deliveredAt
    || order.delivery.userId !== order.userId) return 'delivery_untrusted' as const
  return null
}

export async function ownershipProof(source: RecoverySource, db: DB = prisma) {
  if (sourceBlockReason(source)) return null
  const { order } = source
  const email = source.emailSnapshot.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) return null
  // Ownership must have been established by checkout time. A verification
  // acquired after an old address was reused cannot authorize the old account.
  if (order.user.email.toLowerCase() === email && order.user.emailVerified
    && order.user.emailVerified <= order.createdAt) {
    return { kind: 'verified_account_email', verifiedAt: order.user.emailVerified, email }
  }
  const proof = await db.fakaProvisionEmailProof.findUnique({ where: { userId_email: { userId: order.userId, email } },
    select: { verifiedAt: true, proofExpiresAt: true } })
  if (!proof?.verifiedAt || proof.verifiedAt > order.createdAt
    || (proof.proofExpiresAt !== null && proof.proofExpiresAt <= order.createdAt)) return null
  return { kind: 'email_proof', verifiedAt: proof.verifiedAt, email }
}
