import { prisma } from '../../lib/prisma.js'

export const LEGACY_ADMIN_SESSION_REVOKE_REASON = 'mfa_migration'
const DEFAULT_BATCH_SIZE = 500

type RevokeLegacyAdminRefreshSessionsOptions = {
  /** Sessions created before this deployment boundary are legacy sessions. */
  before: Date
  /** Injectable for deterministic tests and release audit timestamps. */
  now?: Date
  /** Bound each database write so a large legacy population is not one transaction. */
  batchSize?: number
}

/**
 * Deployment-only defense in depth: M3's guard/refresh path rejects old
 * admin claims too, while this command makes the database state explicit.
 * The required cutoff prevents a late retry from revoking sessions created by
 * a later deployment.
 */
export async function revokeLegacyAdminRefreshSessions({
  before,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
}: RevokeLegacyAdminRefreshSessionsOptions): Promise<number> {
  if (before.getTime() > now.getTime()) {
    throw new Error('before must not be in the future')
  }

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer')
  }

  let revokedCount = 0

  while (true) {
    const batch = await prisma.refreshToken.findMany({
      where: {
        revoked: false,
        createdAt: { lt: before },
        user: { role: 'admin' },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    })

    if (batch.length === 0) break

    const result = await prisma.refreshToken.updateMany({
      // Keep the full eligibility predicate in the write so a concurrent
      // revocation cannot accidentally change the reported count.
      where: {
        id: { in: batch.map(token => token.id) },
        revoked: false,
        createdAt: { lt: before },
        user: { role: 'admin' },
      },
      data: {
        revoked: true,
        revokedAt: now,
        revokeReason: LEGACY_ADMIN_SESSION_REVOKE_REASON,
      },
    })

    revokedCount += result.count
  }

  return revokedCount
}
